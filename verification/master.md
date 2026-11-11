Paths: src/master/**, src/master.ts, src/daemon/**, src/reviewer.ts

## Tests

- `tests/dispatch-collision.test.ts`, `tests/dispatch-overlap.test.ts`: dispatch.
- `tests/headless-workers.test.ts`: headless workers, limit handoff, run logs.
- `tests/launch-prompt-delivery.test.ts`, `tests/project-memory.test.ts`: session requests.
- `tests/master.test.ts`, `tests/master-daemon.test.ts`, `tests/managed-worktree-root.test.ts`.
- `tests/reviewer-session-release.test.ts`, `tests/review-verdict.test.ts`: control-plane review launch/settlement without App credentials.
- `tests/master-config-retired-keys.test.ts`: load legacy `githubAppId`/`mergeMethod` and current files without App IDs.
- `tests/rework-review-findings.test.ts`: CHANGES_REQUESTED carries BLOCKING findings (else body) into `lastRework` and worker brief.
- `tests/five-step-cycle.test.ts`: snapshot, close, dispatch, merge writer, persist.
- `tests/trial-merge.test.ts`: failed trials trigger candidate rework without base-break refresh waits.
- `tests/deploy-unit.test.ts`: graphyard-deploy.service (`upgrade --watch`) and the loop's restart onto the tip it serves.
- `tests/main-batch-gate.test.ts`, `tests/publish-verified.test.ts`, `tests/diagnostic-filing-carries-output.test.ts`: batch gate, diagnostic filings (GY-3141).
- `tests/worker-credit-handoff.test.ts`: provider-limit stops preserve work and name its commit to the next account; `e2e:worker-credit-handoff`.

## Drive

`node bin/graphyard.mjs master status` reads loop state; tests inject preparers, probes and `tests/helpers/headless-runs.ts`. `master restart` uses `systemctl --user restart` for the install unit (ExecStart: `master run`) when up, stopping or restart-queued; never a second loop.

## Invariants

- Session requests are the first message on the runtime's command line, never pasted.
- A failed launch releases its claim; run logs outlive runs.
- Prompts are pure functions: inputs adding nothing leave requests byte-identical.
- Workers never receive trusted evidence-producer credentials.
- Control-plane rework appends BLOCKING findings (else body), bounded by `reworkBriefMax`.

## Gotchas

- `tests/barrel-imports.test.ts`: only CLI source may import `src/master.ts`; otherwise import owners directly. Daemon exports live in `src/daemon/*`; `src/master-daemon.ts` is removed.
- Prompt changes break exact-text assertions; grep the sentence first.
- A generated prompt never names `/tmp`.
