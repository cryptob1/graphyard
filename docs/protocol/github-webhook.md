<!-- page: Agent protocol | 5 | webhook, dispatch. -->
# GitHub webhook

`POST /api/github/webhook` verifies HMAC, deduplicates deliveries, wakes durable jobs for [observation](#reads-that-are-not-repeated); payloads never pass gates.

`POST /api/work/:id/reviewpolicy` (`admin`; operator agents with `policy:review-provider`): `{"provider":"codex"|"github"|"agent","expectedPolicyRevision":1,"reason":…}`, bumping policy revision; `agent` needs ordered `reviewerProfiles` (`name`, `runtime`, `reviewerApp`; optional `mention`, `timeoutSeconds`).

## Reads that are not repeated

Commits and exact-SHA compares cache once (`github_cache`); a SHA pair's questions (ancestry, commits, landing diff, changed files) read one first page (`?per_page=100&page=1`): base move: one compare per open candidate. Base ref: once per 15 s per replica; protection, rulesets: 5-minutely or on events. `pull_request`, `pull_request_review`, `check_run`, `check_suite`, `push` webhooks claim items first; polls they cover skip (`poll skipped: a webhook refreshed this item`). A base push wakes only open items overlapping its files or with last `mergeable_state` not `CLEAN`/`UNSTABLE` (all, if payload names no files; `unit:merge-burst-request-budget`).

## Prioritized wakes

`POST /api/work/:id/resync` with `prioritized: true` is claimed like webhook wake; loop wakes add `wait: false`, answering without a reconcile tick. A rework decision on a stale observation sends one, deciding from its result (any age; candidate head; no GitHub pause); decisions the candidate moved past are withdrawn. A rework dispatch refused with `Submitted PR branch changed` releases its claim via one, restarting from new head.

Decisions step budget: two fifths of `run.intervalSeconds`, ≥30 s; unreached items keep standing decisions, request nothing, show in `decisions:deferred`; both passes (rework; routine decisions, then attestations) resume them next cycle, always reaching first item even past budget.

## Automatic dispatch records

`autoDispatch` holds each [automatic dispatch](../master-agent.md#automatic-dispatch-at-submit) request, candidate-bound; transitions append `dispatch.requested`, `dispatch.satisfied` (approval or trusted evidence) or `dispatch.cancelled` (candidate changed); no gate moves.
