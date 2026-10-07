<!-- page: Operate Graphyard | 2 | App, protection. -->
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

`graphyard master reviewer setup` creates it (Pull requests write, reads otherwise); review tokens last one hour. Shortfalls (`appPermissions`) hold jobs until `master browser app-permissions` or `master browser installation-accept`, which the loop runs on a stalled row ([remedies](coordination.md#ship-in-under-thirty-minutes)); `graphyard github-setup --update-permissions` lists what is missing.

Worker tokens carry `contents`, `pull_requests` and `workflows` write ([push credential](protocol/leases.md#push-credential)); if GitHub refuses a base sync, `sync GY-N --push-via-control-plane COMMIT` has the control plane push it (`POST /api/work/:id/sync-push`).

## Require the check

Require `Graphyard / merge` and `graphyard/landable` ([landability](coordination.md)) from the control-plane App on base: `strict` **off**, admin-enforced, no force push or deletion (`master protection --apply`, `master browser protection` reconcile). GitHub merges a head with green `GITHUB_CI_APP_IDS` checks and a current-head approval ([one delivery path](delivery.md#one-delivery-path)).

## Failed checks

There is no merge queue (`master tip-cleanup --apply` deletes leftover `refs/graphyard/queue/*` tips). A failed required check is rerun once on the unchanged head (`mergeQueue.rerunFailedChecks`, 0 disables); a second failure returns the item for rework, and a check failing only tests the base tip fixed refreshes onto the tip.

### Bindings and carry

Reviews and proofs bind head, base and policy revision; on a moved base all carry if the clean merge kept the patch-id, else the approval carries if no reviewed file changed and disjoint-`scopeFiles` proofs carry. Branch protection alone judges the head's approvals.

### Proofs in CI

Protected `pull_request_target` workflow per `graphyard/*` push: **plan** finds the item's `unit:*`/`integration:*` proofs; **exercise** runs one secret-free job on the base-merged candidate; **publish** reports via the `ciRun`-bound [CI producer](deployment.md#ci-producer). Dependencies, the database image and candidate layers are cached. Manual proofs stay producer sessions. `"deploySmoke": true` runs the smoke install once the release serves the merge, else [delivered with failure](operations-reference.md#delivered-with-a-failed-smoke-proof).

## Identity-bound agent review

`reviewProvider: "codex"` accepts Codex's clean result on the exact head; `agent` needs a non-author reviewer App (`github-setup URL --reviewer claude`; `GRAPHYARD_REVIEWER_APPS`) adopted by `graphyard reviewpolicy GY-N agent REVISION "reason" --profiles` [FILE](../examples/reviewer-profiles.json).
