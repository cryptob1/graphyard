<!-- page: Agent protocol | 5 | webhook and dispatch records. -->
# GitHub webhook and review providers

`POST /api/github/webhook` verifies GitHub's HMAC (no bearer), deduplicates deliveries and wakes durable jobs; payloads never pass gates.

`POST /api/work/:id/reviewpolicy` (`admin`; operator agent with `policy:review-provider`) takes `{"provider":"codex"|"github"|"agent","expectedPolicyRevision":1,"reason":…}`, bumping the policy revision; `agent` also needs ordered `reviewerProfiles` (`name`, `runtime`, `reviewerApp`; optional `mention`, `timeoutSeconds`).

## Automatic dispatch records

`autoDispatch` records each [automatic dispatch](../master-agent.md#automatic-dispatch-at-submit) request (`producers`/`review`): `id`, `kind`, `sha`, `baseSha`, `policyRevision`, `pr`, `requestedAt`, `reason`, `state`. Approval/trusted evidence → `satisfied`; head, base or policy change, rework, closed PR → `cancelled`. Transitions append `dispatch.requested`/`dispatch.satisfied`/`dispatch.cancelled`; resolved ones move to `autoDispatch.history`. No gate moves.
