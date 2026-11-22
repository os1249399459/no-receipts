/**
 * Evidence ledgers.
 *
 * `MemoryLedger` is the reference implementation and the only thing tests need.
 * `FileLedger` appends one JSON line per record so evidence survives the
 * process — the failure mode it guards against is "the agent claimed done, the
 * process exited, and nobody can prove what actually ran".
 */
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { digestJson, type EvidenceLedger, type EvidenceRecord, type JsonValue } from './types.js'

export class MemoryLedger implements EvidenceLedger {
  private readonly byRef = new Map<string, EvidenceRecord>()

  async emit(record: Omit<EvidenceRecord, 'ref'> & { ref?: string }): Promise<EvidenceRecord> {
    const ref = record.ref ?? deriveRef(record)
    const full: EvidenceRecord = { ...record, ref }
    this.byRef.set(ref, full)
    return full
  }

  get(ref: string): EvidenceRecord | undefined {
    return this.byRef.get(ref)
  }

  /** All records, oldest first. Useful for a status view or a postmortem. */
  list(): EvidenceRecord[] {
    return [...this.byRef.values()]
  }
}

export class FileLedger implements EvidenceLedger {
  private readonly cache = new Map<string, EvidenceRecord>()

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true })
    if (existsSync(path)) this.load()
  }

  private load(): void {
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      try {
        const record = JSON.parse(line) as EvidenceRecord
        if (typeof record.ref === 'string') this.cache.set(record.ref, record)
      } catch {
        // A truncated final line is expected after a crash; skip it silently
        // rather than losing every earlier record with it.
      }
    }
  }

  async emit(record: Omit<EvidenceRecord, 'ref'> & { ref?: string }): Promise<EvidenceRecord> {
    const ref = record.ref ?? deriveRef(record)
    const full: EvidenceRecord = { ...record, ref }
    this.cache.set(ref, full)
    appendFileSync(this.path, JSON.stringify(full) + '\n', 'utf8')
    return full
  }

  get(ref: string): EvidenceRecord | undefined {
    return this.cache.get(ref)
  }
}

function deriveRef(record: Omit<EvidenceRecord, 'ref'>): string {
  return `ev_${digestJson({
    toolName: record.toolName ?? '',
    ok: record.ok,
    detail: (record.detail ?? null) as JsonValue,
  }).slice(0, 32)}`
}
