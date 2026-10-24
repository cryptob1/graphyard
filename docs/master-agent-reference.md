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

The merge writer's trial, the only trial: the merge commit's build and affected tests via `scripts/ci-tests.mjs`, or — without that script — the repository's `preMerge` / `npm test` / `npm run typecheck` checks (dashboard changes: `npx playwright install chromium`, then `npm run test:browser`), credential-free in its own `TMPDIR`, killed after 20 minutes; its checkout is removed when it ends. A managed repository with no test check records that explicitly (`master status` / `doctor`: `trialTests`).
