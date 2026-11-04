Paths: src/master/**, src/master.ts, src/reviewer.ts

## Tests

- `tests/dispatch-collision.test.ts`, `tests/dispatch-overlap.test.ts`: dispatch.
- `tests/launch-prompt-delivery.test.ts`, `tests/project-memory.test.ts`: session requests.
- `tests/master.test.ts`, `tests/master-daemon.test.ts`, `tests/managed-worktree-root.test.ts`.
- `tests/reviewer-session-release.test.ts`, `tests/review-verdict.test.ts`: control-plane review launch/settlement without App credentials.
- `tests/master-config-retired-keys.test.ts`: load legacy `githubAppId`/`mergeMethod` and current files without App IDs.
- `tests/rework-review-findings.test.ts`: CHANGES_REQUESTED carries BLOCKING findings (else body) into `lastRework` and worker brief.
- `tests/five-step-cycle.test.ts`: snapshot, close, dispatch, merge writer, persist.
- `tests/trial-merge.test.ts`: failed trials trigger candidate rework without base-break refresh waits.
- `tests/deploy-unit.test.ts`: graphyard-deploy.service (`upgrade --watch`) and the loop's restart onto the tip it serves.
- `tests/worker-credit-handoff.test.ts`: provider-limit stops preserve work and name its commit to the next account; `e2e:worker-credit-handoff`.

## Drive

`node bin/graphyard.mjs master status` reads loop state. Tests inject preparers, probes and Herdr runners. `master restart` restarts the install's systemd unit, never a second loop.

## Invariants

- Session requests are the first message on the runtime's command line, never pasted.
- A failed launch releases its claim; a pane that may hold a running supervisor is never closed under it.
- Prompts are pure functions: inputs adding nothing leave requests byte-identical.
- Workers never receive trusted evidence-producer credentials.
- A standing control-plane change request's rework reason appends its BLOCKING findings (else its body), bounded by `reworkBriefMax`.

## Gotchas

- `tests/barrel-imports.test.ts` enforces direct owning-module imports outside `src/cli/**`; daemon imports use `src/daemon/*`.
- Prompt changes break exact-text assertions across many test files; grep for the sentence first.
- A generated prompt never names `/tmp`.
