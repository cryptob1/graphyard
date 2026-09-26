<!-- page: Agent protocol | 5 | webhook and dispatch records. -->
# GitHub webhook and review providers

`POST /api/github/webhook` verifies GitHub's HMAC instead of a bearer token, deduplicates deliveries and wakes durable jobs; a payload never marks a gate passed.

`POST /api/work/:id/reviewpolicy` (`admin`, or an operator agent with `policy:review-provider`) takes `{"provider":"codex"|"github"|"agent", "expectedPolicyRevision":1, "reason":…}`, bumping the policy revision; `agent` also needs ordered `reviewerProfiles` (`name`, `runtime`, `reviewerApp`, optional `mention` and `timeoutSeconds`).

## Automatic dispatch records

At the build gate `autoDispatch` records one `producers` request per proof group and, once unit and integration proofs pass, a `review` request, each with `id`, `kind`, `sha`, `baseSha`, `policyRevision`, `pr`, `requestedAt`, `reason` and `state`. A request is `satisfied` by an approval or trusted evidence, `cancelled` when the head, base or policy changes, rework is requested or the PR closes; transitions append `dispatch.requested`, `dispatch.satisfied` or `dispatch.cancelled`, and resolved requests move to `autoDispatch.history`. Nothing here moves a gate.
