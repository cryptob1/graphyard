<!-- page: Operate Graphyard | 2 | the App, protection, the merge queue, CI proofs. -->
# GitHub enforcement

The installer's App publishes **`Graphyard / merge`** on the exact PR head.

## App permissions

The control-plane App holds (`src/github-permissions.ts`):

| Permission | Access | Needed to |
| --- | --- | --- |
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

Grants are rechecked every five minutes and after a 403; a shortfall (`appPermissions`) holds jobs, **not retried** (`integration-held`), until `master browser app-permissions` or `master browser installation-accept` repairs it.

## The reviewer App

`graphyard master reviewer setup` creates it (Pull requests write, reads otherwise); binding refuses one that writes code. Tokens last one hour; `SLUG[bot]` approving the head satisfies both.

## Require the check

On the base branch require `Graphyard / merge` bound to this App, `strict` **off**, enforced for administrators, force pushes and deletion forbidden, no worker bypass (the App's [repair lane](master-agent.md#repair-lane)). `master browser protection` reconciles it; `master protection --apply` gives organization repositories a merge queue (CI on `merge_group`), user-owned ones auto-merge.

The gate also requires CI from `GITHUB_CI_APP_IDS` Apps, current-head approval, trusted evidence (executed > 0, skipped 0), a mergeable non-draft PR and the queue head.

## Merge queue

A candidate enters once its gates pass. Its speculative tip (predicted base merged in), pushed onto the candidate branch and `refs/graphyard/queue/KEY`, binds checks, review and proof. A failed check, requested changes, revoked proof, conflict or rework ejects it, repaired. One conflicting only with entries ahead of it re-enters unchanged once one lands or leaves; one leaving validation is skipped until revalidated. The App passes the check for an authorized head and its merge group and asks GitHub to merge (queue, auto-merge or [direct](#direct-merges)); protection decides; withdrawal dequeues it and `master status` names refusals.

### Bindings and carry

Reviews and proofs bind one head, base and policy revision. The head's tip merges moved bases: all carry if the clean merge kept the patch-id, else the approval if no reviewed file changed, disjoint-`scopeFiles` proofs. Carried steps name their ground; CI reruns. Conflicts are test-merged; clean ones log `base.stale-mergeability`.

### Batches and parallel tips

`mergeQueue.batchSize` (master config, default 4; 1 disables; published via `POST /api/merge-queue`) groups the queue for the batch display; validation follows the parallel window below.

`mergeQueue.parallelTips` (master config, default 4; published like batchSize) validates that many positions at once: tip k is built on tip k-1 without waiting for its CI; an entry whose tip and every tip ahead passed merges once it heads the queue; a failing tip k ejects its entry, naming the passing tip behind it, and rebuilds only the tips after k. `master status` reports the window (`mergeQueue`); entries carry `queue.tips`.

### Direct merges

Without a queue, mergeable `CLEAN`, `UNSTABLE`, `HAS_HOOKS` PRs merge at once, head-bound; five minutes pending is `merge-stalled`.

### Proofs in CI

A protected `pull_request_target` workflow (the default branch's, with secrets) runs on every `graphyard/*` PR push: **plan**, **exercise** and **publish** find the item's `unit:*`/`integration:*` proofs, run one secret-free job each against the candidate plus base, and submit reports via the [CI producer](deployment.md#ci-producer) (`ciRun`); queue tips too. Dependencies are cached. Manual proofs stay producer sessions.

## Post-deployment smoke proof

`"deploySmoke": true` makes the master dispatch `master init --smoke-workflow deploy-smoke.yml` at the release; `scripts/deploy-smoke.mjs` publishes `e2e:deploy-smoke`; failure marks the delivery.

## Enforcement boundary

GitHub merges only heads whose required check passed; Graphyard has no merge route. Restrict other merge identities; a lease-lost worker can still push.

## Identity-bound agent review

`reviewProvider: "codex"` accepts only Codex's clean result on the exact head; `agent` requires a registered reviewer App not the author (`github-setup URL --reviewer claude`, in `GRAPHYARD_REVIEWER_APPS`), adopted with `graphyard reviewpolicy GY-N agent REVISION "reason" --profiles` [FILE](../examples/reviewer-profiles.json); `verdict:usage-limit` or silence fails over.
