<!-- page: Operate Graphyard | 2 | App, protection, failed checks, proofs. -->
# GitHub enforcement

## App permissions

Control-plane App (`src/github-permissions.ts`):

| Permission | Access | Needed to |
| --- | --- | --- |
| Actions | Read and write | rerun failed workflow jobs on the unchanged candidate (failed CI reruns) |
| Administration | Read | inspect branch protection (pull request observation) |
| Checks | Read and write | read CI check runs (pull request observation); publish `Graphyard / merge` and `graphyard/landable` on the exact candidate commit (the required checks) |
| Contents | Read and write | read commits, trees and pull request files (pull request observation); push base refreshes and main-guard revert branches onto the managed repository (branch refresh) |
| Deployments | Read | read the deployments the hosting provider reports to production (production observation) |
| Issues | Read | receive `issue_comment` webhooks carrying review results (comment webhooks) |
| Metadata | Read | read the managed repository (repository access) |
| Pull requests | Read and write | read pull requests and reviews (pull request observation); post review request comments (review dispatch) |
| Workflows | Read and write | push base syncs carrying the base's workflow changes (workflow sync) |

A reviewer App is never granted Contents: write, Checks, or Administration; worker identities are not Apps at all. It holds:

| Permission | Access | Needed to |
| --- | --- | --- |
| Contents | Read | read the code under review (pull request observation) |
| Issues | Read | follow `issue_comment` events on the reviewed pull request (comment webhooks) |
| Metadata | Read | read the managed repository (repository access) |
| Pull requests | Read and write | post the verdict comment (review dispatch) |

`graphyard master reviewer setup` creates it (Pull requests write, reads otherwise); review tokens last one hour; `SLUG[bot]` approving the head satisfies both. Shortfalls (`appPermissions`) hold jobs, **not retried** (`integration-held`), until `master browser app-permissions` or `master browser installation-accept`, which the loop runs itself on a stalled row ([bound remedies](coordination.md#ship-in-under-thirty-minutes)).

## Workflow base syncs

Worker tokens carry `contents`, `pull_requests` and `workflows` write ([push credential](protocol/leases.md#push-credential)). If GitHub refuses a base sync, `sync GY-N --push-via-control-plane COMMIT` has the control plane push (`POST /api/work/:id/sync-push`) a COMMIT that fast-forwards the branch and merges `origin/BASE` (`sync.workflow-push`).

## Require the check

Require `Graphyard / merge` and `graphyard/landable` ([landability](coordination.md)) from the control-plane App on base: `strict` **off**, admin-enforced, no force push or deletion (`master protection --apply`, `master browser protection` reconcile). Needs: green `GITHUB_CI_APP_IDS` and protection-required checks, current-head approval, mergeable non-draft PR; GitHub merges a head that passes them ([one delivery path](delivery.md#one-delivery-path)) and only those; restrict other merge identities (lease-less workers still push).

## Failed checks

There is no Graphyard merge queue: GitHub merges each candidate whose checks and approval pass on its head ([one delivery path](delivery.md#one-delivery-path)). `master tip-cleanup --apply` deletes the `refs/graphyard/queue/*` tips an earlier release left. A failed required check is rerun once in place on the unchanged head (`mergeQueue.rerunFailedChecks`, 0 disables); a second failure fails the test gate and returns the item for rework. A check failing only tests (`graphyard-failed-tests:`) its old base broke and the base tip fixed refreshes onto the tip (`baseBreak`), not rework.

### Bindings and carry

Reviews and proofs bind head, base and policy revision. On a moved base all carry if the clean merge kept the patch-id; else the approval carries if no reviewed file changed, and disjoint-`scopeFiles` proofs carry. Graphyard re-posts no carried approval and requests no merge, so branch protection alone decides whether the approvals on the head suffice.

### Proofs in CI

Protected `pull_request_target` workflow per `graphyard/*` push: **plan** finds the item's `unit:*`/`integration:*` proofs; **exercise** runs one secret-free job on the base-merged candidate; **publish** reports via the `ciRun`-bound [CI producer](deployment.md#ci-producer). Dependencies, the database image and candidate layers are cached. Manual proofs stay producer sessions.

`"deploySmoke": true` dispatches the smoke install once the release serves the merge; failure marks it [delivered with failure](operations-reference.md#delivered-with-a-failed-smoke-proof).

## Identity-bound agent review

`reviewProvider: "codex"` accepts Codex's clean result on the exact head; `agent` needs a non-author reviewer App (`github-setup URL --reviewer claude`; `GRAPHYARD_REVIEWER_APPS`), adopted by `graphyard reviewpolicy GY-N agent REVISION "reason" --profiles` [FILE](../examples/reviewer-profiles.json); approving via `graphyard-verdict` comment naming the head.
