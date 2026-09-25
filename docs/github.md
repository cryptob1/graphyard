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

A reviewer App never gets Contents: write, Checks or Administration; workers are not Apps. It holds:

| Permission | Access | Needed to |
| --- | --- | --- |
| Contents | Read | read the code under review (pull request observation) |
| Issues | Read | follow `issue_comment` events on the reviewed pull request (comment webhooks) |
| Metadata | Read | read the managed repository (repository access) |
| Pull requests | Read and write | post the verdict comment (review dispatch) |

Grants are checked every five minutes and after a 403; a shortfall (`appPermissions`) holds its jobs until `master browser app-permissions` or `master browser installation-accept` fixes it.

## The reviewer App

`graphyard master reviewer setup` creates it (Pull requests write, reads otherwise); binding refuses an installation that can write code. A review session's token lasts one hour; an approval by `SLUG[bot]` on the exact head satisfies GitHub and Graphyard.

## Require the check

On the base branch require `Graphyard / merge` bound to this App, leave `strict` **off**, enforce for administrators, forbid force pushes and deletion, give workers no bypass. `master browser protection` reconciles it; `master protection --apply` also adds a merge queue requiring it (CI must run on `merge_group`).

The gate also needs `GITHUB_CI_APP_IDS` CI checks, approval of the head, trusted evidence (executed > 0, skipped 0), a mergeable PR and the queue head.

## Merge queue

A candidate enters once its gates pass. Its speculative tip is pushed onto the candidate branch and `refs/graphyard/queue/KEY`; every check, review and proof binds it. A failed check, requested changes, a revoked proof, a conflict or rework ejects it to re-enter at the back once repaired. The App passes the check for an authorized head and merge group, then asks GitHub to merge; withdrawal dequeues it; refusals (`merge.enqueue.refused`) show in status.

### Bindings and carry

Reviews and proofs bind one head, base and policy revision. Across a conflict-free Graphyard merge of a moved base, all carry while the change's own diff keeps its patch-id, even where the base edited the same files; otherwise the approval carries if no reviewed file changed, each proof if its `scopeFiles` are disjoint. Carried steps show their ground. CI always re-runs.

### Batches

`mergeQueue.batchSize` (master config, default 4, 1 disables; published via `POST /api/merge-queue`) groups entries under one combined tip, the last member's. Only the tip under test needs CI; members merge in order once a tip holding them passes. A failing batch is halved until the entry failing after a passing prefix is ejected, naming the check. Status shows it as `mergeStep`, a Merge substate.

### Proofs in CI

A protected `pull_request_target` workflow runs on every push to a `graphyard/*` PR branch with default-branch workflow and secrets: **plan** finds the item's `unit:*` and `integration:*` proofs, **exercise** runs one secret-free job each against the candidate merged with its base, **publish** submits each report through the [CI producer](deployment.md#ci-producer) with a `ciRun` binding. Queue tips get the same run; dependencies are cached. Manual proofs stay producer sessions.

## Post-deployment smoke proof

With `"deploySmoke": true`, the master dispatches the smoke workflow (`master init --smoke-workflow deploy-smoke.yml`) once the release serves the merge; it publishes `e2e:deploy-smoke`, and a failure marks the item [delivered with failure](operations-reference.md#delivered-with-a-failed-smoke-proof).

## Enforcement boundary

No transaction spans GitHub and Postgres: GitHub merges only heads whose required check passed, and Graphyard has no merge route. Restrict other merge identities; a worker can still push its branch after losing its lease.

## Identity-bound agent review

`reviewProvider: "codex"` accepts only the Codex connector's clean result on the head. `agent` requires a registered reviewer App distinct from the author (`github-setup URL --reviewer claude`, listed in `GRAPHYARD_REVIEWER_APPS`), adopted with `graphyard reviewpolicy GY-N agent REVISION "reason" --profiles` [FILE](../examples/reviewer-profiles.json). It replies `<!-- graphyard-verdict:MARKER head:FULL_40_CHAR_SHA verdict:approved -->`; `verdict:usage-limit` or silence fails over to the next profile.
