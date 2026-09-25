<!-- page: Operate Graphyard | 2 | the App, protection, the merge queue, CI proofs. -->
# GitHub enforcement

The installer-created App observes the repository, publishing **`Graphyard / merge`** on the exact PR head.

## App permissions

The control-plane App holds (declared in `src/github-permissions.ts`):

| Permission | Access | Needed to |
| --- | --- | --- |
| Administration | Read | inspect branch protection (pull request observation) |
| Checks | Read and write | read CI check runs (pull request observation); publish `Graphyard / merge` on the exact candidate commit (the required check) |
| Contents | Read and write | read commits, trees and pull request files (pull request observation); publish speculative merge-queue tips: the merge commit on the candidate branch and the `refs/graphyard/queue/*` ref that binds it (the merge queue) |
| Issues | Read | receive `issue_comment` webhooks carrying review results (comment webhooks) |
| Metadata | Read | read the managed repository (repository access) |
| Pull requests | Read and write | read pull requests and reviews (pull request observation); post review request comments (review dispatch) |

A reviewer App is never granted Contents: write, Checks, or Administration, and worker identities are not Apps at all. It holds:

| Permission | Access | Needed to |
| --- | --- | --- |
| Contents | Read | read the code under review (pull request observation) |
| Issues | Read | follow `issue_comment` events on the reviewed pull request (comment webhooks) |
| Metadata | Read | read the managed repository (repository access) |
| Pull requests | Read and write | post the verdict comment (review dispatch) |

Grants are checked every five minutes and after any 403; a shortfall shows under `appPermissions` and its jobs are **held, not retried** (`integration-held`) until `master browser app-permissions` or `master browser installation-accept` fixes it.

## The reviewer App

Review uses a separate reviewer App, created by `graphyard master reviewer setup` (Pull requests write, reads otherwise); binding refuses an installation that can write code. Each review session's token lasts one hour; an approval by `SLUG[bot]` on the exact head satisfies both GitHub and Graphyard.

## Require the check

On the base branch require `Graphyard / merge` bound to this App, leave `strict` ("require up to date") **off**, enforce for administrators, forbid force pushes and deletion, and give workers no bypass. `master browser protection` reconciles it; `master protection --apply` also adds a merge queue requiring it (CI must run on `merge_group`).

The gate also requires CI checks from `GITHUB_CI_APP_IDS` Apps, current-head approval, trusted evidence (executed > 0, skipped 0), a mergeable non-draft PR, and the queue head.

## Merge queue

A candidate enters once its gates pass. Its speculative tip (predicted base merged in), pushed onto the candidate branch and `refs/graphyard/queue/KEY`, binds every check, review and proof. A failed check, requested changes, a revoked proof, a conflict or rework ejects the entry; repaired, it re-enters at the back. One conflicting only with entries ahead of it re-enters unchanged once one lands or leaves; one leaving validation is skipped until revalidated. Once requested, the App passes the check for an authorized head and its merge group, then asks GitHub to merge: queue, auto-merge, or (no queue, PR already mergeable) an immediate head-bound merge. Branch protection decides; withdrawal fails and dequeues it. Refusals (`merge.enqueue.refused`) show in `master status`.

### Bindings and carry

Reviews and proofs bind one head, base and policy revision. A moved base is merged into the branch; the approval carries if no reviewed file changed, each proof if its `scopeFiles` are disjoint. CI always re-runs.

### Proofs in CI

A protected `pull_request_target` workflow runs on every push to a `graphyard/*` PR branch, with workflow and secrets from the default branch: **plan** finds the item's registered `unit:*` and `integration:*` proofs, **exercise** runs one secret-free job per proof against the candidate merged with its base, and **publish** submits each report through the [CI producer](deployment.md#ci-producer) with a `ciRun` binding. Queue tips get the same run; dependencies are cached. Manual proofs stay producer sessions.

## Post-deployment smoke proof

With `"deploySmoke": true`, the master dispatches the smoke workflow (`master init --smoke-workflow deploy-smoke.yml`) once the release serves the merge; `scripts/deploy-smoke.mjs` publishes `e2e:deploy-smoke`, and a failure marks the item [delivered with failure](operations-reference.md#delivered-with-a-failed-smoke-proof).

## Enforcement boundary

No transaction spans GitHub and Postgres: GitHub merges only heads whose required check passed; Graphyard has no merge route. Restrict other merge identities; a worker can still push its own branch after losing its lease.

## Identity-bound agent review

`reviewProvider: "codex"` accepts only the Codex connector's clean result on the exact head. The `agent` provider requires a registered reviewer App distinct from the author (`github-setup URL --reviewer claude`, listed in `GRAPHYARD_REVIEWER_APPS`), adopted with `graphyard reviewpolicy GY-N agent REVISION "reason" --profiles` [FILE](../examples/reviewer-profiles.json). The reviewer replies with `<!-- graphyard-verdict:MARKER head:FULL_40_CHAR_SHA verdict:approved -->`; `verdict:usage-limit` or silence fails over to the next profile.
