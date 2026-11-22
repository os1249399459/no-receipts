/**
 * receipts — evidence-backed completion gate.
 *
 * Zero host dependencies. Every interaction with an agent runtime goes through
 * an interface exported from this module; a host adapter implements them and
 * calls `evaluateCompletion()` at its own "turn is about to end" boundary.
 *
 * Public surface:
 *   - types        : Claim, ClaimDocument, EvidenceLedger, Verdict, ...
 *   - validate     : validateClaims()  — shape + evidence coherence
 *   - gate         : CompletionGate    — retry budget, divergence limits, abort
 *   - verifiers    : filesystem / cli / http
 *   - formatters   : formatAbortLine() — one greppable line per abort
 */
import { sha256 } from './hash.js'

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

/* ------------------------------- claims ------------------------------- */

export type ClaimStatus = 'done' | 'partial' | 'blocked' | 'unknown'

export interface Claim {
  text: string
  status: ClaimStatus
  /** Stable ids returned by an evidence ledger. Must resolve with ok=true. */
  evidence_ids: string[]
  /** Free-form; a host verifier may read `verification.type`. */
  verification: Record<string, unknown>
  /** Claims that are `unknown`/`blocked` must disclose here, or the gate blocks. */
  open_questions: string[]
  unverified_assumptions: string[]
}

export interface ClaimDocument {
  claims: Claim[]
}

export interface ClaimIssue {
  code: string
  path: (string | number)[]
  message: string
}

export type ClaimValidationResult =
  | { ok: true; data: ClaimDocument }
  | { ok: false; issues: ClaimIssue[] }

/* ------------------------------ evidence ------------------------------ */

export type ToolOutcome = {
  ok: boolean
  /** Any host-normalized code; "OK" on success. */
  exitCode?: string
  error?: { name: string; code: string }
  detail?: JsonValue
}

export interface EvidenceRecord {
  /** Stable id, reproducible from the payload (not time-based). */
  ref: string
  ok: boolean
  toolName?: string
  createdAt?: string
  detail?: JsonValue
}

/**
 * The only persistence contract. A host adapter writes one record per observed
 * tool call; the gate reads them back by id. The reference implementation is
 * `MemoryLedger`; production users can back it with a file, SQLite, or OTel.
 */
export interface EvidenceLedger {
  emit(record: Omit<EvidenceRecord, 'ref'> & { ref?: string }): Promise<EvidenceRecord>
  get(ref: string): EvidenceRecord | undefined
}

/** Build a stable ref from the payload's canonical JSON. Host-agnostic. */
export function evidenceRef(input: JsonValue): string {
  return `ev_${digestJson(input).slice(0, 32)}`
}

/** Deterministic JSON digest — stable key order, fails loudly on non-JSON. */
export function digestJson(value: JsonValue): string {
  const canonical = canonicalize(value)
  return sha256(canonical)
}

function canonicalize(value: JsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`
}

/* ----------------------------- redaction ------------------------------ */

export const DEFAULT_REDACT_KEYS: readonly string[] = [
  'password', 'passwd', 'secret', 'token', 'apikey', 'api_key', 'authorization',
  'auth', 'credential', 'credentials', 'privatekey', 'private_key', 'accesskey',
  'access_key', 'session', 'sessionid', 'cookie', 'set-cookie',
]

/** Replace sensitive values with "[REDACTED]"; report which keys were hit. */
export function redactJson(
  value: JsonValue,
  keys: readonly string[] = DEFAULT_REDACT_KEYS,
): { value: JsonValue; redactedFields: string[] } {
  const lowered = new Set(keys.map((k) => k.toLowerCase()))
  const hit: string[] = []

  const walk = (node: JsonValue, keyPath: string): JsonValue => {
    if (node === null || typeof node !== 'object') {
      if (lowered.has(keyPath.toLowerCase())) {
        hit.push(keyPath)
        return '[REDACTED]'
      }
      return node
    }
    if (Array.isArray(node)) return node.map((item) => walk(item, keyPath))
    const out: Record<string, JsonValue> = {}
    for (const [key, child] of Object.entries(node)) {
      out[key] = walk(child, key)
    }
    return out
  }

  return { value: walk(value, ''), redactedFields: [...new Set(hit)] }
}
