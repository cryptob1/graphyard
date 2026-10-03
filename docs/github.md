<!-- page: Operate Graphyard | 2 | App, protection, queue, proofs. -->
# GitHub enforcement

## App permissions

Control-plane App (`src/github-permissions.ts`):

| Permission | Access | Needed to |
| --- | --- | --- |
| Actions | Read and write | rerun failed workflow jobs on the unchanged candidate (failed CI reruns) |
| Administration | Read | inspect branch protection (pull request observation) |
| Checks | Read and write | read CI check runs (pull request observation); publish `Graphyard / merge` and `graphyard/landable` on the exact candidate commit (the required checks) |
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

`graphyard master reviewer setup` creates it (Pull requests write, reads otherwise); review tokens last one hour; `SLUG[bot]` approving the head satisfies both. Shortfalls (`appPermissions`) hold jobs, **not retried** (`integration-held`), until `master browser app-permissions` or `master browser installation-accept`.

## Require the check

Require `Graphyard / merge` and `graphyard/landable` ([landability](coordination.md)) from the control-plane App on base: `strict` **off**, admin-enforced, no force push or deletion (`master protection --apply`, `master browser protection` reconcile). Needs: green `GITHUB_CI_APP_IDS` and protection-required checks, current-head approval, trusted passing evidence, mergeable non-draft PR, queue head or [optimistic lane](#optimistic-merges). GitHub merges only heads it passed; restrict other merge identities (lease-less workers still push).

## Merge queue

A failed required check reruns once on the unchanged head (newest configured-CI-App run) before rework or ejection.

Once gated, a speculative tip pushed onto the candidate branch once and `refs/graphyard/queue/KEY` binds every check, review and proof; failure, requested changes, revoked proof, conflict or rework ejects it; one conflicting only with entries ahead of it re-enters unchanged once one lands or leaves. Authorized heads and merge groups pass the check and merge through GitHub (protection decides). Queueless `CLEAN`/`UNSTABLE`/`HAS_HOOKS` PRs merge at once, head-bound; `BLOCKED` auto-merge past ten minutes raises `merge-stalled` naming GitHub's blocker.

### Bindings and carry

Reviews/proofs bind head, base, policy revision. Moved base: all carry if the clean merge kept the patch-id, else the approval if no reviewed file changed, plus disjoint-`scopeFiles` proofs. On republication, the replaced tip's approval carries onto a Graphyard-authored tip of the same author head and patch; never a person's, a moved head or changed patch.

Before merging, the reviewer App re-posts a carried approval onto the tip: a carried review missing from the PR re-posts the latest approval of the tip's reviewed head (`review.carry-refreshed`). With none usable, the merge reports `mergerefused`: the control plane clears the carried approval (`mergeRefusal.action: rereview`) and requests a fresh review at once. Repeated refusals past 10 minutes raise attention; the loop clears carried approvals or requests rework (`mergeRefusal.action: rework`), judged in the high risk lane and applied in low/medium.

### Parallel tips

`mergeQueue.parallelTips` (master config, default 4; `POST /api/merge-queue`): stacked per-entry tips test concurrently (`parallelTips: 1` batches). Entries merge in order once all tips through theirs pass; a failing tip ejects its entry once those ahead pass; later tips rebuild. Failing only `unit:docs-word-budget` ejects the first entry whose running total exceeds the budget, naming words over and pages grown; otherwise the budget only warns ([development](development.md#documentation)).

### Optimistic merges

`mergeQueue.optimistic` (default on; `optimistic: false` disables): green entries disjoint from base changes land head-bound, unqueued, unless they (or base since their run) touched shared infrastructure (`mergeQueue.optimisticExclude` globs plus manifests, lockfiles, CI config, test helpers, migrations). A main guard [reverts](master-agent.md#repair-lane) and reopens culprits (`master status`: `optimisticMerge`).

### Pre-merge gate and release-candidate validation

Required: `typecheck`, `test` (`.github/workflows/ci.yml`: build, docs check, Node and browser suites), under ten minutes. Soak/timing-budget files, container acceptance/recovery and the Helm chart run only in `.github/workflows/release-candidate.yml`, on one pinned SHA (`sha` input or pushed `rc-*` tag).

### Proofs in CI

Protected `pull_request_target` workflow per `graphyard/*` push: **plan** finds the item's `unit:*`/`integration:*` proofs; **exercise** runs one secret-free job on the base-merged candidate; **publish** reports via the `ciRun`-bound [CI producer](deployment.md#ci-producer). Queue tips are cached. Manual proofs stay producer sessions.

`"deploySmoke": true` dispatches the smoke install once the release serves the merge; failure marks it [delivered with failure](operations-reference.md#delivered-with-a-failed-smoke-proof).

## Identity-bound agent review

`reviewProvider: "codex"` accepts only Codex's clean result on the exact head. `agent` needs a non-author reviewer App (`github-setup URL --reviewer claude`; `GRAPHYARD_REVIEWER_APPS`), adopted by `graphyard reviewpolicy GY-N agent REVISION "reason" --profiles` [FILE](../examples/reviewer-profiles.json); approving via `graphyard-verdict` comment naming the head.
