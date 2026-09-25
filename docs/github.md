<!-- page: Operate Graphyard | 2 | the App, protection, the merge queue, CI proofs. -->
# GitHub enforcement

The installer-created GitHub App observes the repository and publishes **`Graphyard / merge`** on the exact PR head.

## App permissions

Every permission is declared once in `src/github-permissions.ts`. The control-plane App holds:

| Permission | Access | Needed to |
| --- | --- | --- |
| Administration | Read | inspect branch protection (pull request observation) |
| Checks | Read and write | read CI check runs (pull request observation); publish `Graphyard / merge` on the exact candidate commit (the required check) |
| Contents | Read and write | read commits, trees and pull request files (pull request observation); publish speculative merge-queue tips: the merge commit on the candidate branch and the `refs/graphyard/queue/*` ref that binds it (the merge queue) |
| Issues | Read | receive `issue_comment` webhooks carrying review results (comment webhooks) |
| Metadata | Read | read the managed repository (repository access) |
| Pull requests | Read and write | read pull requests and reviews (pull request observation); post review request comments (review dispatch) |

A reviewer App is never granted Contents: write, Checks, or Administration, and worker identities are not Apps at all. A reviewer App holds:

| Permission | Access | Needed to |
| --- | --- | --- |
| Contents | Read | read the code under review (pull request observation) |
| Issues | Read | follow `issue_comment` events on the reviewed pull request (comment webhooks) |
| Metadata | Read | read the managed repository (repository access) |
| Pull requests | Read and write | post the verdict comment (review dispatch) |

Granted permissions are compared with the declaration every five minutes and after any 403; a shortfall appears under `appPermissions` and the jobs needing it are **held, not retried** (`integration-held`). The master fixes them with `master browser app-permissions` and `master browser installation-accept`.

## The reviewer App

Review uses a separate reviewer App, created by `graphyard master reviewer setup` (Pull requests write, reads otherwise); binding refuses an installation that can write code. Each review session's token lasts one hour; an approval by `SLUG[bot]` on the exact head satisfies both GitHub and Graphyard.

## Require the check

On the base branch require `Graphyard / merge` bound to this App, leave "require up to date" (`strict`) **off**, enforce for administrators, forbid force pushes and deletion, and remove bypass rights from worker identities. `master browser protection` reconciles it. `graphyard master protection --apply` (and install) also writes the ruleset `Graphyard merge queue`: a GitHub merge queue on the base branch, one entry at a time, whose merge groups must pass `Graphyard / merge` from this App. Required CI workflows must also run on `merge_group`.

The gate also requires CI checks from Apps in `GITHUB_CI_APP_IDS`, an approval of the current head, trusted evidence with executed > 0 and skipped 0, a mergeable non-draft PR, and the queue head.

## Merge queue

A candidate enters once its gates pass. Its speculative tip (the predicted base merged into the candidate) is pushed onto the candidate branch and published under `refs/graphyard/queue/KEY`, and every check, review and proof must bind it. A failed check, requested changes, a revoked proof, a conflict or rework ejects the entry; once repaired it re-enters at the back. An entry leaving validation keeps its sequence but is passed over until revalidated.

### GitHub executes the merge

Graphyard gates; GitHub merges. When every gate passes and the master's merge step asks (`master run`, or `master merge`), the App publishes `Graphyard / merge` success on that exact head and enqueues the pull request in GitHub's merge queue, bound to the head by `expectedHeadOid` (auto-merge where the branch has no queue). While the entry waits, the App publishes the same verdict on the merge group commit. When authorization is withdrawn — a new head, a failing gate, a policy change — the App publishes failure on the head and dequeues it. GitHub performs the merge; the delivery is recorded from the merged observation's `merge_commit_sha`, attributed to the pre-merge record that shows every gate passed and the merge request for that head. No Graphyard code calls GitHub's merge endpoint. `master status` shows each queued item's GitHub queue state under `queue[].github`.

### Bindings and carry

Reviews and proofs bind one head, base and policy revision. When the base moves, reconciliation merges it into the branch; on that Graphyard-authored merge the approval carries if no reviewed file changed, and each proof if its `scopeFiles` are disjoint. CI always re-runs.

### Proofs in CI

A protected workflow runs on every push to a `graphyard/*` PR branch via `pull_request_target`, so workflow and secrets come from the default branch: **plan** finds the item's registered `unit:*` and `integration:*` proofs, **exercise** runs one secret-free job per proof against the candidate merged with its base, and **publish** submits each report through the [CI producer](deployment.md#ci-producer) with a `ciRun` binding. Queue tips get the same run; dependencies are cached. Manual proofs stay producer sessions.

## Post-deployment smoke proof

With `"deploySmoke": true` in the policy, the master dispatches the smoke workflow (`master init --smoke-workflow deploy-smoke.yml`) once the release serves the merge; `scripts/deploy-smoke.mjs` publishes `e2e:deploy-smoke`, and a failure marks the item [delivered with failure](operations-reference.md#delivered-with-a-failed-smoke-proof).

## Enforcement boundary

No transaction spans GitHub and Postgres: GitHub merges only a head whose required check the App published as passed, and the App fails the check and dequeues on withdrawal, observing an enqueued head every 20 seconds. A merge GitHub performs without a standing authorization and merge request is recorded as unauthorized. Restrict other merge identities; a worker can still push its own branch after losing its lease.

## Identity-bound agent review

`reviewProvider: "codex"` accepts only the Codex connector's clean result on the exact head. The `agent` provider requires a registered reviewer App distinct from the author (`github-setup URL --reviewer claude`, listed in `GRAPHYARD_REVIEWER_APPS`), adopted with `graphyard reviewpolicy GY-N agent REVISION "reason" --profiles` [FILE](../examples/reviewer-profiles.json). The reviewer replies with `<!-- graphyard-verdict:MARKER head:FULL_40_CHAR_SHA verdict:approved -->`; `verdict:usage-limit` or silence fails over to the next profile.
