/**
 * The completion gate.
 *
 * Called by a host right before a turn is allowed to end. Returns one of three
 * decisions — and deliberately has no fourth:
 *
 *   complete → the claims are backed by evidence that resolved and succeeded
 *   feedback → retryable; hand this text back to the model and continue
 *   abort    → stop the turn; record why
 *
 * There is no "pass because we ran out of ideas". When the retry budget is
 * spent, or a divergence limit is hit, the gate aborts. A gate that fails open
 * is decoration.
 */
import type { ClaimIssue } from './types.js'
import { validateClaims } from './validate.js'
import type { EvidenceLedger, ClaimDocument } from './types.js'

export const ABORT_CATEGORIES = [
  'claim_invalid',
  'evidence_missing',
  'evidence_failed',
  'retry_exhausted',
  'step_budget_exceeded',
  'tool_call_budget_exceeded',
  'no_progress_exceeded',
] as const

export type AbortCategory = (typeof ABORT_CATEGORIES)[number]

export interface AbortDetail {
  category: AbortCategory
  detail: string
  claim_text?: string
  evidence_ids?: string[]
  counts?: { actual: number; limit: number }
  issues?: ClaimIssue[]
}

export type GateDecision =
  | { kind: 'complete' }
  | { kind: 'feedback'; message: string; issues: ClaimIssue[]; attempts: number; maxRetries: number }
  | { kind: 'abort'; reason: string; abortDetail: AbortDetail }

export interface SuspensionRecord extends AbortDetail {
  sessionId?: string
  turn: number
  attempts: number
  maxRetries: number
  at: string
}

export interface CompletionGateConfig {
  ledger: EvidenceLedger
  /** Invalid outputs allowed before aborting. Default 1. */
  maxRetries?: number
  /** Model steps per turn before the divergence limit trips. Default 20. */
  maxStepsPerTurn?: number
  /** Tool calls per turn before the divergence limit trips. Default 30. */
  maxToolCallsPerTurn?: number
  /** Consecutive no-progress steps. Default 3. */
  maxConsecutiveNoProgressSteps?: number
  /** Called once per abort, after the decision is built. */
  onAbort?: (record: SuspensionRecord) => void
  /** Override the clock (tests). */
  now?: () => Date
}

export interface CompletionRequest {
  /** Whatever the host extracted from the model's final message. */
  output: unknown
  turn: number
  sessionId?: string
}

export const DEFAULT_MAX_RETRIES = 1
export const DEFAULT_MAX_STEPS = 20
export const DEFAULT_MAX_TOOL_CALLS = 30
export const DEFAULT_MAX_NO_PROGRESS = 3

interface ProgressSnapshot {
  statuses: string[]
  evidenceIds: string[]
}

export class CompletionGate {
  private readonly ledger: EvidenceLedger
  private readonly maxRetries: number
  private readonly maxStepsPerTurn: number
  private readonly maxToolCallsPerTurn: number
  private readonly maxConsecutiveNoProgressSteps: number
  private readonly onAbort?: (record: SuspensionRecord) => void
  private readonly now: () => Date

  private attempts = 0
  private turn = -1
  private stepsThisTurn = 0
  private toolCallsThisTurn = 0
  private consecutiveNoProgress = 0
  private previousProgress: ProgressSnapshot | undefined

  constructor(config: CompletionGateConfig) {
    this.ledger = config.ledger
    this.maxRetries = Math.max(0, config.maxRetries ?? DEFAULT_MAX_RETRIES)
    this.maxStepsPerTurn = Math.max(1, config.maxStepsPerTurn ?? DEFAULT_MAX_STEPS)
    this.maxToolCallsPerTurn = Math.max(0, config.maxToolCallsPerTurn ?? DEFAULT_MAX_TOOL_CALLS)
    this.maxConsecutiveNoProgressSteps = Math.max(1, config.maxConsecutiveNoProgressSteps ?? DEFAULT_MAX_NO_PROGRESS)
    this.onAbort = config.onAbort
    this.now = config.now ?? (() => new Date())
  }

  /** Record tool activity so divergence detection sees it. Call per tool call. */
  noteToolCall(turn: number): void {
    this.syncTurn(turn)
    this.toolCallsThisTurn += 1
  }

  /** Record a model step. Call once per step, before or after the model speaks. */
  noteStep(turn: number, document?: ClaimDocument): void {
    this.syncTurn(turn)
    this.stepsThisTurn += 1
    const current = snapshotOf(document)
    if (this.previousProgress && sameSnapshot(this.previousProgress, current)) {
      this.consecutiveNoProgress += 1
    } else {
      this.consecutiveNoProgress = 0
    }
    this.previousProgress = current
  }

  private syncTurn(turn: number): void {
    if (this.turn === turn) return
    this.turn = turn
    this.stepsThisTurn = 0
    this.toolCallsThisTurn = 0
    this.consecutiveNoProgress = 0
    this.previousProgress = undefined
  }

  /** Evaluate a turn's final claims. Never throws on malformed input. */
  async evaluate(request: CompletionRequest): Promise<GateDecision> {
    this.syncTurn(request.turn)

    const divergence = this.checkDivergence(request)
    if (divergence) return divergence

    const validation = validateClaims(request.output, { ledger: this.ledger })

    if (validation.ok) {
      this.attempts = 0
      return { kind: 'complete' }
    }

    this.attempts += 1

    if (this.attempts > this.maxRetries) {
      const primary = validation.issues[0]
      const detail: AbortDetail = {
        category: primary ? categoryFor(primary.code) : 'claim_invalid',
        detail: `retries exhausted (${this.attempts}/${this.maxRetries})`,
        counts: { actual: this.attempts, limit: this.maxRetries },
        issues: validation.issues,
        ...offendingClaim(request.output, primary?.path),
      }
      return this.abort(detail, request)
    }

    return {
      kind: 'feedback',
      message: renderFeedback(validation.issues, this.attempts, this.maxRetries),
      issues: validation.issues,
      attempts: this.attempts,
      maxRetries: this.maxRetries,
    }
  }

  private checkDivergence(request: CompletionRequest): GateDecision | undefined {
    const limits: Array<{ category: AbortCategory; count: number; limit: number; inclusive: boolean; label: string }> = [
      { category: 'step_budget_exceeded', count: this.stepsThisTurn, limit: this.maxStepsPerTurn, inclusive: false, label: 'steps' },
      { category: 'tool_call_budget_exceeded', count: this.toolCallsThisTurn, limit: this.maxToolCallsPerTurn, inclusive: false, label: 'tool calls' },
      // No-progress is a streak: reaching the limit already means divergence.
      { category: 'no_progress_exceeded', count: this.consecutiveNoProgress, limit: this.maxConsecutiveNoProgressSteps, inclusive: true, label: 'consecutive no-progress steps' },
    ]

    const hit = limits.find((entry) => (entry.inclusive ? entry.count >= entry.limit : entry.count > entry.limit))
    if (!hit) return undefined

    return this.abort(
      {
        category: hit.category,
        detail: `${hit.label} ${hit.count}/${hit.limit}`,
        counts: { actual: hit.count, limit: hit.limit },
      },
      request,
    )
  }

  private abort(detail: AbortDetail, request: CompletionRequest): GateDecision {
    const reason = `${detail.detail} [category=${detail.category}]`
    this.onAbort?.({
      ...detail,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      turn: request.turn,
      attempts: this.attempts,
      maxRetries: this.maxRetries,
      at: this.now().toISOString(),
    })
    return { kind: 'abort', reason, abortDetail: detail }
  }

  /** Diagnostics only — no setter, gate policy is immutable after construction. */
  get attemptCount(): number {
    return this.attempts
  }
}

function snapshotOf(document?: ClaimDocument): ProgressSnapshot {
  const claims = document?.claims ?? []
  return {
    statuses: claims.map((claim) => claim.status),
    evidenceIds: [...new Set(claims.flatMap((claim) => claim.evidence_ids))].sort(),
  }
}

function sameSnapshot(a: ProgressSnapshot, b: ProgressSnapshot): boolean {
  return (
    a.statuses.length === b.statuses.length &&
    a.statuses.every((value, index) => value === b.statuses[index]) &&
    a.evidenceIds.length === b.evidenceIds.length &&
    a.evidenceIds.every((value, index) => value === b.evidenceIds[index])
  )
}

function categoryFor(code: string): AbortCategory {
  if (code === 'evidence_missing') return 'evidence_missing'
  if (code === 'evidence_failed') return 'evidence_failed'
  return 'claim_invalid'
}

function offendingClaim(output: unknown, path?: readonly (string | number)[]): Partial<AbortDetail> {
  const claims = (output as { claims?: Array<{ text?: unknown; evidence_ids?: unknown }> } | undefined)?.claims
  if (!Array.isArray(claims) || claims.length === 0) return {}
  const index = typeof path?.[1] === 'number' ? path[1] : 0
  const claim = claims[index] ?? claims[0]
  if (!claim) return {}
  return {
    ...(typeof claim.text === 'string' ? { claim_text: claim.text } : {}),
    ...(Array.isArray(claim.evidence_ids)
      ? { evidence_ids: claim.evidence_ids.filter((id): id is string => typeof id === 'string') }
      : {}),
  }
}

/** The exact text handed back to the model on a retry. */
export function renderFeedback(issues: readonly ClaimIssue[], attempts: number, maxRetries: number): string {
  const lines = [
    `Your claims were rejected (attempt ${attempts}/${maxRetries}). Fix every issue below before ending the turn.`,
    '',
    ...issues.map((issue, index) => `${index + 1}. [${issue.code}] at ${issue.path.join('.')}: ${issue.message}`),
    '',
    'Allowed statuses: done | partial | blocked | unknown.',
    'A "done" claim needs at least one evidence_id from a tool call that actually succeeded.',
    'An "unknown" or "blocked" claim must be disclosed in open_questions or unverified_assumptions.',
  ]
  return lines.join('\n')
}
