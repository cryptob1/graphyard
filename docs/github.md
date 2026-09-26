<!-- page: Operate Graphyard | 2 | App, protection, merge queue, CI proofs. -->
# GitHub enforcement

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

Grants are rechecked every five minutes and on a 403; a shortfall (`appPermissions`) holds its jobs, **not retried** (`integration-held`), until `master browser app-permissions` or `master browser installation-accept` fixes it.

## The reviewer App

`graphyard master reviewer setup` creates it (Pull requests write, reads otherwise). Review tokens last one hour; `SLUG[bot]` approving the head satisfies both.

## Require the check

On the base branch require `Graphyard / merge` bound to this App, `strict` **off**, admin-enforced, force pushes and deletion forbidden, workers without bypass (the App's [repair lane](master-agent.md#repair-lane)); `master browser protection` reconciles it. `master protection --apply`, `install --apply`, `init --scan --apply` give organization repositories a merge queue requiring it (CI on `merge_group`), user-owned ones, a 422 `allow_auto_merge`.

The gate requires `GITHUB_CI_APP_IDS` CI checks, protection's required checks (failures request rework), current-head approval, trusted passing evidence, a mergeable non-draft PR and the queue head. Unknown mergeability (`null`) is re-read 3 times in 10 s, then refused as computing; queued tips decide.

## Merge queue

Once gated, a candidate's speculative tip (predicted base merged in), pushed onto the candidate branch and `refs/graphyard/queue/KEY`, binds every check, review and proof. A failed check, requested changes, a revoked proof, a conflict or rework ejects it to the back. One conflicting only with entries ahead of it re-enters unchanged once one lands or leaves; one leaving validation is skipped until revalidated. The App passes the check for an authorized head and merge group and asks GitHub to merge (queue, auto-merge or [direct](#direct-merges)); protection decides; withdrawal fails and dequeues; `master status` names `merge.enqueue.refused`.

### Bindings and carry

Reviews and proofs bind one head, base and policy revision. The queue head's tip merges moved bases: all carry if the clean merge kept the patch-id, else the approval if no reviewed file changed, disjoint-`scopeFiles` proofs. A republication reads the PR's reviews before force-pushing: an approval of the replaced tip carries onto a Graphyard-authored tip over the same author head and patch (GY-519), and the App's own dismissal (patch unchanged) restores when observed — never a person's dismissal, moved author head or changed patch. Carried steps name their ground, carries and restores the review id and both tips; CI reruns. GitHub conflicts are test-merged; clean ones log `base.stale-mergeability`.

### Batches

`mergeQueue.batchSize` (master config, default 4; 1 disables; published via `POST /api/merge-queue`) tests entries together: a pass merges members in order, a failure halves it until the culprit is ejected; batches behind an unpassed one eject nothing.

### Direct merges

Without a queue, `CLEAN`, `UNSTABLE` and `HAS_HOOKS` PRs merge at once, head-bound; five minutes pending, or `BLOCKED` auto-merge ten (naming why), is `merge-stalled`.

### Proofs in CI

A protected `pull_request_target` workflow (the default branch's) runs on every `graphyard/*` push: **plan** finds the item's `unit:*`/`integration:*` proofs, **exercise** runs one secret-free job on the candidate merged with its base, **publish** submits reports via the `ciRun`-bound [CI producer](deployment.md#ci-producer); queue tips too, dependencies cached. Manual proofs stay producer sessions.

## Post-deployment smoke proof

With `"deploySmoke": true`, the master dispatches `master init --smoke-workflow deploy-smoke.yml` once the release serves the merge; `scripts/deploy-smoke.mjs` publishes `e2e:deploy-smoke`; failure marks it [delivered with failure](operations-reference.md#delivered-with-a-failed-smoke-proof).

## Enforcement boundary

GitHub merges only heads whose required check passed; Graphyard has no merge route; restrict other merge identities; a lease-losing worker can still push.

## Identity-bound agent review

`reviewProvider: "codex"` accepts only Codex's clean result on the exact head. `agent` requires a registered reviewer App distinct from the author (`github-setup URL --reviewer claude`, listed in `GRAPHYARD_REVIEWER_APPS`), adopted with `graphyard reviewpolicy GY-N agent REVISION "reason" --profiles` [FILE](../examples/reviewer-profiles.json). It replies `<!-- graphyard-verdict:MARKER head:FULL_40_CHAR_SHA verdict:approved -->`; `verdict:usage-limit` or silence fails over.
