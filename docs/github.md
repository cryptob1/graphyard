<!-- page: Operate Graphyard | 2 | App, protection, merge queue, CI proofs. -->
# GitHub enforcement

## App permissions

The control-plane App — publishing **`Graphyard / merge`** on the PR head — holds (`src/github-permissions.ts`):

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

Grants are rechecked every five minutes and after 403s; a shortfall (`appPermissions`) holds its jobs, **not retried** (`integration-held`), until `master browser app-permissions` or `master browser installation-accept` fixes it.

## The reviewer App

`graphyard master reviewer setup` creates it (Pull requests write, other reads); binding refuses a writer. Review tokens last one hour; `SLUG[bot]` approving the exact head satisfies both.

## Require the check

On the base branch require `Graphyard / merge` bound to this App, `strict` **off**, enforce for administrators, forbid force pushes and deletion, workers get no bypass (the [repair lane](master-agent.md#repair-lane)). `master browser protection` reconciles it; `master protection --apply`, `install --apply` and `init --scan --apply` give organization repositories a merge queue requiring it (CI on `merge_group`), user-owned ones or a 422 `allow_auto_merge`.

The gate also requires CI checks from `GITHUB_CI_APP_IDS` Apps, current-head approval, trusted evidence (executed > 0, skipped 0), a mergeable non-draft PR, and the queue head. Unknown mergeability (`null`) is re-read 3 times in 10 s, then refused as computing; queued tips decide.

## Merge queue

A candidate enters once its gates pass. Its speculative tip (predicted base merged in), pushed onto the candidate branch and `refs/graphyard/queue/KEY`, binds every check, review and proof. A failed check, requested changes, revoked proof, conflict or rework ejects it to re-enter at the back. One conflicting only with entries ahead of it re-enters unchanged once one lands or leaves; one leaving validation is skipped until revalidated. The App passes the check for an authorized head and its merge group, then asks GitHub to merge (queue, auto-merge or [direct](#direct-merges)); protection decides; withdrawal fails and dequeues. `master status` names refusals `merge.enqueue.refused`.

### Bindings and carry

Reviews and proofs bind one head, base and policy revision. The head's tip merges moved bases: all carry if the clean merge kept the patch-id, else the approval if no reviewed file changed, disjoint-`scopeFiles` proofs. Carried steps name their ground; CI reruns. Conflicts are test-merged; clean ones log `base.stale-mergeability`.

### Batches

`mergeQueue.batchSize` (master config, default 4; 1 disables; published via `POST /api/merge-queue`) tests entries together: a pass merges members in order, a failure is halved until the culprit is ejected, naming its check (`mergeStep`); batches behind an unpassed one eject nothing. A head batch `testing` with no published tip over ten minutes dissolves; members validate singly (`queue.batch-dissolved`) until one leaves.

### Direct merges

Without a queue, mergeable `CLEAN`, `UNSTABLE` (optional checks failing) and `HAS_HOOKS` PRs merge at once, head-bound; five minutes pending is `merge-stalled`.

### Proofs in CI

A protected `pull_request_target` workflow (the default branch's, with secrets) runs on every `graphyard/*` push: **plan** finds the item's `unit:*`/`integration:*` proofs, **exercise** runs one secret-free job on the candidate merged with its base, **publish** reports via the [CI producer](deployment.md#ci-producer) bound by `ciRun`. Queue tips too; dependencies are cached. Manual proofs stay producer sessions.

## Post-deployment smoke proof

`"deploySmoke": true` dispatches `master init --smoke-workflow deploy-smoke.yml` once the release serves it; `scripts/deploy-smoke.mjs` publishes `e2e:deploy-smoke`; a failure marks it [delivered with failure](operations-reference.md#delivered-with-a-failed-smoke-proof).

## Enforcement boundary

GitHub merges only heads whose required check passed; Graphyard has no merge route; restrict other merge identities; a worker that lost its lease can push.

## Identity-bound agent review

`reviewProvider: "codex"` accepts only a clean Codex result on the head. `agent` requires a registered reviewer App distinct from the author (`github-setup URL --reviewer claude`, listed in `GRAPHYARD_REVIEWER_APPS`), adopted with `graphyard reviewpolicy GY-N agent REVISION "reason" --profiles` [FILE](../examples/reviewer-profiles.json). It replies `<!-- graphyard-verdict:MARKER head:FULL_40_CHAR_SHA verdict:approved -->`; `verdict:usage-limit` or silence fails over.
