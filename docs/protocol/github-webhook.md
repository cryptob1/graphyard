<!-- page: Agent protocol | 5 | webhook and dispatch records. -->
# GitHub webhook and review providers

`POST /api/github/webhook` verifies GitHub's HMAC (no bearer), deduplicates deliveries and wakes durable jobs, driving [observation and shared reads](#reads-that-are-not-repeated); payloads never pass gates.

`POST /api/work/:id/reviewpolicy` (`admin`; operator agent with `policy:review-provider`): `{"provider":"codex"|"github"|"agent", "expectedPolicyRevision":1, "reason":…}`, bumping the policy revision; `agent` needs ordered `reviewerProfiles` (`name`, `runtime`, `reviewerApp`; optional `mention`, `timeoutSeconds`).

## Reads that are not repeated

- **Immutable:** commits by SHA and exact-SHA compares, cached once in `github_cache`.
- **Per cycle:** base ref once per 15 s (restarted by a base push or own ref write); protection and rulesets every 5 min or on a protection, ruleset or `repository` event.
- **Webhooks:** `pull_request`, `pull_request_review`, `check_run`, `check_suite`, `push` claim items first on any replica; a poll within a webhook-driven observation's interval is skipped (`poll skipped: a webhook refreshed this item`).

## Prioritized wakes

A merge refusal standing only on a missing or stale observation keeps its queue position: the loop sends `POST /api/work/:id/resync` with `prioritized: true` (a `refresh` action, at most once per two minutes), claimed like a webhook's wake, oldest first.

## Automatic dispatch records

`autoDispatch` holds each [automatic dispatch](../master-agent.md#automatic-dispatch-at-submit) request bound to its candidate; transitions append `dispatch.requested`, `dispatch.satisfied` (approval or trusted evidence) or `dispatch.cancelled` (candidate changed); no gate moves.
