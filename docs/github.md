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

Grants are checked every five minutes and after a 403; a shortfall (`appPermissions`) holds its jobs until `master browser app-permissions` or `master browser installation-accept` fixes it.

## The reviewer App

`graphyard master reviewer setup` creates it (Pull requests write, reads otherwise); binding refuses an installation that can write code. Review tokens last one hour; an approval by `SLUG[bot]` on the exact head satisfies GitHub and Graphyard.

## Require the check

On the base branch require `Graphyard / merge` bound to this App, leave `strict` **off**, enforce for administrators, forbid force pushes and deletion, give workers no bypass. `master browser protection` reconciles it; `master protection --apply`, `install --apply` and `init --scan --apply` give organization repositories a merge queue requiring it (CI on `merge_group`), user-owned ones or a 422 `allow_auto_merge`.

The gate also needs `GITHUB_CI_APP_IDS` CI checks, head approval, trusted evidence (executed > 0, skipped 0), a mergeable non-draft PR and the queue head.

## Merge queue

A candidate enters once its gates pass. Its speculative tip is pushed onto the candidate branch and `refs/graphyard/queue/KEY`; checks, reviews and proofs bind it. A failed check, requested changes, revoked proof, conflict or rework ejects it; repaired, it re-enters at the back; one conflicting only with entries ahead of it re-enters unchanged once one lands or leaves. The App passes the check for an authorized head and merge group and asks GitHub to merge; withdrawal dequeues; refusals (`merge.enqueue.refused`) show in status.

### Bindings and carry

Reviews and proofs bind one head, base and policy revision. Across a conflict-free Graphyard merge of a moved base, all carry while the change's own diff keeps its patch-id, even where the base edited those files; otherwise the approval carries if no reviewed file changed, each proof if its `scopeFiles` are disjoint. Carried steps name their ground; CI always re-runs.

### Batches

`mergeQueue.batchSize` (master config, default 4, 1 disables; published via `POST /api/merge-queue`) groups entries under one combined tip; only it needs CI; members merge in order once a containing tip passes. A failing batch is halved until its failing entry is ejected, naming the check. Status shows it as the Merge substate `mergeStep`.

### Proofs in CI

A protected `pull_request_target` workflow runs on every push to a `graphyard/*` PR branch with default-branch workflow and secrets: **plan** finds the item's `unit:*` and `integration:*` proofs, **exercise** runs one secret-free job each against the candidate merged with its base, **publish** submits each report through the [CI producer](deployment.md#ci-producer) with a `ciRun` binding. Queue tips get the same run; dependencies are cached. Manual proofs stay producer sessions.

## Post-deployment smoke proof

With `"deploySmoke": true`, the master dispatches the smoke workflow (`master init --smoke-workflow deploy-smoke.yml`) once the release serves the merge; it publishes `e2e:deploy-smoke`, and a failure marks the item [delivered with failure](operations-reference.md#delivered-with-a-failed-smoke-proof).

## Enforcement boundary

GitHub merges only heads whose required check passed; Graphyard has no merge route. Restrict other merge identities; a worker can still push after losing its lease.

## Identity-bound agent review

`reviewProvider: "codex"` accepts only the Codex connector's clean result on the head. `agent` requires a registered reviewer App distinct from the author (`github-setup URL --reviewer claude`, listed in `GRAPHYARD_REVIEWER_APPS`), adopted with `graphyard reviewpolicy GY-N agent REVISION "reason" --profiles` [FILE](../examples/reviewer-profiles.json). It replies `<!-- graphyard-verdict:MARKER head:FULL_40_CHAR_SHA verdict:approved -->`; `verdict:usage-limit` or silence fails over to the next profile.
