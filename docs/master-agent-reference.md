<!-- page: Operate Graphyard | 7 | typed actions -->
# Master-agent reference

## Items and human waits

Human: `park GY-N EPOCH KIND NEEDED --ask ASK --recommend TEXT --why WHY [--choice LABEL]… -- REASON` ([the dashboard](onboarding.md#the-dashboard)); `answer GY-N …`; criterion-rewrite asks refused. A `blocked` reason is plain text; `master unblock GY-N REASON` clears it.

## Promotion to autonomy

`graphyard master promote --admin-token-stdin` provisions the master's operator-agent identity.

## GitHub administration through the browser

Graphyard's one remote credential is the merge writer's deploy key ([install](install.md)). `master browser app-permissions|installation-accept|capture` therefore refuse, naming the missing credential. `master harness claude|codex --apply` writes rules denying `gh pr merge`/`review`, token-minting or mutating `gh api`.

## Typed actions

`nextAction`: `dispatch`/`request-review`/`request-rework`/`resync`/`reclaim`/`merge`; a gate refusal is its reason string.

## Recovery

A dead supervisor's lease lapses; the close step keeps what the attempt had not committed on its branch and records it for the redispatch's handoff, then reconciles the lease and the item is claimable again.

### Producer-runtime faults

Unacted producer requests relaunch on an untried profile.

## Merge trial

The merge writer's trial, the only trial: the merge commit's build and affected tests via `scripts/ci-tests.mjs`, or — without that script — the repository's `preMerge` / `npm test` / `npm run typecheck` checks (dashboard changes: `npx playwright install chromium`, then `npm run test:browser`), credential-free in its own `TMPDIR` (a fresh `HOME` under a bubblewrap mask of the deploy key and coordinator credentials — npm, the static build, `e2e.serve`, and bound E2E command/agent steps all run under it, every step invocation of a case sharing one confined session's namespace so a browser an agent step opens outlives each invocation; the push child alone still holds the key), killed after 20 minutes; its checkout is removed when it ends. The fresh home preserves the host's mise config, data, state and cache directories (explicit `MISE_*_DIR` values win, otherwise host XDG/HOME defaults), alongside the npm cache; credential masks still apply. Known mise and missing exact node/npm/npx executable startup failures (including bubblewrap’s `execvp` missing-executable diagnostic) during dependency installation or build follow the host-failure retry/hold path and never ground item rework. Missing build dependencies such as node-gyp remain build failures and ground item rework. A failed build's refusal includes the end of its output within the 2,000-character refusal limit. A managed repository with no test check records that explicitly (`master status` / `doctor`: `trialTests`).
