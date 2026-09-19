<!-- page: Build integrations | 1 | roles, requests, work commands, leases, workspaces, evidence, and the webhook, one topic per page. -->
# Agent protocol and HTTP API

All control-plane endpoints except `/healthz` require `Authorization: Bearer TOKEN`. Use HTTPS for remote machines. API credentials are not Git credentials.

The protocol is documented one topic per page. The index below is generated from the pages under `docs/protocol/` by `npm run docs:check -- --write`; add a page there with a `<!-- page: ... -->` line and regenerate.

<!-- index: docs/protocol | Agent protocol -->

## Agent protocol

1. [Roles and credentials](protocol/roles.md) — bearer authentication and what each credential role may do.
2. [Requests and retries](protocol/requests.md) — idempotency keys, replay semantics, and the error contract.
3. [Read endpoints](protocol/read-endpoints.md) — status, work snapshots, events, delegation, and proof authority reads.
4. [Work commands](protocol/work-commands.md) — creating work and every `POST /api/work/UUID/COMMAND` mutation.
5. [Leases and supervision](protocol/leases.md) — lease renewal, `watch` supervision, foreground containment, and rework.
6. [Automatic containment settlement](protocol/containment-settlement.md) — how a coordinator proves a dead supervisor and settles its quarantine.
7. [Workspaces](protocol/workspaces.md) — worktree registration, branch and path uniqueness, and the launch fence.
8. [Submit-time regression guard](protocol/regression-guard.md) — how submit classifies every changed file against `plannedFiles` and refuses out-of-scope regressions.
9. [Evidence and proof authority](protocol/evidence.md) — evidence submission, proof authority grants, and the post-deployment smoke proof.
10. [Deployment observations](protocol/deployment-observations.md) — recording deployment-provider observations that feed flow analytics without moving a gate.
11. [Bootstrap mode for a change that introduces its own proof harness](protocol/bootstrap-mode.md) — deferring a proof onto the contract the change introduces, and the obligation it leaves.
12. [GitHub webhook and review providers](protocol/github-webhook.md) — webhook verification, review-provider changes, re-review, and the work snapshot.
13. [Validation runner and delivery APIs](protocol/validation-and-delivery.md) — where the validation runner and release delivery APIs are documented.
14. [Supervised shutdown invariants](protocol/shutdown-invariants.md) — what the supervisor guarantees before, during, and after a contained launch.
15. [Merge-queue bindings and carry](protocol/merge-queue-binding.md) — how a candidate is bound to its base, when the merge queue carries a review or proof across a Graphyard-authored tip, and what the record and ledger say about it.
<!-- /index -->
