# no-receipts

**Blocks an agent from saying "done" when its claims aren't backed by tool calls that actually succeeded.**

> *No receipts, no done.*

Zero dependencies. No model in the loop. ~1,000 lines, one job.

The name is the rule. In the culture this comes from, you don't get to make a claim without
producing the receipts — and a tool call that exited non-zero is not a receipt.

```bash
npx no-receipts demo            # three turns: one liar, one failed check, one real
npx no-receipts claims.json     # exit 0 = complete, 1 = retry, 2 = abort
```

---

## The failure this catches

Agent says: *"Fixed the bug and all tests pass."*

What actually happened: it ran the test suite, the suite failed, and it summarised anyway. Or it never ran anything. Either way the sentence is false, and you find out three commits later.

`no-receipts` makes that sentence impossible to end a turn with. The model must emit claims shaped like this:

```json
{
  "claims": [
    {
      "text": "all tests pass",
      "status": "done",
      "evidence_ids": ["ev_9f2c..."],
      "verification": { "type": "cli", "command": "npx", "args": ["vitest", "run"] },
      "open_questions": [],
      "unverified_assumptions": []
    }
  ]
}
```

and `ev_9f2c...` must resolve to a tool call that ran and **succeeded**. Four rules, checked in order:

| # | Rule | Verdict on violation |
|---|---|---|
| 1 | `done` must cite ≥1 `evidence_id` | `claim_invalid` |
| 2 | every cited id must exist in the ledger | `evidence_missing` |
| 3 | every cited id must have `ok: true` | `evidence_failed` |
| 4 | `unknown`/`blocked` must appear in `open_questions` or `unverified_assumptions` | `claim_invalid` |

Rule 4 is the subtle one. "I don't know" is a legitimate answer — but only when the user is told. An undisclosed `unknown` is the quietest fake completion, and the hardest to catch by reading the transcript.

## Why not just trust a verifier

The gate has three outcomes and deliberately no fourth:

- `complete` — claims validated
- `feedback` — retryable; the exact issue list is handed back to the model
- `abort` — retries spent, or a divergence limit hit

There is no "pass because we ran out of ideas." A gate that fails open is decoration. The retry budget defaults to **1**, so a persistent liar is aborted rather than looped forever.

Divergence limits catch a different failure — the agent that keeps working and never converges:

| Limit | Default |
|---|---|
| steps per turn | 20 |
| tool calls per turn | 30 |
| consecutive no-progress steps | 3 |

"No progress" means the claim statuses and cited evidence ids are byte-identical to the previous step. Cheap to compute, hard to game.

## Verifiers

A verifier either answers deterministically or returns `unknown`. Nothing here calls a model — a verifier that guesses is worse than no verifier, because the gate would trust it.

### Status

| Verifier | Type key | Status | Notes |
|---|---|---|---|
| `FileVerifier` | `filesystem` | **Done** | existence + optional content SHA-256; `rootDir` confinement |
| `CliVerifier` | `cli` | **Done** | exit-code verdicts, explicit command allowlist, empty output → `unknown` |
| `BrowserVerifier` | `browser` | **Done** | injected client; asserts selector / text / state / url |
| `GroundingVerifier` | `grounding` | **Done** | injected client; a judge-only `pass` is downgraded to `unknown` |
| `HttpVerifier` | `http` | *To be continued* | status/JSON-path assertions against a live endpoint |
| `GitHubVerifier` | `github` | *To be continued* | PR/commit checks via the GitHub API; needs a token, so it is opt-in by construction |

The two "to be continued" entries are deliberately unimplemented rather than stubbed. A stub that returns `unknown` forever would silently degrade every claim that used it into an abort — worse than a missing verifier, because it looks like it works.

The two shipped-but-injected verifiers (`browser`, `grounding`) follow the same rule: the **client** is yours to supply (Playwright MCP, a FastAPI grounding service, whatever), because bundling a browser stack or a Python runtime would destroy the zero-dependency property for everyone who only needs file and command checks.

```ts
import { FileVerifier, CliVerifier, BrowserVerifier, VerifierRegistry } from 'no-receipts'

const registry = new VerifierRegistry([
  new FileVerifier({ rootDir: process.cwd() }),
  new CliVerifier({ allowedCommands: ['npx', 'pytest', 'tsc'] }),
  new BrowserVerifier(myPlaywrightClient),   // { assert(spec) => { ok, observed?, error? } }
])

const verdict = await registry.verify({
  claimId: 'c1',
  subject: { type: 'cli', command: 'npx', args: ['vitest', 'run'] },
  evidenceRefs: [],
})
// → { kind: 'pass', evidenceRef: 'cli:...' } | { kind: 'fail', ... } | { kind: 'unknown', ... }
```

`CliVerifier` requires an explicit allowlist. Without it the whole thing collapses into "the agent runs `true` and declares victory."

`FileVerifier` checks existence and, optionally, a content SHA-256 — the single most common fake completion is "I created the file" when no file exists.

Unregistered verification types return `unknown`, never `pass`.

## Wiring it to your agent

The core has no host dependencies on purpose. Anything that can hand it `{ evidence, claims }` can gate a turn.

**CLI** (already works today — see `src/cli.ts`):

```bash
RECEIPTS_MAX_RETRIES=1 RECEIPTS_LOG=./aborts.log npx no-receipts claims.json
```

**As a library:**

```ts
import { CompletionGate, FileLedger } from 'no-receipts'

const gate = new CompletionGate({
  ledger: new FileLedger('.no-receipts/evidence.jsonl'),
  maxRetries: 1,
  onAbort: (record) => console.error(record.category, record.detail),
})

// as the agent runs:
gate.noteToolCall(turn)
await ledger.emit({ ok: exitCode === 0, toolName: 'vitest', detail: { exitCode } })

// at the turn boundary:
const decision = await gate.evaluate({ output: parsedClaims, turn })
if (decision.kind === 'abort') stop(decision.reason)
if (decision.kind === 'feedback') steer(decision.message)
```

Claude Code, concretely — `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "no-receipts claims.json" }
        ]
      }
    ]
  }
}
```

Exit code 2 blocks the stop and shows stderr to the model; exit 0 lets the turn end.

### Host lifecycle differences

These matter and are not glossed over:

| Host | Can hard-block a turn? | Mechanism |
|---|---|---|
| Claude Code | yes | `Stop` hook, `{"decision":"block","reason":...}` |
| Cursor | no | `stop` hook only supports `followup_message` (auto-retry, `loop_limit` default 5) |
| Codex CLI | unverified | — |

So on Cursor the correct integration is **degrade to retry**, not pretend-to-abort. The gate already expresses that distinction: `feedback` is a retry, `abort` is a stop.

## Abort log

One abort = one line, same shape every time:

```
[receipts] abort category=evidence_failed claim="all tests pass" evidence="ev_fail" counts=1/0 detail="retries exhausted (1/0)"
```

Quote, backslash, and newline are escaped inside the values, so a claim text containing a newline cannot forge a second line. `grep '\[receipts\] abort'` gives you a complete history with no parsing.

## Where this came from

This is a rewrite of a harness I built for one specific agent runtime in late 2026. That original lived inside a plugin entry point (~290 lines of host glue) with five verifiers, an OpenTelemetry evidence ledger, and a repetition guard. All of it worked, and none of it was removable — the gate logic was tangled with the host's lifecycle API.

Everything below is what survived the extraction. The design debts are inherited, and named:

- **The four claim rules** come from watching the same failure repeat: an agent that runs a failing test, then writes a paragraph that quietly omits the failure. The rules are phrased as *what must be true*, not *what must be said*, because the second is unbounded.
- **The three-state decision (`complete` / `feedback` / `abort`)** exists because two different hosts have very different powers. One can hard-block a turn boundary; another can only enqueue a follow-up message. A pass/fail gate would have had to lie about one of them. See [the host table](#host-lifecycle-differences).
- **Divergence limits** (steps, tool calls, consecutive no-progress) came from a specific deadlock: an agent re-running the same failing command with identical arguments until the token window closed. The fix that survived is cheap — compare claim statuses and evidence ids to the previous step — because anything more elaborate needed state the host did not expose.
- **Rule 4 (undisclosed `unknown`)** is the one I did not anticipate. It came from noticing that the most dangerous outputs were not confident lies but silent omissions.
- **Refusing to guess** in verifiers is the single strongest opinion in this repo. It cost an OTel ledger (dropped: nothing in this package needs spans) to keep.

### Related work

None of this is a new idea; the neighbourhood is crowded and I checked it before writing:

- [`crucible`](https://github.com/krzemienski/crucible) — evidence-gated task planning for Claude Code, requires quorum-approved proof. Took the idea that completion should need *proof*, left the voting (solo devs voting with themselves is theatre).
- [`proof-of-done`](https://www.npmjs.com/package/proof-of-done) — diffs before/after to catch deleted or skipped tests. The best idea in the space for *regression* detection; deliberately out of scope here because it requires both sides of a change.
- [`agent-guardrails`](https://github.com/jzOcb/agent-guardrails) and [`verify-gate-mcp`](https://www.npmjs.com/package/verify-gate-mcp) — mechanical enforcement and prover≠verifier separation. Took the "enforcement must be code, not instructions" rule; skipped the MCP requirement.
- [Anthropic's Claude Code hook docs](https://code.claude.com/docs/en/hooks) and [Cursor's hooks reference](https://cursor.com/docs/hooks) — the two lifecycle models that forced the three-state design.
- The OTel-span evidence ledger in the original was patterned on OpenTelemetry's span-attribute conventions; it is not in this package because a `Map` and a JSONL file do the same job here without the dependency.

If you want the full comparison (including what this deliberately does *not* do), see [COMPARISON.md](./COMPARISON.md).

## What this is not

- **Not a test runner.** It reads verdicts; it does not produce them.
- **Not an LLM judge.** No model decides whether a claim is honest.
- **Not a sandbox.** It cannot stop an agent from lying in a file it writes — only from ending a turn on the lie.
- **Not complete.** See the verifier status table: `http` and `github` are not implemented.

## Install / develop

```bash
npm install
npm run typecheck
npm test          # 39 tests
npm run build
```

MIT.
