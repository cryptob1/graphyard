<!-- page: Agent protocol | 5 | webhook and dispatch records. -->
# GitHub webhook and review providers

`POST /api/github/webhook` verifies GitHub's HMAC, deduplicates deliveries and wakes durable jobs for [observation](#reads-that-are-not-repeated); payloads never pass gates.

`POST /api/work/:id/reviewpolicy` (`admin`; operator agent with `policy:review-provider`): `{"provider":"codex"|"github"|"agent", "expectedPolicyRevision":1, "reason":…}`, bumping the policy revision; `agent` needs ordered `reviewerProfiles` (`name`, `runtime`, `reviewerApp`; optional `mention`, `timeoutSeconds`).

## Reads that are not repeated

Commits and exact-SHA compares are cached once (`github_cache`); the base ref is read once per 15 s per replica, protection and rulesets every 5 min or on their events. `pull_request`, `pull_request_review`, `check_run`, `check_suite` and `push` webhooks claim items first; a poll they cover is skipped (`poll skipped: a webhook refreshed this item`).

A base push wakes only open items whose files overlap it or whose last `mergeable_state` was not `CLEAN`/`UNSTABLE` (all when the payload names no files; `unit:merge-burst-request-budget`).

## Prioritized wakes

A merge refused only for a stale observation keeps its queue place: the loop sends `POST /api/work/:id/resync` with `prioritized: true` (at most every two minutes), claimed like a webhook wake. A rework decision waiting on a stale observation sends one such wake and decides from its observation while under 15 minutes old.

## Automatic dispatch records

`autoDispatch` holds each [automatic dispatch](../master-agent.md#automatic-dispatch-at-submit) request bound to its candidate; transitions append `dispatch.requested`, `dispatch.satisfied` (approval or trusted evidence) or `dispatch.cancelled` (candidate changed); no gate moves.
