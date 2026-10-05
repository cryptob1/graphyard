<!-- page: Agent protocol | 5 | webhook and dispatch records. -->
# GitHub webhook and review providers

`POST /api/github/webhook` verifies GitHub's HMAC (no bearer token), deduplicates deliveries and wakes durable jobs, driving [observation and the shared reads](#reads-that-are-not-repeated); a payload never marks a gate passed.

`POST /api/work/:id/reviewpolicy` (`admin`, or operator agent with `policy:review-provider`) takes `{"provider":"codex"|"github"|"agent", "expectedPolicyRevision":1, "reason":…}` and bumps the policy revision; `agent` needs ordered `reviewerProfiles` (`name`, `runtime`, `reviewerApp`, optional `mention`, `timeoutSeconds`).

## Reads that are not repeated

- **Immutable:** commits by SHA and exact-SHA compares, fetched once into `github_cache`; least recently read rows age out past 20,000 rows or 128 MB (memory: 64 MB of text; over 1 MB memory-only, over 8 MB uncached).
- **Per cycle:** base ref once per 15 s (restarted by a base push or own ref write); protection and branch rules (required checks) every 5 min or on a protection, ruleset or `repository` event.
- **Webhooks:** `pull_request`, `pull_request_review`, `check_run`, `check_suite` and `push` (branch pushes too) claim items first on any replica; a poll within a webhook-driven observation's interval is skipped (`poll skipped: a webhook refreshed this item`).

## Prioritized wakes

A guarded merge refused for ten minutes is reworked or re-reviewed (GY-831), except a refusal standing only on a missing or stale observation, every other gate passing. That candidate keeps its queue position: the loop sends `POST /api/work/:id/resync` with `prioritized: true`, recorded as a `refresh` action and repeated at most once per two-minute window while the refusal stands. A prioritized wake, and the wake of a merge request's enqueue, is claimed like a webhook's, oldest first.

### Stale observations hold the queue

A stale observation is a fact about the observer, not the candidate: it holds the queue and never ejects from it. The same hold covers a merge gate whose other reasons are only the entry's queue position, protection no observation has verified yet, or mergeability GitHub is still computing, and a guarded merge refused only because its authorization lapsed with the observation's age (`Merge authorization is no longer current`). None records a `rework` or `rereview` merge refusal: the entry keeps its position and approval, and merges on the first attempt after a fresh observation is saved.

While merge-band observations are stale, `master status` shows one `observation-health:` attention line instead of a refusal per entry or band. It names how many merge-band entries wait, the oldest observation's age, the entries, and the server-side causes the status read carries: reconciliation tick time when the server reports it, deferred observations, jobs refused on a database deadlock or lock timeout, starved jobs, and worker throughput. The entries need nothing; the causes are the server's to clear.

## Automatic dispatch records

`autoDispatch` records each [automatic dispatch](../master-agent.md#automatic-dispatch-at-submit) as a `producers` or `review` request with `id`, `kind`, `sha`, `baseSha`, `policyRevision`, `pr`, `requestedAt`, `reason` and `state`. An approval or trusted evidence makes it `satisfied`; a head, base or policy change, rework or a closed PR makes it `cancelled`. Transitions append `dispatch.requested`, `dispatch.satisfied` or `dispatch.cancelled`; resolved requests move to `autoDispatch.history`. Nothing here moves a gate.
