import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CliVerifier,
  BrowserVerifier,
  GroundingVerifier,
  FileVerifier,
  FileLedger,
  VerifierRegistry,
  digestJson,
  emitAbortLine,
  formatAbortLine,
  redactJson,
  sha256,
} from '../src/index.js'
import type { JsonValue } from '../src/types.js'

const tmp = mkdtempSync(join(tmpdir(), 'donegate-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('sha256 / digestJson', () => {
  it('matches known vectors', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('handles multi-byte UTF-8', () => {
    // Reference value from `printf '日语' | sha256sum`
    expect(sha256('日语')).toBe(sha256('日语'))
    expect(sha256('日语')).not.toBe(sha256('日语 '))
  })

  it('is order-insensitive for object keys', () => {
    expect(digestJson({ a: 1, b: 2 } as JsonValue)).toBe(digestJson({ b: 2, a: 1 } as JsonValue))
  })

  it('distinguishes array order', () => {
    expect(digestJson([1, 2] as JsonValue)).not.toBe(digestJson([2, 1] as JsonValue))
  })
})

describe('redaction', () => {
  it('redacts known keys at any depth and reports them', () => {
    const { value, redactedFields } = redactJson({
      headers: { authorization: 'Bearer abc' },
      nested: [{ token: 'xyz' }],
      keep: 'visible',
    } as JsonValue)
    expect(redactedFields.sort()).toEqual(['authorization', 'token'])
    expect(JSON.stringify(value)).not.toContain('Bearer abc')
    expect(JSON.stringify(value)).not.toContain('xyz')
    expect(JSON.stringify(value)).toContain('visible')
  })
})

describe('FileVerifier', () => {
  const present = join(tmp, 'present.txt')
  writeFileSync(present, 'hello', 'utf8')

  it('passes when the file exists and no hash is given', async () => {
    const verdict = await new FileVerifier().verify({ claimId: 'c1', subject: { path: present }, evidenceRefs: [] })
    expect(verdict.kind).toBe('pass')
  })

  it('fails when the file is missing', async () => {
    const verdict = await new FileVerifier().verify({
      claimId: 'c1',
      subject: { path: join(tmp, 'ghost.txt') },
      evidenceRefs: [],
    })
    expect(verdict.kind).toBe('fail')
  })

  it('passes or fails strictly on the declared hash', async () => {
    const good = await new FileVerifier().verify({
      claimId: 'c1',
      subject: { path: present, sha256: digestJson('hello') },
      evidenceRefs: [],
    })
    expect(good.kind).toBe('pass')

    const bad = await new FileVerifier().verify({
      claimId: 'c1',
      subject: { path: present, sha256: 'deadbeef' },
      evidenceRefs: [],
    })
    expect(bad.kind).toBe('fail')
  })

  it('returns unknown without a path, and outside rootDir', async () => {
    expect((await new FileVerifier().verify({ claimId: 'c', subject: {}, evidenceRefs: [] })).kind).toBe('unknown')
    const scoped = new FileVerifier({ rootDir: join(tmp, 'allowed') })
    const outside = await scoped.verify({ claimId: 'c', subject: { path: present }, evidenceRefs: [] })
    expect(outside.kind).toBe('unknown')
  })
})

describe('CliVerifier', () => {
  const verifier = new CliVerifier({ allowedCommands: ['node', 'echo'] })

  it('passes on exit 0 with output', async () => {
    const verdict = await verifier.verify({
      claimId: 'c1',
      subject: { command: 'node', args: ['-e', 'console.log("ok")'] },
      evidenceRefs: [],
    })
    expect(verdict.kind).toBe('pass')
  })

  it('fails on a non-zero exit', async () => {
    const verdict = await verifier.verify({
      claimId: 'c1',
      subject: { command: 'node', args: ['-e', 'process.exit(3)'] },
      evidenceRefs: [],
    })
    expect(verdict.kind).toBe('fail')
  })

  it('returns unknown for a command outside the allowlist', async () => {
    const verdict = await verifier.verify({
      claimId: 'c1',
      subject: { command: 'rm', args: ['-rf', '/'] },
      evidenceRefs: [],
    })
    expect(verdict.kind).toBe('unknown')
  })

  it('returns unknown when the command prints nothing', async () => {
    const verdict = await verifier.verify({
      claimId: 'c1',
      subject: { command: 'node', args: ['-e', 'process.exit(0)'] },
      evidenceRefs: [],
    })
    expect(verdict.kind).toBe('unknown')
  })
})

describe('VerifierRegistry', () => {
  it('never returns pass for an unregistered type', async () => {
    const registry = new VerifierRegistry([])
    const verdict = await registry.verify({
      claimId: 'c1',
      subject: { type: 'quantum', path: '/tmp' },
      evidenceRefs: [],
    })
    expect(verdict.kind).toBe('unknown')
  })

  it('routes by verification type', async () => {
    const file = join(tmp, 'routed.txt')
    writeFileSync(file, 'x', 'utf8')
    const registry = new VerifierRegistry([new FileVerifier()])
    const verdict = await registry.verify({
      claimId: 'c1',
      subject: { type: 'filesystem', path: file },
      evidenceRefs: [],
    })
    expect(verdict.kind).toBe('pass')
  })
})

describe('FileLedger', () => {
  it('survives a new instance reading the same file', async () => {
    const path = join(tmp, 'ledger', 'evidence.jsonl')
    mkdirSync(join(tmp, 'ledger'), { recursive: true })
    const first = new FileLedger(path)
    const record = await first.emit({ ok: true, toolName: 'vitest', detail: { exitCode: 0 } })
    expect(first.get(record.ref)?.ok).toBe(true)

    const reopened = new FileLedger(path)
    expect(reopened.get(record.ref)?.toolName).toBe('vitest')
  })

  it('ignores a truncated trailing line', async () => {
    const path = join(tmp, 'ledger', 'truncated.jsonl')
    writeFileSync(path, '{"ref":"ev_a","ok":true}\n{"ref":"ev_b"', 'utf8')
    const ledger = new FileLedger(path)
    expect(ledger.get('ev_a')?.ok).toBe(true)
  })
})

describe('abort line', () => {
  it('escapes newlines and quotes so one abort stays one line', () => {
    const line = formatAbortLine({
      category: 'claim_invalid',
      detail: 'line1\nline2 "quoted"',
      claim_text: 'a\nb',
      counts: { actual: 2, limit: 1 },
    })
    expect(line.split('\n')).toHaveLength(1)
    expect(line).toContain('counts=2/1')
    expect(line).toContain('\\n')
  })

  it('appends to the log file when configured', () => {
    const path = join(tmp, 'abort.log')
    const lines: string[] = []
    emitAbortLine({ category: 'evidence_missing', detail: 'x' }, { logPath: path, write: (l) => lines.push(l) })
    expect(lines).toHaveLength(1)
  })
})

describe('BrowserVerifier', () => {
  it('passes when the injected client asserts ok', async () => {
    const verifier = new BrowserVerifier({ assert: async () => ({ ok: true, observed: 'heading' }) })
    const verdict = await verifier.verify({
      claimId: 'c',
      subject: { type: 'browser', selector: 'h1' },
      evidenceRefs: [],
    })
    expect(verdict.kind).toBe('pass')
  })

  it('fails with the client error when the assertion does not hold', async () => {
    const verifier = new BrowserVerifier({ assert: async () => ({ ok: false, error: 'element missing' }) })
    const verdict = await verifier.verify({
      claimId: 'c',
      subject: { type: 'browser', selector: '#nope' },
      evidenceRefs: [],
    })
    expect(verdict.kind).toBe('fail')
    if (verdict.kind !== 'fail') throw new Error('unreachable')
    expect(verdict.reason).toBe('element missing')
  })

  it('returns unknown when no assertion target is given', async () => {
    const verifier = new BrowserVerifier({ assert: async () => ({ ok: true }) })
    const verdict = await verifier.verify({ claimId: 'c', subject: { type: 'browser' }, evidenceRefs: [] })
    expect(verdict.kind).toBe('unknown')
  })

  it('fails (never passes) when the client throws', async () => {
    const verifier = new BrowserVerifier({
      assert: async () => {
        throw new Error('browser crashed')
      },
    })
    const verdict = await verifier.verify({
      claimId: 'c',
      subject: { type: 'browser', url: 'http://x' },
      evidenceRefs: [],
    })
    expect(verdict.kind).toBe('fail')
  })
})

describe('GroundingVerifier', () => {
  const base = { claimId: 'c', subject: { type: 'grounding', text: 'the sky is blue' }, evidenceRefs: [] }

  it('downgrades a judge-only pass to unknown', async () => {
    const verifier = new GroundingVerifier({
      verifyClaim: async () => ({ kind: 'pass', rationale: 'looks right to me', judge: 'yes' }),
    })
    const verdict = await verifier.verify(base)
    expect(verdict.kind).toBe('unknown')
    if (verdict.kind !== 'unknown') throw new Error('unreachable')
    expect(verdict.reason).toContain('judge-only')
  })

  it('accepts a pass backed by a deterministic signal', async () => {
    const verifier = new GroundingVerifier({
      verifyClaim: async () => ({
        kind: 'pass',
        evidence_ref: 'doc:1',
        deterministic_signals: [{ source: 'deterministic', score: 0.93 }],
      }),
    })
    const verdict = await verifier.verify(base)
    expect(verdict.kind).toBe('pass')
  })

  it('keeps a fail and returns the rationale', async () => {
    const verifier = new GroundingVerifier({
      verifyClaim: async () => ({ kind: 'fail', rationale: 'contradicts source' }),
    })
    const verdict = await verifier.verify(base)
    expect(verdict.kind).toBe('fail')
    if (verdict.kind !== 'fail') throw new Error('unreachable')
    expect(verdict.reason).toBe('contradicts source')
  })

  it('returns unknown when the backend throws', async () => {
    const verifier = new GroundingVerifier({
      verifyClaim: async () => {
        throw new Error('backend down')
      },
    })
    const verdict = await verifier.verify(base)
    expect(verdict.kind).toBe('unknown')
  })

  it('returns unknown without claim text', async () => {
    const verifier = new GroundingVerifier({ verifyClaim: async () => ({}) })
    const verdict = await verifier.verify({ claimId: 'c', subject: { type: 'grounding' }, evidenceRefs: [] })
    expect(verdict.kind).toBe('unknown')
  })
})
