<!-- page: Operate Graphyard | 7 | typed actions -->
# Master-agent reference

## Items and human waits

Human: `park GY-N EPOCH KIND NEEDED --ask ASK --recommend TEXT --why WHY [--choice LABEL]… -- REASON` ([the dashboard](onboarding.md#the-dashboard)); `answer GY-N …`; criterion-rewrite asks refused. A `blocked` reason is plain text; `master unblock GY-N REASON` clears it.

## Promotion to autonomy

`graphyard master promote --admin-token-stdin` provisions the master's operator-agent identity.

Reviewers launch with `master reviewer add FILE` profiles and post verdicts through the control plane with a token bound to that launch and candidate. No reviewer GitHub App, installation binding or App credential is needed; `master reviewer setup` and `bind` are removed. Older master configs with `githubAppId` and `mergeMethod` still load.

Before submission, run `graphyard verify GY-N` in the assigned worktree for local criterion checks. After `complete`, the control plane requests independent review and the merge writer runs the required unit and served-head E2E proofs for the submitted head. Workers do not submit trusted evidence; results from an earlier head cannot satisfy the new head's merge gates.

## Typed actions

`nextAction`: `dispatch`/`request-review`/`request-rework`/`resync`/`reclaim`/`merge`; a gate refusal is its reason string.

## Recovery

`master browser` is removed. If an older control plane reports App permissions or held integration jobs, the master uses `graphyard install --repo OWNER/NAME --plan`, then `--apply`, to install the merge writer's deploy key in place of the retired App integration.

A dead supervisor's lease lapses; the close step keeps what the attempt had not committed on its branch and records it for the redispatch's handoff, then reconciles the lease and the item is claimable again.

### Producer-runtime faults

Unacted producer requests relaunch on an untried profile.

## Merge trial

The merge writer's trial, the only trial: the merge commit's build and affected tests via `scripts/ci-tests.mjs`, or — without that script — the repository's `preMerge` / `npm test` / `npm run typecheck` checks (dashboard changes: `npx playwright install chromium`, then `npm run test:browser`), credential-free in its own `TMPDIR` (a fresh `HOME` beside the short temporary directory, keeping nested test socket paths bounded, under a bubblewrap mask of the deploy key and coordinator credentials — npm, the static build, `e2e.serve`, and bound E2E command/agent steps all run under it, every step invocation of a case sharing one confined session's namespace so a browser an agent step opens outlives each invocation; the push child alone still holds the key), killed after 20 minutes; its checkout is removed when it ends. A managed repository with no test check records that explicitly (`master status` / `doctor`: `trialTests`).
