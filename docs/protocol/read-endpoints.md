<!-- page: Agent protocol | 2 | status, snapshots, events. -->
# Read endpoints

All `GET`:
- `/healthz`: unauthenticated.
- `/api/status`: principal, integrations, `appPermissions`, held/failed jobs, `githubBudget`, clock.
- `/api/github/installation` (coordinator): live installation and App permissions.
- `/api/work-snapshot`: `{work, now}` with `autoDispatch`; age leases against `now`. Settled deliveries are `summary: true` (no prose or histories). `view=coordination` trims open items; `view=full` exports all; other views page visible work by `cursor` (last number), `pageSize` (≤1000, default 100): `hasMore`, `nextCursor`.
- `/api/work/ID|KEY`: one whole document; `/api/work`: all.
- `/api/interventions?window=7|30|90`: that window's ledger rows (`ledger.since`).
- `/api/retro`: every retro artefact, newest first, and each registry's `standing` revision; `/api/retro/standing` (any role): applied entries only. `graphyard status GY-N` adds them as `retroStanding`, and `retroCatalogued` for gate refusals an applied catalogue entry recognises. `GET /api/interventions` marks such instances `catalogue` and tallies them in `catalogued`.
- `/api/events?work=UUID`: one item's events, newest first (`graphyard events GY-N --all` walks them); without `work`, the whole ledger, which operator agents may read only as approvers (read-only `decision:approve` over every item). `routine=include` adds `github.observed`/`heartbeat` rows; page by `limit` (default 300), `cursor` (last `seq`); filter by `kind`, `since`, `until`.
- `/api/analytics/flow`, `/api/analytics/attribution`: bounded. Flow days are UTC midnights to today, the first holding earlier time. `window.covered`/`window.kinds`: scan and per-kind reach; `throughput[].covered: false`: unread, not zero. Merged is Deploy; `stepDwell[].sparse` (n<5): marked, unsplit. Reports cache 60 s per window and filters; facts coalesce 10 s; deployments invalidate immediately.
- Interventions, flow, `/api/shipping-pulse`: 3-connection, 20s-timeout report pool.
- `/api/deployments`: `POST /api/deployments` observations (`producer`/`admin`; `succeeded`, `failed`, `rolled_back`; never gates).
- `/api/tests`, `/api/tests/ID/runs`: case results, paged history.
- `/api/delegation`, `/api/proof-grants`, `/api/delivery`: slices, live proof authority, release state.
