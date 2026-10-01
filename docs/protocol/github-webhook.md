<!-- page: Agent protocol | 5 | webhook, dispatch. -->
# GitHub webhook and review providers

`POST /api/github/webhook` verifies GitHub's HMAC (no bearer token), deduplicates deliveries and wakes durable jobs; a payload never passes a gate.

`POST /api/work/:id/reviewpolicy` (`admin`, or an operator agent with `policy:review-provider`) takes `{"provider":"codex"|"github"|"agent", "expectedPolicyRevision":1, "reason":…}`, bumping the policy revision; `agent` also needs ordered `reviewerProfiles` (`name`, `runtime`, `reviewerApp`, optional `mention` and `timeoutSeconds`).

## Automatic dispatch records

`autoDispatch` records each [automatic dispatch](../master-agent.md#automatic-dispatch-at-submit) as a `producers` or `review` request with `id`, `kind`, `sha`, `baseSha`, `policyRevision`, `pr`, `requestedAt`, `reason` and `state`. A request is `satisfied` by an approval or trusted evidence, `cancelled` when the head, base or policy changes, rework is requested or the PR closes; transitions append `dispatch.requested`, `dispatch.satisfied` or `dispatch.cancelled`, and resolved requests move to `autoDispatch.history`, never moving a gate.
