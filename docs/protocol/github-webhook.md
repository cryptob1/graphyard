<!-- page: Agent protocol | 5 | webhook and dispatch records. -->
# GitHub webhook and review providers

`POST /api/github/webhook` verifies GitHub's HMAC (no bearer), deduplicates deliveries and wakes durable jobs; payloads never pass gates.

`POST /api/work/:id/reviewpolicy` (`admin`; operator agent with `policy:review-provider`) takes `{"provider":"codex"|"github"|"agent","expectedPolicyRevision":1,"reason":…}`, bumping the policy revision; `agent` also needs ordered `reviewerProfiles` (`name`, `runtime`, `reviewerApp`; optional `mention`, `timeoutSeconds`).

## Reads that are not repeated

- **Immutable:** SHA commits and compares, cached once in `github_cache`; oldest-read rows age out past 20,000 rows or 128 MB (64 MB in memory; over 1 MB memory-only, over 8 MB uncached).
- **Per cycle:** base ref every 15 s (restarted by a base push or own ref write); branch rules every 5 min or on a protection, ruleset or `repository` event.
- **Webhooks:** pull request, review, check and `push` events claim items first on any replica, skipping polls within the interval.

## Automatic dispatch records

`autoDispatch` records each [automatic dispatch](../master-agent.md#automatic-dispatch-at-submit) request (`producers`/`review`): `id`, `kind`, `sha`, `baseSha`, `policyRevision`, `pr`, `requestedAt`, `reason`, `state`. Approval/trusted evidence → `satisfied`; head, base or policy change, rework, closed PR → `cancelled`. Transitions append `dispatch.requested`/`dispatch.satisfied`/`dispatch.cancelled`; resolved ones move to `autoDispatch.history`. No gate moves.
