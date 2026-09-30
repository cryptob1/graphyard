<!-- page: Agent protocol | 5 | webhook and dispatch records. -->
# GitHub webhook and review providers

`POST /api/github/webhook` verifies GitHub's HMAC (no bearer token), deduplicates deliveries and wakes durable jobs, driving [observation and the shared reads](../operations-reference.md#reads-that-are-not-repeated); a payload never marks a gate passed.

`POST /api/work/:id/reviewpolicy` (`admin`, or operator agent with `policy:review-provider`) takes `{"provider":"codex"|"github"|"agent", "expectedPolicyRevision":1, "reason":…}` and bumps the policy revision; `agent` needs ordered `reviewerProfiles` (`name`, `runtime`, `reviewerApp`, optional `mention`, `timeoutSeconds`).

## Automatic dispatch records

`autoDispatch` records each [automatic dispatch](../master-agent.md#automatic-dispatch-at-submit) as a `producers` or `review` request with `id`, `kind`, `sha`, `baseSha`, `policyRevision`, `pr`, `requestedAt`, `reason` and `state`. An approval or trusted evidence makes it `satisfied`; a head, base or policy change, rework or a closed PR makes it `cancelled`. Transitions append `dispatch.requested`, `dispatch.satisfied` or `dispatch.cancelled`; resolved requests move to `autoDispatch.history`. Nothing here moves a gate.
