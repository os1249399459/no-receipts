# Contributing to no-receipts

Thanks for looking. This is a small package with a narrow opinion — the fastest
way in is to pick one of the two unimplemented verifiers and send a PR.

Two verifiers are declared in the status table above but not implemented: `http` and `github`. If you want one of them, that is the highest-leverage contribution available, and it is deliberately scoped small — a verifier is one class with a single `verify()` method, and `CliVerifier` is the reference at ~80 lines.

Newcomer-friendly entry points:

- **Implement `HttpVerifier`** — status code and JSON-path assertions against a live endpoint.
- **Implement `GitHubVerifier`** — PR/commit checks via the GitHub API. Needs a token, so it must be opt-in by construction.
- **Windows path handling in the CLI tests** — `chmod` and path separators are Unix-shaped today.
- **A third claim rule you think is missing** — explain the failure mode you have seen, not the rule you want.

Rules for a PR, in order of how much they matter:

1. `npm test` stays green, and new behaviour arrives with a test that fails without it.
2. A verifier that cannot check something returns `unknown`. Never `pass`.
3. No new runtime dependency. That property is the whole reason this exists as a separate package.
4. If you change a string the README quotes (an abort line, a command, an exit code), change both in the same commit. The README is a contract here, not marketing.

Open a discussion or an issue if you are unsure whether something fits — an idea that gets rejected in an issue costs nothing; a rejected PR costs a weekend.

