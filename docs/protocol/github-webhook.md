<!-- page: Agent protocol | 5 | webhook and dispatch records. -->
# GitHub webhook and review providers

`POST /api/github/webhook` verifies GitHub's HMAC (no bearer token), deduplicates deliveries and wakes durable jobs, driving [observation and the shared reads](#reads-that-are-not-repeated); a payload never marks a gate passed.

`POST /api/work/:id/reviewpolicy` (`admin`, or operator agent with `policy:review-provider`) takes `{"provider":"codex"|"github"|"agent", "expectedPolicyRevision":1, "reason":…}` and bumps the policy revision; `agent` needs ordered `reviewerProfiles` (`name`, `runtime`, `reviewerApp`, optional `mention`, `timeoutSeconds`).

## Reads that are not repeated

- **Immutable:** commits by SHA and exact-SHA compares, fetched once into `github_cache`; least recently read rows age out past 20,000 rows or 128 MB (memory: 64 MB of text; over 1 MB memory-only, over 8 MB uncached).
- **Per cycle:** base ref once per 15 s (restarted by a base push or own ref write); protection and branch rules (required checks) every 5 min or on a protection, ruleset or `repository` event.
- **Webhooks:** `pull_request`, `pull_request_review`, `check_run`, `check_suite` and `push` (branch pushes too) claim items first on any replica; a poll within a webhook-driven observation's interval is skipped (`poll skipped: a webhook refreshed this item`).

## Base moves

A push to the base branch (each merge into main) wakes at once only the open items it can affect: those whose pull-request files overlap the files the push changed, and those whose last reading GitHub did not report `CLEAN` or `UNSTABLE` — `BLOCKED` (awaiting review or a required check), `BEHIND`, `DIRTY`, `UNKNOWN`, any other state, or never read. The state is GitHub's `mergeable_state`, recorded on each observation from the pull request read it already makes. A `CLEAN` or `UNSTABLE` item touching none of the pushed files keeps its cadence; the queue's head band is observed every 20 s anyway. A push whose files the payload cannot name (forced, no commits listed, or 20 commits, GitHub's truncation) wakes every item; so does a `refs/graphyard/*` move.

The request budget per merge is those wakes: a woken item's next reading pays for the new base (its pull request and compares, about 3 requests, plus the base ref and rules once per merge), while unchanged reads are free 304s. Ten merges in ten minutes over 80 open items, half of them `BLOCKED`, stay under 1500 requests (`unit:merge-burst-request-budget`); waking every item on each merge spent the App's hour and, on 2026-10-05, paused GitHub requests for 34 minutes.

## Prioritized wakes

A guarded merge refused for ten minutes is reworked or re-reviewed (GY-831), except a refusal standing only on a missing or stale observation, every other gate passing. That candidate keeps its queue position: the loop sends `POST /api/work/:id/resync` with `prioritized: true`, recorded as a `refresh` action and repeated at most once per two-minute window while the refusal stands. A prioritized wake, and the wake of a merge request's enqueue, is claimed like a webhook's, oldest first. A rework decision waiting on a stale observation sends the same prioritized wake, once, and is decided from the observation it brings in while that still shows the submitted head and is under 15 minutes old: a two-minute bound alone expired before any interval over two minutes could read it.

## Automatic dispatch records

`autoDispatch` records each [automatic dispatch](../master-agent.md#automatic-dispatch-at-submit) as a `producers` or `review` request with `id`, `kind`, `sha`, `baseSha`, `policyRevision`, `pr`, `requestedAt`, `reason` and `state`. An approval or trusted evidence makes it `satisfied`; a head, base or policy change, rework or a closed PR makes it `cancelled`. Transitions append `dispatch.requested`, `dispatch.satisfied` or `dispatch.cancelled`; resolved requests move to `autoDispatch.history`. Nothing here moves a gate.
