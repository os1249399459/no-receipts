#!/usr/bin/env node
/**
 * Cross-repo contract check — the drift guard for `shared_invariants.test.ts`.
 *
 * `no-receipts` and `false-completion-bundle` are two implementations of one
 * contract. Each repo has its own tests/shared_invariants.test.ts, kept in sync
 * by hand (see HANDOFF.md "Cross-Repo Sync Discipline"). Nothing mechanical
 * stopped someone from deleting the file, renaming it, or quietly dropping one
 * of the three invariant blocks — and a missing invariant test looks exactly
 * like a passing one.
 *
 * This script is that mechanism. It asserts PRESENCE ONLY:
 *   I1  fail-closed evidence handling
 *   I2  three-state decisions
 *   I3  ASCII-only abort lines
 *
 * It deliberately does NOT compare the two implementations, does not diff the
 * files, and does not require the same assertions — the repos differ on purpose
 * (no-receipts has no exporter_failed category and no verifier= field). The
 * contract is the set of invariants, not the code.
 *
 * Standard library only: fs + path. No dependencies.
 *
 * Usage:  node scripts/check-contract.mjs [--repo <dir>]
 * Exit:   0 = all three invariants present, 1 = missing file or anchor.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'

/**
 * Each invariant must appear as a `describe('In: ...')` block whose title also
 * carries the invariant's defining phrase. Requiring the phrase (not just the
 * `I1:` label) means a block cannot be gutted to an empty shell while keeping
 * its heading.
 */
const REQUIRED_INVARIANTS = [
  { id: 'I1', phrase: 'fail-closed', meaning: 'fail-closed evidence handling' },
  { id: 'I2', phrase: 'three-state', meaning: 'three-state decisions' },
  { id: 'I3', phrase: 'ASCII-only', meaning: 'ASCII-only abort lines' },
]

/** Locate the repo root: the script lives in <root>/scripts/. */
function findRoot(argv) {
  const flag = argv.indexOf('--repo')
  if (flag !== -1 && argv[flag + 1]) return argv[flag + 1]
  // scripts/check-contract.mjs -> root is one level up.
  return join(import.meta.dirname, '..')
}

function main() {
  const root = findRoot(process.argv.slice(2))
  const relPath = 'tests/shared_invariants.test.ts'
  const filePath = join(root, relPath)

  const failures = []

  if (!existsSync(root)) {
    console.error(`[contract] FAIL: repo directory not found: ${root}`)
    return 1
  }

  if (!existsSync(filePath)) {
    failures.push(`missing file: ${relPath}`)
    // A rename is the most likely cause; name it so the error is actionable.
    const testsDir = join(root, 'tests')
    if (existsSync(testsDir)) {
      const near = readdirSync(testsDir).filter((n) => /invariant/i.test(n))
      if (near.length > 0) {
        failures.push(`found similarly named file(s) in tests/: ${near.join(', ')} — renamed?`)
      }
    }
  } else {
    const source = readFileSync(filePath, 'utf8')
    for (const invariant of REQUIRED_INVARIANTS) {
      // The block heading must carry both the id and the defining phrase.
      const heading = new RegExp(`describe\\(\\s*['"\`]${invariant.id}:([^'"\`]*)['"\`]`)
      const match = source.match(heading)
      if (!match) {
        failures.push(
          `${invariant.id} block missing — expected a describe('${invariant.id}: ...') test block (${invariant.meaning})`,
        )
        continue
      }
      const title = match[1]
      if (!title.includes(invariant.phrase)) {
        failures.push(
          `${invariant.id} heading lost its phrase "${invariant.phrase}" (${invariant.meaning}); heading is "${invariant.id}:${title}"`,
        )
      }
      // The block must actually contain assertions, not just a heading.
      const bodyStart = source.indexOf(match[0])
      const body = source.slice(bodyStart, bodyStart + 4000)
      if (!/\bexpect\s*\(/.test(body)) {
        failures.push(`${invariant.id} block has a heading but no expect(...) assertions`)
      }
    }
  }

  const name = basename(root)
  if (failures.length > 0) {
    console.error(`[contract] FAIL (${name}): ${failures.length} problem(s) with ${relPath}`)
    for (const failure of failures) console.error(`  - ${failure}`)
    console.error(
      '\n[contract] The three shared invariants must stay present in this repo.\n' +
      '           Restore the block(s); see HANDOFF.md "Cross-Repo Sync Discipline".',
    )
    return 1
  }

  console.log(`[contract] OK (${name}): I1 fail-closed, I2 three-state, I3 ASCII-only all present in ${relPath}`)
  return 0
}

process.exit(main())
