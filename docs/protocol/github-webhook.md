<!-- page: Agent protocol | 5 | webhook, dispatch. -->
# GitHub webhook

`POST /api/github/webhook` verifies GitHub's HMAC, deduplicates deliveries and wakes durable jobs for [observation](#reads-that-are-not-repeated); payloads never pass gates.

`POST /api/work/:id/reviewpolicy` (`admin`; operator agent with `policy:review-provider`): `{"provider":"codex"|"github"|"agent", "expectedPolicyRevision":1, "reason":…}`, bumping the policy revision; `agent` needs ordered `reviewerProfiles` (`name`, `runtime`, `reviewerApp`; optional `mention`, `timeoutSeconds`).

## Reads that are not repeated

Commits and exact-SHA compares are cached once (`github_cache`); every question about one SHA pair reads one first page (`?per_page=100&page=1`); the base ref is read once per 15 s per replica, protection and rulesets every 5 min or on their events. `pull_request`, `pull_request_review`, `check_run`, `check_suite` and `push` webhooks claim items first, and a poll they cover is skipped. A base push wakes only open items whose files overlap it or whose last `mergeable_state` was not `CLEAN`/`UNSTABLE`.

## Prioritized wakes

`POST /api/work/:id/resync` with `prioritized: true` is claimed like a webhook wake; the loop's wakes add `wait: false`, so the route answers without waiting for a reconcile tick. A rework decision waiting on a stale observation sends one such wake and decides from the observation it brought in, provided it reads the candidate head and no GitHub pause stands; a decision the candidate moved past is withdrawn. A rework dispatch refused because its PR branch moved releases its claim with a prioritized wake, so the next dispatch starts from the new head.

The loop's decisions step has a budget (two fifths of `run.intervalSeconds`, at least 30 s); items not reached keep their standing decisions and are requested first next cycle (`decisions:deferred`).

## Automatic dispatch records

`autoDispatch` holds each [automatic dispatch](../master-agent.md#automatic-dispatch-at-submit) request bound to its candidate; transitions append `dispatch.requested`, `dispatch.satisfied` (approval or trusted evidence) or `dispatch.cancelled` (candidate changed); no gate moves.
