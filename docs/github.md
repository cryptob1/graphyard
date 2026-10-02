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

`graphyard master reviewer setup` creates it (Pull requests write, reads otherwise). Review tokens last one hour; `SLUG[bot]` approving the head satisfies both. Grants recheck every five minutes and 403s; a shortfall (`appPermissions`) holds jobs **not retried** (`integration-held`) until `master browser app-permissions` or `master browser installation-accept` fixes it.

## Require the check

On the base branch require `Graphyard / merge` from this App: `strict` **off**, admin-enforced, no force pushes or deletion; `master browser protection` reconciles it.

The gate requires `GITHUB_CI_APP_IDS` and protection-required checks, current-head approval, trusted passing evidence, a mergeable non-draft PR, the queue head or the [optimistic lane](#optimistic-merges).

## Merge queue

A failed required check reruns once on the unchanged head (its newest configured-CI-App run) before rework or ejection; an owed or accepted rerun lapses after 15 runless minutes; lacking Actions: write, preflight diagnoses it and rerun requests hold.

Once gated, the candidate's speculative tip, pushed onto the candidate branch and `refs/graphyard/queue/KEY`, binds every check, review and proof; a failed check, requested changes, revoked proof, conflict or rework ejects it back, one conflicting only with entries ahead of it re-enters unchanged once one lands or leaves. It passes the check for an authorized head and merge group, then merges through GitHub; protection decides; withdrawal dequeues; queueless `CLEAN`, `UNSTABLE`, `HAS_HOOKS` PRs merge at once, head-bound; `BLOCKED` auto-merge past ten minutes raises `merge-stalled` naming GitHub's blocker.

A tip failure a predecessor explains (its head fails too, or only it touches a named file) ejects that predecessor, not the entry.

### Bindings and carry

Reviews and proofs bind one head, base and policy revision. On moved bases all carry if the clean merge kept the patch-id, else the approval if no reviewed file changed, disjoint-`scopeFiles` proofs. A republication reads the PR's reviews before force-pushing: the replaced tip's approval carries onto a Graphyard-authored tip over the same author head and patch, the App's own dismissal restoring; never a person's, a moved head or a changed patch.

Before merging, the reviewer App re-posts a carried approval onto the tip: a carried review missing from the PR re-posts the bound reviewer's latest approval of the tip's reviewed head (`review.carry-refreshed`). With none usable the merge reports `mergerefused`: the control plane clears the carried approval (`mergeRefusal.action: rereview`), the review gate requests a fresh review, and the entry yields the head to the next until a fresh approval re-enters. The same refusal on consecutive cycles past 10 minutes raises an attention naming reason and next step; the loop acts itself, clearing a carried approval or requesting the rework decision (`mergeRefusal.action: rework`), which an approver judges in the high [risk lane](how-graphyard-works.md#risk-lanes) and which is applied as requested in low or medium. Each action fires once per recovery phase, a re-bound carry a phase of its own: never retried for good.

### Parallel tips

`mergeQueue.parallelTips` (master config, default 4, `POST /api/merge-queue`) stacked tips test at once; entries merge in order once every tip through theirs passes, each publication waking successors, re-reading in-flight verdicts. Each entry validates on its own tip: one CI duration covers four default positions, costing concurrent CI and a discarded suffix on failure; `parallelTips: 1` restores batching. A failing tip ejects its entry once those ahead pass; later tips rebuild. A tip failing only `unit:docs-word-budget` ejects the entry whose docs change crossed the budget — the first at which the running total exceeds it — and the refusal names the words over and the pages that grew; the entries ahead of it fit and still merge. The word budget itself is never a merge gate (see [development](development.md#documentation)): a total over it warns.

### Optimistic merges

`mergeQueue.optimistic` (default on): a green entry disjoint from base changes and shared infrastructure lands head-bound, unqueued; a main guard [reverts](master-agent.md#repair-lane) and reopens culprits (`master status`: `optimisticMerge`). Shared infrastructure is the master config's `mergeQueue.optimisticExclude` globs, product defaults (manifests, lockfiles, CI config, test helpers, migrations), so an excluded path never merges optimistically, nor anything whose base changed one since its run; `optimistic: false` turns the lane off.

### Proofs in CI

A protected `pull_request_target` workflow runs on every `graphyard/*` push: **plan** finds the item's `unit:*`/`integration:*` proofs, **exercise** runs one secret-free job on the base-merged candidate, **publish** reports via the `ciRun`-bound [CI producer](deployment.md#ci-producer), queue tips cached. Manual proofs stay producer sessions.

## Post-deployment smoke proof

With `"deploySmoke": true` the master dispatches the smoke install once the release serves the merge; failure marks it [delivered with failure](operations-reference.md#delivered-with-a-failed-smoke-proof).

## Enforcement boundary

GitHub merges only heads whose required check passed; restrict other merge identities; a lease-losing worker can still push.

## Identity-bound agent review

`reviewProvider: "codex"` accepts only Codex's clean result on the exact head; `agent` requires a registered reviewer App distinct from the author (`github-setup URL --reviewer claude`, listed in `GRAPHYARD_REVIEWER_APPS`), adopted with `graphyard reviewpolicy GY-N agent REVISION "reason" --profiles` [FILE](../examples/reviewer-profiles.json), replying an approved `graphyard-verdict` comment naming the head.
