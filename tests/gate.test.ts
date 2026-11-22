import { describe, expect, it } from 'vitest'
import { CompletionGate, MemoryLedger, renderFeedback } from '../src/index.js'
import type { EvidenceRecord } from '../src/types.js'

function claim(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    text: 'implemented the feature',
    status: 'done',
    evidence_ids: [],
    verification: {},
    open_questions: [],
    unverified_assumptions: [],
    ...overrides,
  }
}

async function ledgerWith(records: Array<Partial<EvidenceRecord> & { ref: string; ok: boolean }>) {
  const ledger = new MemoryLedger()
  for (const record of records) await ledger.emit({ ...record })
  return ledger
}

describe('claim validation through the gate', () => {
  it('completes when a done claim cites evidence that succeeded', async () => {
    const ledger = await ledgerWith([{ ref: 'ev_ok', ok: true, toolName: 'vitest' }])
    const gate = new CompletionGate({ ledger })
    const decision = await gate.evaluate({
      output: { claims: [claim({ evidence_ids: ['ev_ok'] })] },
      turn: 1,
    })
    expect(decision.kind).toBe('complete')
  })

  it('rejects done with no evidence, then aborts when retries run out', async () => {
    const gate = new CompletionGate({ ledger: new MemoryLedger(), maxRetries: 1 })
    const first = await gate.evaluate({ output: { claims: [claim()] }, turn: 1 })
    expect(first.kind).toBe('feedback')
    if (first.kind !== 'feedback') throw new Error('unreachable')
    expect(first.issues[0]?.code).toBe('claim_invalid')

    const second = await gate.evaluate({ output: { claims: [claim()] }, turn: 1 })
    expect(second.kind).toBe('abort')
    if (second.kind !== 'abort') throw new Error('unreachable')
    expect(second.abortDetail.category).toBe('claim_invalid')
    expect(second.abortDetail.counts).toEqual({ actual: 2, limit: 1 })
  })

  it('rejects evidence ids that never existed', async () => {
    const gate = new CompletionGate({ ledger: new MemoryLedger() })
    const decision = await gate.evaluate({
      output: { claims: [claim({ evidence_ids: ['ev_ghost'] })] },
      turn: 1,
    })
    expect(decision.kind).toBe('feedback')
    if (decision.kind !== 'feedback') throw new Error('unreachable')
    expect(decision.issues[0]?.code).toBe('evidence_missing')
  })

  it('rejects evidence ids whose tool call failed', async () => {
    const ledger = await ledgerWith([{ ref: 'ev_bad', ok: false, toolName: 'vitest' }])
    const gate = new CompletionGate({ ledger })
    const decision = await gate.evaluate({
      output: { claims: [claim({ evidence_ids: ['ev_bad'] })] },
      turn: 1,
    })
    expect(decision.kind).toBe('feedback')
    if (decision.kind !== 'feedback') throw new Error('unreachable')
    expect(decision.issues[0]?.code).toBe('evidence_failed')
  })

  it('rejects an undisclosed unknown, and accepts a disclosed one', async () => {
    const gate = new CompletionGate({ ledger: new MemoryLedger() })
    const hidden = await gate.evaluate({
      output: { claims: [claim({ status: 'unknown', evidence_ids: [] })] },
      turn: 1,
    })
    expect(hidden.kind).toBe('feedback')

    const disclosed = await gate.evaluate({
      output: {
        claims: [claim({ status: 'unknown', evidence_ids: [], open_questions: ['is the API rate limited?'] })],
      },
      turn: 1,
    })
    expect(disclosed.kind).toBe('complete')
  })

  it('resets the retry budget after a valid turn', async () => {
    const ledger = await ledgerWith([{ ref: 'ev_ok', ok: true }])
    const gate = new CompletionGate({ ledger, maxRetries: 1 })
    await gate.evaluate({ output: { claims: [claim()] }, turn: 1 })
    const recovered = await gate.evaluate({
      output: { claims: [claim({ evidence_ids: ['ev_ok'] })] },
      turn: 2,
    })
    expect(recovered.kind).toBe('complete')
    expect(gate.attemptCount).toBe(0)
  })
})

describe('malformed input', () => {
  const bad: unknown[] = [null, 42, 'claims', {}, { claims: 'nope' }, { claims: [{}] }, { claims: [null] }]

  for (const [index, output] of bad.entries()) {
    it(`does not throw and does not complete on malformed input #${index}`, async () => {
      const gate = new CompletionGate({ ledger: new MemoryLedger(), maxRetries: 0 })
      const decision = await gate.evaluate({ output, turn: 1 })
      expect(decision.kind).toBe('abort')
    })
  }
})

describe('divergence limits', () => {
  it('aborts when steps exceed the budget', async () => {
    const gate = new CompletionGate({ ledger: new MemoryLedger(), maxStepsPerTurn: 2, maxRetries: 99 })
    gate.noteStep(1)
    gate.noteStep(1)
    const atLimit = await gate.evaluate({ output: { claims: [claim()] }, turn: 1 })
    expect(atLimit.kind).toBe('feedback')

    gate.noteStep(1)
    const overLimit = await gate.evaluate({ output: { claims: [claim()] }, turn: 1 })
    expect(overLimit.kind).toBe('abort')
    if (overLimit.kind !== 'abort') throw new Error('unreachable')
    expect(overLimit.abortDetail.category).toBe('step_budget_exceeded')
  })

  it('aborts when tool calls exceed the budget', async () => {
    const gate = new CompletionGate({ ledger: new MemoryLedger(), maxToolCallsPerTurn: 1, maxRetries: 99 })
    gate.noteToolCall(1)
    gate.noteToolCall(1)
    const decision = await gate.evaluate({ output: { claims: [claim()] }, turn: 1 })
    expect(decision.kind).toBe('abort')
    if (decision.kind !== 'abort') throw new Error('unreachable')
    expect(decision.abortDetail.category).toBe('tool_call_budget_exceeded')
  })

  it('aborts on a no-progress streak, and resets when progress resumes', async () => {
    const gate = new CompletionGate({
      ledger: new MemoryLedger(),
      maxConsecutiveNoProgressSteps: 2,
      maxRetries: 99,
    })
    const stuck = { claims: [claim({ evidence_ids: ['ev_a'] })] }
    // The first note establishes the baseline and does not count as a repeat;
    // a limit of 2 therefore needs baseline + 2 identical steps.
    gate.noteStep(1, stuck as never)
    gate.noteStep(1, stuck as never)
    gate.noteStep(1, stuck as never)
    const aborted = await gate.evaluate({ output: stuck, turn: 1 })
    expect(aborted.kind).toBe('abort')

    const fresh = new CompletionGate({
      ledger: new MemoryLedger(),
      maxConsecutiveNoProgressSteps: 2,
      maxRetries: 99,
    })
    fresh.noteStep(1, stuck as never)
    fresh.noteStep(1, { claims: [claim({ evidence_ids: ['ev_b', 'ev_a'] })] } as never)
    fresh.noteStep(1, { claims: [claim({ evidence_ids: ['ev_c'] })] } as never)
    const alive = await fresh.evaluate({ output: stuck, turn: 1 })
    expect(alive.kind).not.toBe('abort')
  })

  it('counters reset between turns', async () => {
    const gate = new CompletionGate({ ledger: new MemoryLedger(), maxStepsPerTurn: 1, maxRetries: 99 })
    gate.noteStep(1)
    gate.noteStep(1)
    gate.noteStep(2)
    const decision = await gate.evaluate({ output: { claims: [claim()] }, turn: 2 })
    expect(decision.kind).toBe('feedback')
  })
})

describe('abort reporting', () => {
  it('reports one abort per abort decision, with a stable category', async () => {
    const records: Array<{ category: string }> = []
    const gate = new CompletionGate({
      ledger: new MemoryLedger(),
      maxRetries: 0,
      onAbort: (record) => records.push({ category: record.category }),
    })
    await gate.evaluate({ output: { claims: [claim()] }, turn: 1 })
    expect(records).toEqual([{ category: 'claim_invalid' }])
  })

  it('renders feedback that names every issue and the allowed statuses', async () => {
    const gate = new CompletionGate({ ledger: new MemoryLedger(), maxRetries: 1 })
    const decision = await gate.evaluate({
      output: { claims: [claim({ evidence_ids: ['ev_x'] })] },
      turn: 1,
    })
    if (decision.kind !== 'feedback') throw new Error('expected feedback')
    expect(decision.message).toContain('evidence_missing')
    expect(decision.message).toContain('ev_x')
    expect(decision.message).toContain('done | partial | blocked | unknown')
  })
})

describe('renderFeedback', () => {
  it('is stable for a fixed issue list', () => {
    const text = renderFeedback(
      [{ code: 'claim_invalid', path: ['claims', 0, 'evidence_ids'], message: 'need evidence' }],
      1,
      1,
    )
    expect(text).toMatchSnapshot()
  })
})
