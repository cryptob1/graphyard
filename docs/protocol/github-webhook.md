<!-- page: Agent protocol | 5 | webhook, dispatch. -->
# GitHub webhook

`POST /api/github/webhook` verifies HMAC, deduplicates deliveries, wakes durable jobs for [observation](#reads-that-are-not-repeated); payloads never pass gates. Verified deliveries never 5xx: those waking nothing return 202, logging `ignored`, delivery ID, event: `startup validation`/`wake failed` (unreceipted; polling covers), `own check`, `duplicate delivery`, `no subject`, `no open job`. Auth/repository refusals: 4xx/503.

`POST /api/work/:id/reviewpolicy` (`admin`; `policy:review-provider`): `{"provider":"codex"|"github"|"agent","expectedPolicyRevision":1,"reason":…}`; `agent` needs ordered `reviewerProfiles` (`name`, `runtime`, `reviewerApp`; optional `mention`, `timeoutSeconds`).

## Reads that are not repeated

Commits and exact-SHA compares cache once (`github_cache`); SHA-pair questions (ancestry, commits, landing diff, files) read one first page; base move: one compare per open candidate. Base ref: once/15 s/replica; protection, rulesets: 5-minutely or on events. `pull_request`, `pull_request_review`, `check_run`, `check_suite`, `push` claim first; covered polls skip (`poll skipped: a webhook refreshed this item`). Base push wakes open items overlapping its files or with last `mergeable_state` not `CLEAN`/`UNSTABLE` (all if no files; `unit:merge-burst-request-budget`).

## Prioritized wakes

`POST /api/work/:id/resync` with `prioritized: true` is claimed like webhook wake; loop wakes add `wait: false`. Rework on a stale observation sends one (any age; candidate head; no GitHub pause); decisions the candidate moved past are withdrawn. A rework dispatch refused with `Submitted PR branch changed` releases its claim via one, restarting from new head.

Decisions step budget: two fifths of `run.intervalSeconds`, ≥30 s; unreached items keep standing decisions, show in `decisions:deferred`; passes (rework; routine, then attestations) resume next cycle, always reaching first item past budget.

## Automatic dispatch records

`autoDispatch` holds each [automatic dispatch](../master-agent.md#automatic-dispatch-at-submit) request, candidate-bound; transitions append `dispatch.requested`, `dispatch.satisfied` (approval or trusted evidence) or `dispatch.cancelled` (candidate changed); no gate moves.
