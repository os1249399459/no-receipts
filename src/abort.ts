/**
 * Abort line formatting and sink.
 *
 * One abort = one line, same shape every time, so `grep '\[receipts\] abort'`
 * gets you a complete history with no parsing. Escaping is deliberate: a claim
 * text containing quotes or newlines must not be able to forge a second line.
 */
import { appendFileSync } from 'node:fs'
import type { AbortDetail } from './gate.js'

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`
}

export function formatAbortLine(detail: AbortDetail): string {
  const claim = detail.claim_text ? `claim=${quote(detail.claim_text)}` : 'claim=-'
  const evidence = detail.evidence_ids?.length ? `evidence=${detail.evidence_ids.map(quote).join(',')}` : 'evidence=-'
  const counts = detail.counts ? `counts=${detail.counts.actual}/${detail.counts.limit}` : 'counts=-'
  return `[no-receipts] abort category=${detail.category} ${claim} ${evidence} ${counts} detail=${quote(detail.detail)}`
}

export interface AbortSinkOptions {
  /** Append the line to this file, in addition to stderr. */
  logPath?: string
  /** Where stderr goes; defaults to console.error. */
  write?: (line: string) => void
}

/** Emit exactly one line per abort. Returns the line for testing. */
export function emitAbortLine(detail: AbortDetail, options: AbortSinkOptions = {}): string {
  const line = formatAbortLine(detail)
  const write = options.write ?? ((text: string) => console.error(text))
  write(line)
  if (options.logPath) {
    try {
      appendFileSync(options.logPath, line + '\n', 'utf8')
    } catch (error) {
      write(`[no-receipts] abort log write failed: ${String(error)}`)
    }
  }
  return line
}
