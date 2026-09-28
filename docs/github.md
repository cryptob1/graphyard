<!-- page: Operate Graphyard | 2 | App, protection, queue, proofs. -->
# GitHub enforcement

## App permissions

The control-plane App holds (`src/github-permissions.ts`):

| Permission | Access | Needed to |
| --- | --- | --- |
| Actions | Read and write | rerun failed workflow jobs on the unchanged candidate (failed CI reruns) |
| Administration | Read | inspect branch protection (pull request observation) |
| Checks | Read and write | read CI check runs (pull request observation); publish `Graphyard / merge` on the exact candidate commit (the required check) |
| Contents | Read and write | read commits, trees and pull request files (pull request observation); publish speculative merge-queue tips: the merge commit on the candidate branch and the `refs/graphyard/queue/*` ref that binds it (the merge queue) |
| Issues | Read | receive `issue_comment` webhooks carrying review results (comment webhooks) |
| Metadata | Read | read the managed repository (repository access) |
| Pull requests | Read and write | read pull requests and reviews (pull request observation); post review request comments (review dispatch) |
A reviewer App is never granted Contents: write, Checks, or Administration; worker identities are not Apps at all. It holds:

| Permission | Access | Needed to |
| --- | --- | --- |
| Contents | Read | read the code under review (pull request observation) |
| Issues | Read | follow `issue_comment` events on the reviewed pull request (comment webhooks) |
| Metadata | Read | read the managed repository (repository access) |
| Pull requests | Read and write | post the verdict comment (review dispatch) |

Grants are rechecked every five minutes and on 403s; a shortfall (`appPermissions`) holds its jobs, **not retried** (`integration-held`), until `master browser app-permissions` or `master browser installation-accept` fixes it.

## The reviewer App

`graphyard master reviewer setup` creates it (Pull requests write, reads otherwise). Review tokens last one hour; `SLUG[bot]` approving the head satisfies both.

## Require the check

On the base branch require `Graphyard / merge` from this App, `strict` **off**, admin-enforced, no force pushes or deletion, workers without bypass ([repair lane](master-agent.md#repair-lane)); `master browser protection` reconciles it.

The gate requires `GITHUB_CI_APP_IDS` CI checks, current-head approval, trusted passing evidence, a mergeable non-draft PR and the queue head or the [optimistic lane](#optimistic-merges). Unknown mergeability is re-read 3× in 10 s, then refused.

## Merge queue

A failed required check reruns once on the unchanged head before rework or ejection. Gate and rework decisions take the newest check-run ID from configured CI Apps, not other Apps' same-named checks. Master status shows pending reruns and outcomes outside the queue. An owed or accepted rerun expires after 15 minutes without a new run; a running check finishes. The App needs Actions: write; preflight diagnoses a missing grant; rerun requests hold until accepted.

Once gated, the candidate's speculative tip, pushed onto the candidate branch and `refs/graphyard/queue/KEY`, binds every check, review and proof. A failed check, requested changes, a revoked proof, a conflict or rework ejects it to the back. One conflicting only with entries ahead of it re-enters unchanged once one lands or leaves. The App passes the check for an authorized head and merge group and merges (queue, auto-merge or direct); protection decides; withdrawal dequeues. Without a queue, `CLEAN`, `UNSTABLE` and `HAS_HOOKS` PRs merge at once, head-bound.

### Bindings and carry

Reviews and proofs bind one head, base and policy revision. The queue tip merges moved bases: all carry if the clean merge kept the patch-id, else the approval if no reviewed file changed, disjoint-`scopeFiles` proofs. A republication reads the PR's reviews before force-pushing: the replaced tip's approval carries onto a Graphyard-authored tip over the same author head and patch, the App's own patch-unchanged dismissal restoring when observed — never a person's, a moved author head, or a changed patch. Carried steps name their ground; CI reruns. GitHub conflicts are test-merged; clean ones log `base.stale-mergeability`.

### Parallel tips

`mergeQueue.parallelTips` (master config, default 4) stacked tips test at once; entries merge in order once every tip through theirs passes. Each publication wakes successors, re-reading in-flight verdicts. After any configured failed-check rerun, a failing tip ejects its entry once those ahead pass; later tips rebuild. `master status` and Merge step list them.

Above one, each entry validates on its own tip: defaults mean four tips at once — one CI duration covers four positions, costing concurrent CI and a discarded suffix on failure; `parallelTips: 1` restores batching; `batchSize` widens observation and wake depth.

### Optimistic merges

`mergeQueue.optimistic` (default on, independent of `mergeQueue.rerunFailedChecks`): a green entry disjoint from base changes and shared infrastructure lands head-bound, unqueued; a main guard [reverts](master-agent.md#repair-lane) and reopens culprits (`master status`: `optimisticMerge`). Each repository's shared infrastructure is the master config's `mergeQueue.optimisticExclude` globs — onboarding writes product defaults (manifests and lockfiles, CI config, test helpers, schema and migration directories) — so a change to an excluded path never merges optimistically, nor anything whose base changed one since its run; an untouched default copy reads as the current defaults, so later default globs cover earlier installs (GY-925); a tuned list stands as configured; `optimistic: false` turns the lane off.

### Proofs in CI

A protected `pull_request_target` workflow runs on every `graphyard/*` push: **plan** finds the item's `unit:*`/`integration:*` proofs, **exercise** runs one secret-free job on the base-merged candidate, **publish** reports via the `ciRun`-bound [CI producer](deployment.md#ci-producer); queue tips too, cached. Manual proofs stay producer sessions.

## Post-deployment smoke proof

With `"deploySmoke": true` the master dispatches the smoke install once the release serves the merge; failure marks it [delivered with failure](operations-reference.md#delivered-with-a-failed-smoke-proof).

## Enforcement boundary

GitHub merges only heads whose required check passed; restrict other merge identities; a lease-losing worker can still push.

## Identity-bound agent review

`reviewProvider: "codex"` accepts only Codex's clean result on the exact head. `agent` requires a registered reviewer App distinct from the author (`github-setup URL --reviewer claude`, listed in `GRAPHYARD_REVIEWER_APPS`), adopted with `graphyard reviewpolicy GY-N agent REVISION "reason" --profiles` [FILE](../examples/reviewer-profiles.json). It replies an approved `graphyard-verdict` comment naming the head; `verdict:usage-limit` or silence fails over.
