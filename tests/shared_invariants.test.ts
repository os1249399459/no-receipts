/**
 * SHARED INVARIANTS — the three rules that must hold identically in
 * `no-receipts` and its sibling implementation `false-completion-bundle`.
 *
 * The two repos are deliberately NOT merged and do NOT share a package: the
 * implementations differ, the *contracts* must not. This file is the sync
 * artifact; the bundle's copy lives at
 * `false-completion-bundle/tests/shared_invariants.test.ts` and is the origin of
 * this file. When one copy changes, the other must be re-verified.
 *
 *   I1. Fail-closed evidence handling. If evidence cannot be verified or
 *       exported, the turn never completes. It aborts (or raises) instead.
 *   I2. Three-state decisions. `complete` / `feedback` / `abort` are distinct
 *       and exhaustive.
 *   I3. Stable, ASCII-only abort line. One grep-able line with a fixed shape,
 *       and gate-authored prose is raw English — no CJK, ever.
 *
 * ---------------------------------------------------------------------------
 * Harness differences from the bundle copy (intentional, do not "fix"):
 *   - log prefix `[no-receipts]` instead of `[false-completion-gate]`;
 *   - there is NO `verifier=` field in this line, and NO `verifier_failed`
 *     category, so the line regex omits both;
 *   - there is NO `exporter_failed` category at all: this package's ledger is
 *     in-memory or append-only-file, with no network export step, so the
 *     "export failed" failure mode does not exist here. I1 is therefore
 *     expressed as the property that actually holds in both implementations —
 *     unverifiable evidence never yields `complete` — rather than by inventing
 *     a category this repo does not have.
 * ---------------------------------------------------------------------------
 *
 * Hermetic: in-memory ledgers only. No network, no spawned processes, no files
 * outside a temp dir.
 */
import { describe, expect, it } from 'vitest'
import {
  ABORT_CATEGORIES,
  CompletionGate,
  MemoryLedger,
  formatAbortLine,
  type AbortDetail,
} from '../src/index.js'
import type { EvidenceLedger } from '../src/types.js'

/** A claim document with a caller-supplied status and evidence. */
function document(status: string, evidenceIds: string[] = []) {
  return {
    claims: [{
      text: 'task finished',
      status,
      evidence_ids: evidenceIds,
      verification: {},
      open_questions: ['q'],
      unverified_assumptions: [],
    }],
  }
}

function gateWith(ledger: EvidenceLedger, config: Record<string, unknown> = {}) {
  return new CompletionGate({ ledger, maxRetries: 1, ...config } as never)
}

/** A ledger whose every read throws — simulates an unreadable evidence store. */
const throwingLedger: EvidenceLedger = {
  emit: async () => { throw new Error('store unavailable') },
  get: () => { throw new Error('store unavailable') },
}

/** Any character outside printable ASCII (excluding tab) makes the line unstable. */
const NON_ASCII = /[^\x09\x0A\x0D\x20-\x7E]/

/**
 * The one allowed abort-line shape for THIS package (no verifier field):
 *   [no-receipts] abort category=<cat> claim=<q|-> evidence=<q|-> \
 *     counts=<a/b|-> detail=<q>
 */
const LINE_SHAPE = new RegExp(
  '^\\[no-receipts\\] abort category=(' + ABORT_CATEGORIES.join('|') + ')' +
  ' claim=(?:-|"(?:[^"\\\\]|\\\\.)*")' +
  ' evidence=(?:-|"(?:[^"\\\\]|\\\\.)*"(?:,"(?:[^"\\\\]|\\\\.)*")*)' +
  ' counts=(?:-|\\d+\\/\\d+)' +
  ' detail="(?:[^"\\\\]|\\\\.)*"$',
)

describe('I1: unverifiable evidence never completes (fail-closed)', () => {
  it('evidence recorded as failed aborts instead of completing', async () => {
    const ledger = new MemoryLedger()
    await ledger.emit({ ref: 'ev_bad', ok: false, toolName: 'vitest' })

    const decision = await gateWith(ledger, { maxRetries: 0 }).evaluate({
      output: document('done', ['ev_bad']),
      turn: 1,
    })

    expect(decision.kind).not.toBe('complete')
    expect(decision.kind).toBe('abort')
    if (decision.kind === 'abort') {
      expect(decision.abortDetail.category).toBe('evidence_failed')
      expect(decision.reason).toContain('category=evidence_failed')
    }
  })

  it('evidence citing an unknown ref aborts instead of completing', async () => {
    const decision = await gateWith(new MemoryLedger(), { maxRetries: 0 }).evaluate({
      output: document('done', ['ev_never_recorded']),
      turn: 1,
    })

    expect(decision.kind).not.toBe('complete')
    expect(decision.kind).toBe('abort')
    if (decision.kind === 'abort') {
      expect(decision.abortDetail.category).toBe('evidence_missing')
    }
  })

  it('an unreadable evidence store never yields complete (it throws or aborts)', async () => {
    // The invariant is about never certifying a completion whose evidence was
    // not actually checked. This package propagates the store error rather than
    // inventing an abort category; both are acceptable, completion is not.
    await expect((async () => {
      const decision = await gateWith(throwingLedger, { maxRetries: 0 }).evaluate({
        output: document('done', ['ev_any']),
        turn: 1,
      })
      expect(decision.kind).not.toBe('complete')
    })()).rejects.toThrow(/store unavailable/)
  })

  it('verifiable evidence DOES complete (control for the cases above)', async () => {
    const ledger = new MemoryLedger()
    await ledger.emit({ ref: 'ev_ok', ok: true, toolName: 'vitest' })

    const decision = await gateWith(ledger).evaluate({
      output: document('done', ['ev_ok']),
      turn: 1,
    })
    expect(decision.kind).toBe('complete')
  })
})

describe('I2: three-state decisions are distinct and exhaustive', () => {
  it('complete: valid claim citing resolvable evidence', async () => {
    const ledger = new MemoryLedger()
    await ledger.emit({ ref: 'ev_ok', ok: true, toolName: 'vitest' })
    const decision = await gateWith(ledger).evaluate({ output: document('done', ['ev_ok']), turn: 1 })
    expect(decision.kind).toBe('complete')
  })

  it('feedback: an invalid claim within the retry budget asks for a fix', async () => {
    const decision = await gateWith(new MemoryLedger(), { maxRetries: 1 })
      .evaluate({ output: document('done', []), turn: 1 })

    expect(decision.kind).toBe('feedback')
    if (decision.kind === 'feedback') {
      expect(decision.message.length).toBeGreaterThan(0)
      // Feedback is a retry signal; it must not masquerade as an abort line.
      expect(decision.message).not.toContain('[no-receipts] abort')
    }
  })

  it('abort: retry budget exhausted suspends and aborts', async () => {
    const decision = await gateWith(new MemoryLedger(), { maxRetries: 0 })
      .evaluate({ output: document('done', []), turn: 1 })

    expect(decision.kind).toBe('abort')
    if (decision.kind === 'abort') {
      expect(decision.reason).toContain('retries exhausted')
      expect(decision.abortDetail.category).toBe('claim_invalid')
    }
  })

  it('the three states are mutually exclusive on identical input', async () => {
    const ok = new MemoryLedger()
    await ok.emit({ ref: 'ev_ok', ok: true, toolName: 'vitest' })

    const complete = await gateWith(ok).evaluate({ output: document('done', ['ev_ok']), turn: 1 })
    const feedback = await gateWith(new MemoryLedger(), { maxRetries: 1 })
      .evaluate({ output: document('done', []), turn: 1 })
    const abort = await gateWith(new MemoryLedger(), { maxRetries: 0 })
      .evaluate({ output: document('done', []), turn: 1 })

    expect([complete.kind, feedback.kind, abort.kind]).toEqual(['complete', 'feedback', 'abort'])
    expect(new Set([complete.kind, feedback.kind, abort.kind]).size).toBe(3)
  })
})

describe('I3: abort line shape is stable and ASCII-only', () => {
  /** Representative aborts, one per category, using only gate-authored prose. */
  function sampleDetails(): AbortDetail[] {
    return ABORT_CATEGORIES.map((category) => ({
      category,
      claim_text: 'task finished',
      evidence_ids: ['ev_abc123'],
      counts: { actual: 2, limit: 1 },
      detail: `retries exhausted (2/1) [${category}]`,
    }))
  }

  it('every category formats to the one documented line shape', () => {
    for (const detail of sampleDetails()) {
      const line = formatAbortLine(detail)
      expect(line, `category ${detail.category} broke the line shape`).toMatch(LINE_SHAPE)
      expect(line.startsWith('[no-receipts] abort category=')).toBe(true)
    }
  })

  it('the line contains NO non-ASCII characters (raw English only)', () => {
    for (const detail of sampleDetails()) {
      const line = formatAbortLine(detail)
      const offending = line.match(NON_ASCII)
      expect(offending, `non-ASCII ${JSON.stringify(offending?.[0])} found in: ${line}`).toBeNull()
    }
  })

  it('gate-authored prose is ASCII-only for every abort it can produce', async () => {
    // Drive real aborts through the gate so the gate's own wording is covered,
    // not just hand-built strings.
    const cases: Array<{ ledger: EvidenceLedger; output: unknown; expect: string }> = [
      { ledger: new MemoryLedger(), output: document('done', []), expect: 'claim_invalid' },
      { ledger: new MemoryLedger(), output: document('done', ['ev_x']), expect: 'evidence_missing' },
    ]

    for (const testCase of cases) {
      const decision = await gateWith(testCase.ledger, { maxRetries: 0 })
        .evaluate({ output: testCase.output, turn: 1 })
      expect(decision.kind).toBe('abort')
      if (decision.kind === 'abort') {
        expect(decision.abortDetail.category).toBe(testCase.expect)
        const line = formatAbortLine(decision.abortDetail)
        expect(line).toMatch(LINE_SHAPE)
        expect(line).not.toMatch(NON_ASCII)
        // The legacy string twin carries the same guarantee.
        expect(decision.reason).not.toMatch(NON_ASCII)
      }
    }
  })

  it('a non-ASCII character in `detail` is detected (the sanitizer baseline)', () => {
    // The tripwire: if this package's prose is ever translated (e.g. 无证据),
    // the assertions above fail. Kept explicit so the mechanism is provable.
    const polluted: AbortDetail = {
      category: 'claim_invalid',
      detail: 'retries exhausted (无证据)',
    }
    const line = formatAbortLine(polluted)
    expect(line).toMatch(NON_ASCII)
    expect(line.match(NON_ASCII)?.[0]).toBe('无')
  })
})
