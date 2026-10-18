<!-- page: Operate Graphyard | 2 | deploy key, observation. -->
# GitHub access

Graphyard install registers **no** GitHub App and writes **no** branch protection or ruleset (GY-2009). The merge writer's deploy key (read-write on OWNER/REPO) is the only GitHub credential install creates (a self-contained host gets a 0600 copy where its merge writer reads it, `<install>/<install>/deploy-key`, and clones over SSH with it); the control-plane trial (merge, build, typecheck, tests, secret scan) is the gate. The scan's pinned gitleaks is downloaded once into the managed root's `.secret-scan/`; a host that cannot obtain it, or a scan the deadline, a signal or the runner ends, gets no verdict (timeout or runner failure); only gitleaks' findings fail the merge.

## Deploy key

`install --apply` and `up`'s deploy-key step create `INSTALL_DIR/deploy-key` (ed25519, mode 0600) and register it as `graphyard-merge-writer-<host>` with write access. Re-runs are idempotent by fingerprint. The merge writer pushes base advances with that key alone.

## App permissions

Only an observation-only install that binds an App (`app bind`) uses one. Control-plane App (`src/github-permissions.ts`):

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

`master reviewer setup` creates it (Pull requests write; tokens last one hour); `SLUG[bot]` head approval satisfies both. Shortfalls (`appPermissions`; `github-setup --update-permissions` lists `Actions: write (failed CI reruns)`) hold jobs **not retried** (`integration-held`) until `master browser app-permissions` or `master browser installation-accept`.

## Binding a saved App

`app bind SLUG` needs a saved key (returned once); else generate one in its settings; `graphyard app import --app-id ID --key-file PEM [--role control-plane|reviewer|revert-approver] [--repo OWNER/NAME]` proves it, saves `0600` (`imported-app-SLUG.json`, install directory), refusing a control-plane App whose webhook serves another install; `graphyard app list` names imported roles.

Refused workflow syncs: `sync GY-N --push-via-control-plane COMMIT` (`POST /api/work/:id/sync-push`) pushes COMMIT fast-forwarded, merged with `origin/BASE` (`sync.workflow-push`).

## Require the check

Install never writes branch protection or rulesets. The merge writer's trial is the gate.

## Failed checks

Rework rules: [work commands](protocol/work-commands.md), [leases](protocol/leases.md). `master tip-cleanup --apply` deletes leftover `refs/graphyard/queue/*`.

### Bindings and carry

[Leases](protocol/leases.md), [webhook](protocol/github-webhook.md).

### Proofs in CI

Trusted producers still publish proof evidence. **plan** reads `/api/status` and `GET /api/work?pr=N` (never the work list) bounded by `planReads` (`scripts/enumerate-ci-proofs.mjs`), then finds `unit:*`/`integration:*` proofs; exercise and publish stay producer-side (no Actions PR gate).

## Identity-bound agent review

`reviewProvider`: `codex` takes Codex's clean head result; `agent` uses reviewer profiles (`graphyard reviewpolicy GY-N agent REVISION "reason" --profiles` [FILE](../examples/reviewer-profiles.json)); an observation-only install may bind a non-author reviewer App (`github-setup URL --reviewer claude`; `GRAPHYARD_REVIEWER_APPS`). The control-plane merger requires no reviewer App.
