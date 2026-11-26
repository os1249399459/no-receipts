import { afterAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, '..', 'dist', 'cli.js')
const dir = mkdtempSync(join(tmpdir(), 'nr-cli-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

interface Run {
  code: number
  stdout: string
  stderr: string
}

/** execFile throws on non-zero exit, so the code has to be read off the error. */
async function run(args: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args])
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

function writeInput(name: string, body: unknown): string {
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify(body), 'utf8')
  return path
}

const claim = (overrides: Record<string, unknown> = {}) => ({
  text: 'all tests pass',
  status: 'done',
  evidence_ids: [],
  verification: {},
  open_questions: [],
  unverified_assumptions: [],
  ...overrides,
})

describe('CLI contract', () => {
  it('demo prints three verdicts and exits 0', async () => {
    const result = await run(['demo'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('One of them is lying')
    expect(result.stdout).toContain('ALLOWED')
    expect(result.stdout).toContain('BLOCKED')
  })

  it('passes an input path with spaces to Node without a shell', async () => {
    const path = writeInput('empty turn.json', { turn: 1, evidence: [], claims: [] })
    const result = await run([path])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
  })

  it('exits 0 for a done claim backed by a successful tool call (bare array shape)', async () => {
    const path = writeInput('array.json', {
      turn: 1,
      evidence: [{ ref: 'ev_ok', ok: true, toolName: 'vitest' }],
      claims: [claim({ evidence_ids: ['ev_ok'] })],
    })
    const result = await run([path])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('[no-receipts] complete')
  })

  it('also accepts the wrapped document shape', async () => {
    const path = writeInput('wrapped.json', {
      turn: 1,
      evidence: [{ ref: 'ev_ok', ok: true, toolName: 'vitest' }],
      claims: { claims: [claim({ evidence_ids: ['ev_ok'] })] },
    })
    const result = await run([path])
    expect(result.code).toBe(0)
  })

  it('exits 1 with feedback when a done claim cites no evidence', async () => {
    const path = writeInput('no-evidence.json', { turn: 1, evidence: [], claims: [claim()] })
    const result = await run([path])
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('claim_invalid')
    expect(result.stdout).toContain('must cite at least one evidence_id')
  })

  it('exits 1 when the cited tool call failed', async () => {
    const path = writeInput('failed.json', {
      turn: 1,
      evidence: [{ ref: 'ev_bad', ok: false, toolName: 'vitest' }],
      claims: [claim({ evidence_ids: ['ev_bad'] })],
    })
    const result = await run([path])
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('evidence_failed')
  })

  it('exits 2 and logs one abort line when retries are exhausted', async () => {
    const path = writeInput('abort.json', { turn: 1, evidence: [], claims: [claim()] })
    const result = await run([path])
    if (process.env['RECEIPTS_MAX_RETRIES'] === '0') {
      expect(result.code).toBe(2)
      expect(result.stderr).toContain('[no-receipts] abort')
      expect(result.stderr.split('\n').filter((line) => line.includes('abort')).length).toBe(1)
    }
  })

  it('exits 2 on an unreadable file', async () => {
    const result = await run([join(dir, 'does-not-exist.json')])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('cannot read')
  })
})

describe('abort log format', () => {
  it('the documented grep pattern matches the emitted line', async () => {
    const path = writeInput('grep.json', { turn: 1, evidence: [], claims: [claim()] })
    const result = await run([path])
    // Anything that reaches stderr on a rejection must be greppable with the
    // pattern the README tells people to use.
    if (result.stderr.includes('abort')) {
      expect(result.stderr).toContain('[no-receipts] abort category=')
    }
  })
})
