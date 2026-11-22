/**
 * Verifiers — turn a claim into pass / fail / unknown by *checking something*.
 *
 * The contract is deliberately narrow: a verifier either has a deterministic
 * answer or says `unknown`. Nothing here calls a model. A verifier that guesses
 * is worse than no verifier, because the gate would trust it.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { digestJson, type JsonValue } from './types.js'

const execFileAsync = promisify(execFile)

export type Verdict =
  | { kind: 'pass'; evidenceRef: string; detail?: JsonValue }
  | { kind: 'fail'; evidenceRef: string; reason: string; detail?: JsonValue }
  | { kind: 'unknown'; reason: string }

export interface VerificationRequest {
  claimId: string
  /** Arbitrary claim payload; each verifier reads only what it understands. */
  subject: JsonValue
  evidenceRefs: string[]
}

export interface Verifier {
  readonly type: string
  verify(request: VerificationRequest, signal?: AbortSignal): Promise<Verdict>
}

/* ---------------------------- filesystem ---------------------------- */

export interface FileVerifierOptions {
  /** Restrict readable paths to this prefix. Without it, verify() refuses. */
  rootDir?: string
}

interface FileSpec {
  path: string
  sha256?: string
  mustExist: boolean
}

function readFileSpec(subject: JsonValue): FileSpec | undefined {
  if (subject === null || typeof subject !== 'object' || Array.isArray(subject)) return undefined
  const raw = subject as Record<string, JsonValue>
  if (typeof raw['path'] !== 'string' || raw['path'].length === 0) return undefined
  return {
    path: raw['path'],
    ...(typeof raw['sha256'] === 'string' ? { sha256: raw['sha256'] } : {}),
    mustExist: raw['mustExist'] !== false,
  }
}

/**
 * Checks file existence and content hash. This is the verifier to reach for
 * first: it is deterministic, fast, and catches the single most common fake
 * completion ("I created the file" when no file exists).
 */
export class FileVerifier implements Verifier {
  readonly type = 'filesystem'

  constructor(private readonly options: FileVerifierOptions = {}) {}

  async verify(request: VerificationRequest): Promise<Verdict> {
    const spec = readFileSpec(request.subject)
    if (!spec) return { kind: 'unknown', reason: 'filesystem verification requires a `path`' }

    const root = this.options.rootDir
    if (root !== undefined && !spec.path.startsWith(root)) {
      return { kind: 'unknown', reason: `path is outside rootDir (${root})` }
    }

    if (!existsSync(spec.path)) {
      const ref = `fs:missing:${digestJson(spec.path).slice(0, 16)}`
      if (!spec.mustExist) return { kind: 'pass', evidenceRef: ref, detail: { path: spec.path, exists: false } }
      return { kind: 'fail', evidenceRef: ref, reason: 'file does not exist', detail: { path: spec.path } }
    }

    let content: string
    try {
      content = readFileSync(spec.path, 'utf8')
    } catch (error) {
      return { kind: 'fail', evidenceRef: `fs:unreadable:${digestJson(spec.path).slice(0, 16)}`, reason: String(error) }
    }

    const actual = digestJson(content)
    const ref = `fs:${actual.slice(0, 32)}`
    if (spec.sha256 !== undefined && actual !== spec.sha256) {
      return {
        kind: 'fail',
        evidenceRef: ref,
        reason: 'content hash mismatch',
        detail: { path: spec.path, expected: spec.sha256, actual },
      }
    }
    return { kind: 'pass', evidenceRef: ref, detail: { path: spec.path, sha256: actual } }
  }
}

/* -------------------------------- cli -------------------------------- */

export interface CliVerifierOptions {
  /** Exact argv[0] values that may run. Anything else is `unknown`. */
  allowedCommands: readonly string[]
  cwd?: string
  timeoutMs?: number
}

interface CliSpec {
  command: string
  args: string[]
}

function readCliSpec(subject: JsonValue): CliSpec | undefined {
  if (subject === null || typeof subject !== 'object' || Array.isArray(subject)) return undefined
  const raw = subject as Record<string, JsonValue>
  if (typeof raw['command'] !== 'string' || raw['command'].length === 0) return undefined
  const args = Array.isArray(raw['args']) ? raw['args'].filter((a): a is string => typeof a === 'string') : []
  return { command: raw['command'], args }
}

/**
 * Runs an allow-listed command and derives the verdict from its exit code.
 * The allowlist matters: without it this becomes "let the agent say done by
 * running `true`".
 */
export class CliVerifier implements Verifier {
  readonly type = 'cli'

  constructor(private readonly options: CliVerifierOptions) {}

  async verify(request: VerificationRequest, signal?: AbortSignal): Promise<Verdict> {
    const spec = readCliSpec(request.subject)
    if (!spec) return { kind: 'unknown', reason: 'cli verification requires `command`' }
    if (!this.options.allowedCommands.includes(spec.command)) {
      return { kind: 'unknown', reason: `command "${spec.command}" is not allow-listed` }
    }

    const startedAt = Date.now()
    try {
      const { stdout, stderr } = await execFileAsync(spec.command, spec.args, {
        cwd: this.options.cwd,
        timeout: this.options.timeoutMs ?? 120_000,
        signal,
        maxBuffer: 8 * 1024 * 1024,
      })
      const output = `${stdout}\n${stderr}`
      const ref = `cli:${digestJson(output).slice(0, 32)}`
      if (output.trim() === '') {
        // A command that prints nothing is not evidence of work. Refuse rather
        // than hand back a pass the gate cannot interrogate.
        return { kind: 'unknown', reason: 'command produced no output; cannot derive evidence' }
      }
      return {
        kind: 'pass',
        evidenceRef: ref,
        detail: { command: spec.command, argv: spec.args, exitCode: 0, ms: Date.now() - startedAt },
      }
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string; code?: number | string }
      const output = `${failed.stdout ?? ''}\n${failed.stderr ?? ''}`
      const ref = `cli:${digestJson(output).slice(0, 32)}`
      return {
        kind: 'fail',
        evidenceRef: ref,
        reason: `command exited with ${String(failed.code ?? 'error')}`,
        detail: { command: spec.command, argv: spec.args, exitCode: failed.code ?? null, ms: Date.now() - startedAt },
      }
    }
  }
}

/* ------------------------------ dispatch ----------------------------- */

export class VerifierRegistry {
  private readonly byType = new Map<string, Verifier>()

  constructor(verifiers: readonly Verifier[] = []) {
    for (const verifier of verifiers) this.byType.set(verifier.type, verifier)
  }

  register(verifier: Verifier): void {
    this.byType.set(verifier.type, verifier)
  }

  /** Unknown types return `unknown` — never `pass`. */
  async verify(request: VerificationRequest, signal?: AbortSignal): Promise<Verdict> {
    const type = verificationType(request.subject)
    const verifier = this.byType.get(type)
    if (!verifier) return { kind: 'unknown', reason: `no verifier registered for type "${type}"` }
    return verifier.verify(request, signal)
  }
}

/** Read `verification.type` from a claim subject, or "unknown". */
export function verificationType(subject: JsonValue): string {
  if (subject === null || typeof subject !== 'object' || Array.isArray(subject)) return 'unknown'
  const value = (subject as Record<string, JsonValue>)['type']
  return typeof value === 'string' && value.length > 0 ? value : 'unknown'
}

/* ----------------------------- playwright ---------------------------- */

/** Minimal structural view of a Playwright-style client; inject your own. */
export interface BrowserClient {
  assert(args: { selector?: string; text?: string; state?: string; url?: string }): Promise<{
    ok: boolean
    observed?: string
    error?: string
  }>
}

interface BrowserSpec {
  selector?: string
  text?: string
  state?: string
  url?: string
}

function readBrowserSpec(subject: JsonValue): BrowserSpec | undefined {
  if (subject === null || typeof subject !== 'object' || Array.isArray(subject)) return undefined
  const raw = subject as Record<string, JsonValue>
  const spec: BrowserSpec = {}
  if (typeof raw['selector'] === 'string') spec.selector = raw['selector']
  if (typeof raw['text'] === 'string') spec.text = raw['text']
  if (typeof raw['state'] === 'string') spec.state = raw['state']
  if (typeof raw['url'] === 'string') spec.url = raw['url']
  return spec.selector ?? spec.text ?? spec.state ?? spec.url ? spec : undefined
}

/**
 * Asserts a DOM/text/state condition through an injected browser client.
 *
 * This is the only verifier that can check "the page actually renders", which
 * is the one claim a filesystem or CLI check cannot reach. The client is
 * injected rather than bundled: pulling in a browser stack would destroy the
 * zero-dependency property for everyone who only needs file and command checks.
 */
export class BrowserVerifier implements Verifier {
  readonly type = 'browser'

  constructor(private readonly client: BrowserClient) {}

  async verify(request: VerificationRequest): Promise<Verdict> {
    const spec = readBrowserSpec(request.subject)
    if (!spec) return { kind: 'unknown', reason: 'browser verification requires selector/text/state/url' }

    let result: { ok: boolean; observed?: string; error?: string }
    try {
      result = await this.client.assert(spec)
    } catch (error) {
      return { kind: 'fail', evidenceRef: fingerprintOf(spec, false, undefined), reason: `client error: ${String(error)}` }
    }

    const detail = { spec: spec as Record<string, JsonValue>, ok: result.ok, observed: result.observed ?? null }
    const evidenceRef = fingerprintOf(spec, result.ok, result.observed)
    if (result.ok) return { kind: 'pass', evidenceRef, detail }
    return { kind: 'fail', evidenceRef, reason: result.error ?? 'assertion failed', detail }
  }
}

function fingerprintOf(spec: BrowserSpec, ok: boolean, observed: string | undefined): string {
  return `browser:${digestJson({ spec: spec as JsonValue, ok, observed: observed ?? null }).slice(0, 32)}`
}

/* ------------------------- grounded / python ------------------------- */

/** Minimal structural view of a grounding service; inject your own. */
export interface GroundingClient {
  verifyClaim(args: { claim_text: string; evidence_refs: string[] }): Promise<{
    kind?: string
    rationale?: string
    evidence_ref?: string
    deterministic_signals?: Array<{ source?: string; score?: number }>
    judge?: JsonValue
  }>
}

interface GroundingSpec {
  claimText: string
  evidenceRefs: string[]
}

function readGroundingSpec(subject: JsonValue, evidenceRefs: readonly string[]): GroundingSpec | undefined {
  if (subject === null || typeof subject !== 'object' || Array.isArray(subject)) return undefined
  const raw = subject as Record<string, JsonValue>
  const claimText = raw['claimText'] ?? raw['text']
  if (typeof claimText !== 'string' || claimText.length === 0) return undefined
  const fromSubject = Array.isArray(raw['evidenceRefs'])
    ? raw['evidenceRefs'].filter((ref): ref is string => typeof ref === 'string')
    : []
  return { claimText, evidenceRefs: [...evidenceRefs, ...fromSubject] }
}

/**
 * Checks a factual claim against a deterministic grounding backend.
 *
 * Defense in depth: a `pass` with no deterministic signal is downgraded to
 * `unknown`. A model's opinion that a claim is grounded is not evidence, and
 * accepting it would quietly turn this whole package into an LLM judge.
 */
export class GroundingVerifier implements Verifier {
  readonly type = 'grounding'

  constructor(private readonly client: GroundingClient) {}

  async verify(request: VerificationRequest): Promise<Verdict> {
    const spec = readGroundingSpec(request.subject, request.evidenceRefs)
    if (!spec) return { kind: 'unknown', reason: 'grounding verification requires claim text' }

    let result: Awaited<ReturnType<GroundingClient['verifyClaim']>>
    try {
      result = await this.client.verifyClaim({ claim_text: spec.claimText, evidence_refs: spec.evidenceRefs })
    } catch (error) {
      return { kind: 'unknown', reason: `grounding client failed: ${String(error)}` }
    }

    const deterministic = (result.deterministic_signals ?? []).filter(
      (signal) => signal.source === 'deterministic' && typeof signal.score === 'number',
    )

    if (result.kind === 'pass' && deterministic.length === 0) {
      return { kind: 'unknown', reason: 'judge-only pass refused: no deterministic signal present' }
    }
    const evidenceRef = result.evidence_ref ?? `grounding:${digestJson(spec.claimText).slice(0, 32)}`
    const detail = { rationale: result.rationale ?? null, deterministicSignals: deterministic }
    if (result.kind === 'pass') return { kind: 'pass', evidenceRef, detail }
    if (result.kind === 'fail') {
      return { kind: 'fail', evidenceRef, reason: result.rationale ?? 'grounding check failed', detail }
    }
    return { kind: 'unknown', reason: result.rationale ?? 'grounding backend returned no verdict' }
  }
}
