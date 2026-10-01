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

`graphyard master reviewer setup` creates it (Pull requests write; review tokens last one hour); `SLUG[bot]` approving the head satisfies both. Grants recheck every five minutes and on 403s; shortfalls (`appPermissions`) hold jobs **not retried** (`integration-held`) until `master browser app-permissions` or `master browser installation-accept`.

## Require the check

Require this App's `Graphyard / merge` on the base: `strict` **off**, admin-enforced, no force pushes or deletion (`master browser protection` reconciles). It needs `GITHUB_CI_APP_IDS` checks, current-head approval, trusted passing evidence, a mergeable non-draft PR, and queue head or [optimistic lane](#optimistic-merges). Restrict other merge identities; a lease-losing worker can still push.

## Merge queue

A gated candidate's speculative tip, pushed onto the candidate branch and `refs/graphyard/queue/KEY`, binds checks, reviews and proofs. A check failing [its rerun](operations-reference.md#flaky-ci-check), requested changes, revoked proof, conflict or rework ejects it; one conflicting only with entries ahead of it re-enters unchanged once one lands or leaves. The check also passes merge groups; withdrawal dequeues; queueless `CLEAN`/`UNSTABLE`/`HAS_HOOKS` PRs merge at once, head-bound.

### Bindings and carry

Reviews and proofs bind head, base and policy revision. On a moved base a kept patch-id carries all, else the approval (no reviewed file changed) and disjoint-`scopeFiles` proofs. Republishing before force-push carries the replaced tip's approval onto a Graphyard-authored tip of the same author head and patch (restoring the App's observed own dismissal), never a person's.

Before merging, the reviewer App re-posts carried approvals missing from the PR (the bound reviewer's latest for the reviewed head; a newer one re-binds: `review.carry-refreshed`). With none usable, `mergerefused` clears the carry (`mergeRefusal.action: rereview`) and requests review, yielding the head until a fresh approval. Refusals over consecutive cycles past 10 minutes raise attention (reason, next step); the loop clears the carry or requests approver-judged rework (`mergeRefusal.action: rework`) once per recovery phase (a re-bound carry starts one), never retried.

### Parallel tips

`mergeQueue.parallelTips` (master config or `POST /api/merge-queue`; default 4, `1` batches) tips, one entry each, test within one CI duration. Entries merge in order once every tip through theirs passes; publications wake successors to re-read in-flight verdicts. A failing tip ejects its entry once those ahead pass; later tips rebuild. Failing only `unit:docs-word-budget` ejects the first entry over budget, naming words over and pages grown; [the budget](development.md#documentation) itself only warns.

### Optimistic merges

With `mergeQueue.optimistic` (default `true`) a green entry lands head-bound, unqueued, unless it overlaps base changes or it (or its base since its run) touched shared infrastructure: `mergeQueue.optimisticExclude` globs plus defaults (manifests, lockfiles, CI config, test helpers, migrations). A main guard [reverts](master-agent.md#repair-lane) and reopens culprits (`master status`: `optimisticMerge`).

### Proofs in CI

Each `graphyard/*` push runs a protected `pull_request_target` workflow: **plan** (`unit:*`/`integration:*` proofs), **exercise** (one secret-free job on the base-merged candidate), **publish** (via the `ciRun`-bound [CI producer](deployment.md#ci-producer)); queue tips cached. Manual proofs stay producer sessions.

## Smoke proof

`"deploySmoke": true` runs the smoke install once the release serves the merge; failure marks it [delivered with failure](operations-reference.md#delivered-with-a-failed-smoke-proof).

## Identity-bound agent review

`reviewProvider: "codex"` accepts only Codex's clean exact-head result. `agent` needs a reviewer App other than the author's (`github-setup URL --reviewer claude`, listed in `GRAPHYARD_REVIEWER_APPS`), adopted with `graphyard reviewpolicy GY-N agent REVISION "reason" --profiles` [FILE](../examples/reviewer-profiles.json); it replies an approved `graphyard-verdict` comment naming the head.
