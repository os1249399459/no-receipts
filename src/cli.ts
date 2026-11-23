#!/usr/bin/env node
/**
 * Reference host adapter — a CLI that runs the gate over a JSON file.
 *
 * This exists to prove the core has no host dependencies. Anything that can
 * hand the gate `{ evidence[], claims }` can gate a turn: a CI job, a shell
 * wrapper around another agent, a post-commit hook.
 *
 * Input shape:
 *   {
 *     "turn": 1,
 *     "evidence": [{ "ref": "ev_abc", "ok": true, "toolName": "vitest" }],
 *     "claims": [{ "text": "...", "status": "done", "evidence_ids": ["ev_abc"],
 *                  "verification": {}, "open_questions": [],
 *                  "unverified_assumptions": [] }]
 *   }
 *
 * Exit codes: 0 = complete, 1 = feedback (retryable), 2 = abort.
 */
import { readFileSync } from 'node:fs'
import { CompletionGate, MemoryLedger, emitAbortLine, formatAbortLine } from './index.js'
import type { ClaimDocument, EvidenceRecord } from './types.js'

interface Input {
  turn?: number
  sessionId?: string
  evidence?: Array<Omit<EvidenceRecord, 'ref'> & { ref?: string }>
  claims: unknown
}

async function main(): Promise<number> {
  const path = process.argv[2]
  if (path === 'demo' || path === undefined) {
    return demo()
  }

  let input: Input
  try {
    input = JSON.parse(readFileSync(path, 'utf8')) as Input
  } catch (error) {
    console.error(`no-receipts: cannot read ${path}: ${String(error)}`)
    return 2
  }

  const ledger = new MemoryLedger()
  for (const record of input.evidence ?? []) {
    await ledger.emit({ ...record, ok: record.ok !== false })
  }

  const gate = new CompletionGate({
    ledger,
    maxRetries: Number(process.env['RECEIPTS_MAX_RETRIES'] ?? 1),
    onAbort: (record) => {
      emitAbortLine(record, { ...(process.env['RECEIPTS_LOG'] ? { logPath: process.env['RECEIPTS_LOG'] } : {}) })
    },
  })

  // The documented input shape carries `claims` as a bare array, but the gate
  // validates a `{ claims: [...] }` document. Accept both: without this the
  // documented `npx no-receipts claims.json` can never return 0.
  const rawClaims = input.claims
  const document = Array.isArray(rawClaims) ? { claims: rawClaims } : rawClaims

  const decision = await gate.evaluate({
    output: document,
    turn: input.turn ?? 1,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  })

  if (decision.kind === 'complete') {
    console.log('[no-receipts] complete')
    return 0
  }
  if (decision.kind === 'feedback') {
    console.log(decision.message)
    return 1
  }
  // onAbort already printed the canonical line.
  return 2
}


/**
 * `no-receipts demo` — the whole pitch in one screen, no JSON file needed.
 * Runs the same gate over three claims: a lie, a failed check, and a real one.
 */
async function demo(): Promise<number> {
  const cases: Array<{ label: string; evidence: boolean; cite: string | null; ok: boolean }> = [
    { label: 'agent says "tests pass" and cites nothing', evidence: false, cite: null, ok: false },
    { label: 'agent cites a test run that FAILED', evidence: true, cite: 'ev_failed', ok: false },
    { label: 'agent cites a test run that succeeded', evidence: true, cite: 'ev_ok', ok: true },
  ]

  console.log('no-receipts demo — three agents finish a turn. One of them is lying.\n')

  for (const [index, item] of cases.entries()) {
    const ledger = new MemoryLedger()
    if (item.evidence) {
      await ledger.emit({ ref: item.cite!, ok: item.ok, toolName: 'vitest', detail: { exitCode: item.ok ? 0 : 1 } })
    }
    const gate = new CompletionGate({ ledger, maxRetries: 0 })
    const decision = await gate.evaluate({
      output: {
        claims: [{
          text: 'all tests pass',
          status: 'done',
          evidence_ids: item.cite ? [item.cite] : [],
          verification: {},
          open_questions: [],
          unverified_assumptions: [],
        }],
      },
      turn: 1,
    })
    const verdict = decision.kind === 'complete'
      ? 'ALLOWED'
      : decision.kind === 'abort'
        ? `BLOCKED (${decision.abortDetail.category})`
        : `RETRY (${decision.issues[0]?.code ?? 'invalid'})`
    console.log(`${index + 1}. ${item.label}`)
    console.log(`   → ${verdict}`)
    if (decision.kind === 'abort') console.log(`   ${formatAbortLine(decision.abortDetail)}`)
    console.log('')
  }

  console.log('Exit codes when wired to a host: 0 = complete, 1 = retry with feedback, 2 = abort.')
  return 0
}

void main().then((code) => {
  process.exitCode = code
})

export type { ClaimDocument }
