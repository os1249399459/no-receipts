/**
 * Claim validation — shape plus evidence coherence.
 *
 * Rules (each corresponds to a real failure mode seen in practice):
 *   1. `status: "done"` with no `evidence_ids`      → claim_invalid
 *   2. an `evidence_ids` entry that never existed   → evidence_missing
 *   3. an `evidence_ids` entry whose call failed    → evidence_failed
 *   4. `unknown`/`blocked` without disclosure       → claim_invalid
 *
 * No throwing: every failure comes back as structured `ClaimIssue[]`, so the
 * same list can be rendered for a human and fed back to a model verbatim.
 */
import type {
  Claim,
  ClaimIssue,
  ClaimStatus,
  ClaimValidationResult,
  EvidenceLedger,
} from './types.js'

const STATUSES: readonly ClaimStatus[] = ['done', 'partial', 'blocked', 'unknown']

export interface ValidateOptions {
  ledger: EvidenceLedger
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Structural check with precise paths, so callers can point at the bad field. */
export function validateShape(input: unknown): ClaimValidationResult {
  if (!isObject(input) || !Array.isArray(input['claims'])) {
    return {
      ok: false,
      issues: [{ code: 'invalid_shape', path: ['claims'], message: 'Expected an object with a `claims` array' }],
    }
  }

  const issues: ClaimIssue[] = []
  const claims: Claim[] = []

  input['claims'].forEach((raw: unknown, index: number) => {
    const at = (key: string) => ['claims', index, key]
    if (!isObject(raw)) {
      issues.push({ code: 'invalid_shape', path: ['claims', index], message: 'Claim must be an object' })
      return
    }
    if (typeof raw['text'] !== 'string' || raw['text'].length === 0) {
      issues.push({ code: 'invalid_shape', path: at('text'), message: 'Claim text must be a non-empty string' })
    }
    if (typeof raw['status'] !== 'string' || !STATUSES.includes(raw['status'] as ClaimStatus)) {
      issues.push({
        code: 'invalid_shape',
        path: at('status'),
        message: `status must be one of ${STATUSES.join(' | ')}`,
      })
    }
    if (!Array.isArray(raw['evidence_ids']) || raw['evidence_ids'].some((id) => typeof id !== 'string')) {
      issues.push({ code: 'invalid_shape', path: at('evidence_ids'), message: 'evidence_ids must be a string array' })
    }
    if (!isObject(raw['verification'])) {
      issues.push({ code: 'invalid_shape', path: at('verification'), message: 'verification must be an object' })
    }
    for (const listField of ['open_questions', 'unverified_assumptions'] as const) {
      const list = raw[listField]
      if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
        issues.push({ code: 'invalid_shape', path: at(listField), message: `${listField} must be a string array` })
      }
    }
    if (issues.some((issue) => issue.path[1] === index)) return

    claims.push({
      text: raw['text'] as string,
      status: raw['status'] as ClaimStatus,
      evidence_ids: raw['evidence_ids'] as string[],
      verification: raw['verification'] as Record<string, unknown>,
      open_questions: raw['open_questions'] as string[],
      unverified_assumptions: raw['unverified_assumptions'] as string[],
    })
  })

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, data: { claims } }
}

/**
 * Full validation: shape, then the four evidence rules.
 *
 * Rule 4 exists because "I don't know" is a legitimate answer — but only when
 * the user is told. An undisclosed `unknown` is the quietest form of a fake
 * completion, and the hardest to catch by reading the transcript.
 */
export function validateClaims(input: unknown, options: ValidateOptions): ClaimValidationResult {
  const shaped = validateShape(input)
  if (!shaped.ok) return shaped

  const issues: ClaimIssue[] = []

  shaped.data.claims.forEach((claim, index) => {
    if (claim.status === 'done' && claim.evidence_ids.length === 0) {
      issues.push({
        code: 'claim_invalid',
        path: ['claims', index, 'evidence_ids'],
        message: 'A claim with status "done" must cite at least one evidence_id',
      })
    }

    claim.evidence_ids.forEach((ref, evidenceIndex) => {
      const entry = options.ledger.get(ref)
      if (entry === undefined) {
        issues.push({
          code: 'evidence_missing',
          path: ['claims', index, 'evidence_ids', evidenceIndex],
          message: `Evidence id "${ref}" does not resolve to a ledger entry`,
        })
        return
      }
      if (!entry.ok) {
        issues.push({
          code: 'evidence_failed',
          path: ['claims', index, 'evidence_ids', evidenceIndex],
          message: `Evidence id "${ref}" refers to a failed tool call and cannot support a claim`,
        })
      }
    })

    if (claim.status === 'unknown' || claim.status === 'blocked') {
      const disclosed = claim.open_questions.length > 0 || claim.unverified_assumptions.length > 0
      if (!disclosed) {
        issues.push({
          code: 'claim_invalid',
          path: ['claims', index, 'status'],
          message: `Claim ${index} is "${claim.status}" but was not disclosed in open_questions or unverified_assumptions`,
        })
      }
    }
  })

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, data: shaped.data }
}
