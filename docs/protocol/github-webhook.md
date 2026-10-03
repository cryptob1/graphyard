<!-- page: Agent protocol | 5 | webhook and dispatch records. -->
# GitHub webhook and review providers

`POST /api/github/webhook` verifies GitHub's HMAC (no bearer token), deduplicates deliveries and wakes durable jobs, driving [observation and the shared reads](#reads-that-are-not-repeated); a payload never marks a gate passed.

`POST /api/work/:id/reviewpolicy` (`admin`, or operator agent with `policy:review-provider`) takes `{"provider":"codex"|"github"|"agent", "expectedPolicyRevision":1, "reason":…}` and bumps the policy revision; `agent` needs ordered `reviewerProfiles` (`name`, `runtime`, `reviewerApp`, optional `mention`, `timeoutSeconds`).

## Reads that are not repeated

- **Immutable:** commits by SHA and exact-SHA compares, fetched once into `github_cache`; least recently read rows age out past 20,000 rows or 128 MB (memory: 64 MB of text; over 1 MB memory-only, over 8 MB uncached).
- **Per cycle:** base ref once per 15 s per replica (restarted by a base push it receives or its own ref write or GraphQL merge; guards read fresh); protection and branch rules (required checks) every 5 min or on a protection, ruleset or `repository` event.
- **Webhooks:** `pull_request`, `pull_request_review`, `check_run`, `check_suite` and `push` (branch pushes too) claim items first on any replica; a poll made due early within a webhook-driven observation's interval is skipped (`poll skipped: a webhook refreshed this item`) unless the item has since entered the merge band; wakes are claimed oldest delivery first.

## Automatic dispatch records

`autoDispatch` records each [automatic dispatch](../master-agent.md#automatic-dispatch-at-submit) as a `producers` or `review` request with `id`, `kind`, `sha`, `baseSha`, `policyRevision`, `pr`, `requestedAt`, `reason` and `state`. An approval or trusted evidence makes it `satisfied`; a head, base or policy change, rework or a closed PR makes it `cancelled`. Transitions append `dispatch.requested`, `dispatch.satisfied` or `dispatch.cancelled`; resolved requests move to `autoDispatch.history`. Nothing here moves a gate.
