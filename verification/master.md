Paths: src/master/**, src/master.ts, src/reviewer.ts

## Tests

- `tests/module-budgets.test.ts`: every `src/master/` module stays within 800 lines and opens with a `// Concern:` header.
- `tests/dispatch-collision.test.ts`, `tests/dispatch-overlap.test.ts`, `tests/dispatch-race-guard.test.ts`: dispatch.
- `tests/launch-prompt-delivery.test.ts`, `tests/project-memory.test.ts`: session requests.
- `tests/master.test.ts`, `tests/master-daemon.test.ts`, `tests/managed-worktree-root.test.ts`.

## Drive

`node bin/graphyard.mjs master status` reads the loop's view; launches are exercised in tests with injected preparers, probes and Herdr runners, never real panes. Restart a running loop with systemctl, not `master restart`.

## Invariants

- A launched session's request is its first message on the runtime's command line, never a paste.
- A failed launch releases its claim; a pane that may hold a running supervisor is never closed under it.
- Prompts are pure functions of their inputs: an input that adds nothing leaves the request byte-identical.
- Workers never receive trusted evidence-producer credentials.

## Gotchas

- `src/master.ts` only re-exports; add code to the module that owns the concern.
- Prompt changes break exact-text assertions across many test files; grep for the sentence first.
- A generated prompt never names `/tmp`.
