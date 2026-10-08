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

`master reviewer setup` creates it (Pull requests write; tokens last one hour); `SLUG[bot]` head approval satisfies both. Shortfalls (`appPermissions`; `github-setup --update-permissions` lists `Actions: write (failed CI reruns)`) hold jobs, **not retried** (`integration-held`), until `master browser app-permissions` or `master browser installation-accept`.

## Reusing an App without sudo

`--reuse-app SLUG` needs a key saved locally (GitHub returns it once). For an App created elsewhere, generate a key on its settings page, then `graphyard app import --app-id ID --key-file PEM [--role control-plane|reviewer|revert-approver] [--repo OWNER/NAME]` proves the key by an App JWT and saves the App `0600` as `imported-app-SLUG.json` in the install directory; a control-plane App whose webhook serves another install is refused. `graphyard app list` names each saved App's reusable roles or why not.

Refused workflow syncs: `sync GY-N --push-via-control-plane COMMIT` (`POST /api/work/:id/sync-push`) pushes COMMIT, fast-forwarding and merging `origin/BASE` (`sync.workflow-push`).

## Require the check

Require `Graphyard / merge`, `graphyard/landable` ([landability](coordination.md)) from control-plane App: `strict` **off**, admin-enforced, no force push/deletion (`master protection --apply`, `master browser protection`). GitHub merges only mergeable non-draft PRs whose approved head is green on `GITHUB_CI_APP_IDS` ([one delivery path](delivery.md#one-delivery-path)).

## Failed checks

Rework rules and the base-break exception: [work commands](protocol/work-commands.md), [leases](protocol/leases.md). `master tip-cleanup --apply` deletes leftover `refs/graphyard/queue/*`.

### Bindings and carry

Binding and carry rules: [leases](protocol/leases.md), [webhook](protocol/github-webhook.md).

### Proofs in CI

Protected `pull_request_target` workflow per `graphyard/*` push: **plan** finds `unit:*`/`integration:*` proofs; **exercise** runs one secret-free job on base-merged candidate; **publish** via `ciRun`-bound [CI producer](deployment.md#ci-producer). Layers cached. Manual proofs stay producer sessions. `"deploySmoke": true` smoke-installs once release serves merge; failure: [delivered with failure](operations-reference.md#delivered-with-a-failed-smoke-proof).

## Identity-bound agent review

`reviewProvider`: `codex` takes Codex's clean head result; `agent` non-author reviewer App (`github-setup URL --reviewer claude`; `GRAPHYARD_REVIEWER_APPS`; `graphyard reviewpolicy GY-N agent REVISION "reason" --profiles` [FILE](../examples/reviewer-profiles.json)) approving via head-naming `graphyard-verdict` comments.
