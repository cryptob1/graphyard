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

Grants are checked every five minutes and after a 403; a shortfall shows under `appPermissions`, its jobs **held, not retried** (`integration-held`) until `master browser app-permissions` or `master browser installation-accept` fixes it.

## The reviewer App

`graphyard master reviewer setup` creates it (Pull requests write, reads otherwise); binding refuses one that can write code. Review tokens last one hour; `SLUG[bot]`'s approval of the exact head satisfies GitHub and Graphyard.

## Require the check

On the base branch require `Graphyard / merge` bound to this App, leave `strict` **off**, enforce for administrators, forbid force pushes and deletion, give workers no bypass. `master browser protection` reconciles it; `master protection --apply`, `install --apply` and `init --scan --apply` give organization repositories a merge queue requiring it (CI on `merge_group`), user-owned ones or a 422 `allow_auto_merge`.

Gates also require `GITHUB_CI_APP_IDS` CI checks and base-branch protection's (failures request rework), current-head approval, trusted evidence (executed > 0, skipped 0), a mergeable non-draft PR, and the queue head.

## Merge queue

A candidate enters once its gates pass. Its speculative tip (predicted base merged in), pushed onto the candidate branch and `refs/graphyard/queue/KEY`, binds every check, review and proof. A failed check, requested changes, a revoked proof, a conflict or rework ejects the entry; repaired, it re-enters at the back. One conflicting only with entries ahead of it re-enters unchanged once one lands or leaves; one leaving validation is skipped until revalidated. Once requested, the App passes the check on an authorized head and merge group, then asks GitHub to merge (queue, auto-merge or [direct](#direct-merges)). Withdrawal fails and dequeues it. `master status` shows `merge.enqueue.refused`.

### Bindings and carry

Reviews and proofs bind one head, base and policy revision. The queue head's tip merges moved bases: all carry if the clean merge kept the patch-id, else the approval if no reviewed file changed, disjoint-`scopeFiles` proofs. Carried steps name their ground; CI reruns. GitHub conflicts are test-merged; clean ones log `base.stale-mergeability`.

### Batches

`mergeQueue.batchSize` (master config, default 4; 1 disables; published via `POST /api/merge-queue`) tests entries together; members merge in order if it passes, else halving ejects the culprit, naming its check (`mergeStep`); batches behind an unpassed one eject nothing.

### Direct merges

Without a queue, mergeable `CLEAN`, `UNSTABLE` (optional checks failing) and `HAS_HOOKS` PRs merge at once, head-bound; one pending five minutes, or `BLOCKED` auto-merge ten (naming why), is `merge-stalled`.

### Proofs in CI

A protected `pull_request_target` workflow (default-branch workflow and secrets) runs on every `graphyard/*` PR push: **plan** finds the item's `unit:*` and `integration:*` proofs, **exercise** runs one secret-free job each against the candidate merged with its base, **publish** submits reports via the [CI producer](deployment.md#ci-producer) bound by `ciRun`. Queue tips too; dependencies are cached. Manual proofs stay producer sessions.

## Post-deployment smoke proof

With `"deploySmoke": true`, the master dispatches `master init --smoke-workflow deploy-smoke.yml` once the release serves the merge; `scripts/deploy-smoke.mjs` publishes `e2e:deploy-smoke`; a failure marks it [delivered with failure](operations-reference.md#delivered-with-a-failed-smoke-proof).

## Enforcement boundary

GitHub merges only heads whose required check passed; Graphyard has no merge route. Restrict other merge identities; a worker losing its lease can still push.

## Identity-bound agent review

`reviewProvider: "codex"` accepts only Codex's clean result on the exact head. `agent` requires a registered reviewer App distinct from the author (`github-setup URL --reviewer claude`, listed in `GRAPHYARD_REVIEWER_APPS`), adopted with `graphyard reviewpolicy GY-N agent REVISION "reason" --profiles` [FILE](../examples/reviewer-profiles.json). It replies `<!-- graphyard-verdict:MARKER head:FULL_40_CHAR_SHA verdict:approved -->`; `verdict:usage-limit` or silence fails over.
