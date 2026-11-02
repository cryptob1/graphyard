Paths: src/master/**, src/master.ts, src/reviewer.ts

## Tests

- `tests/dispatch-collision.test.ts`, `tests/dispatch-overlap.test.ts`: dispatch.
- `tests/launch-prompt-delivery.test.ts`, `tests/project-memory.test.ts`: session requests.
- `tests/master.test.ts`, `tests/master-daemon.test.ts`, `tests/managed-worktree-root.test.ts`.
- `tests/reviewer-session-release.test.ts`, `tests/review-verdict.test.ts`: launch and settle control-plane reviews without reviewer App credentials.
- `tests/master-config-retired-keys.test.ts`: load older master files with `githubAppId` and `mergeMethod`, and current files without an App ID.
- `tests/rework-review-findings.test.ts`: CHANGES_REQUESTED carries BLOCKING findings (else body) into `lastRework` and worker brief.
- `tests/five-step-cycle.test.ts`: snapshot, close, dispatch, merge writer, persist.
- `tests/trial-merge.test.ts`: failed trials ground candidate rework through the merge writer, without base-break refresh waits.
- `tests/deploy-unit.test.ts`: graphyard-deploy.service (`upgrade --watch`) and the loop's restart onto the tip it serves.
- `tests/worker-credit-handoff.test.ts`: provider-limit stops preserve work and name its commit to the next account; `e2e:worker-credit-handoff`.

## Drive

`node bin/graphyard.mjs master status` reads the loop's view; tests inject preparers, probes and Herdr runners, never real panes. `master restart` uses `systemctl --user restart` for this install's unit (rooted here, ExecStart running `master run`) when up, stopping or restart-queued; it never starts a second, unsupervised loop.

## Invariants

- A launched session's request is its first message on the runtime's command line, never a paste.
- A failed launch releases its claim; a pane that may hold a running supervisor is never closed under it.
- Prompts are pure functions: inputs adding nothing leave requests byte-identical.
- Workers never receive trusted evidence-producer credentials.
- A standing control-plane change request's rework reason appends its BLOCKING findings (else its body), bounded by `reworkBriefMax`.

## Gotchas

- `src/master.ts` only re-exports; add code to the module that owns the concern.
- Prompt changes break exact-text assertions across many test files; grep for the sentence first.
- A generated prompt never names `/tmp`.
