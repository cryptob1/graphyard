<!-- page: Agent protocol | 2 | status, snapshots and events. -->
# Read endpoints

- `GET /healthz`: unauthenticated.
- `GET /api/status`: principal, integrations, `appPermissions`, held/failed jobs, `githubBudget`, clock.
- `GET /api/github/installation`: coordinator; live installation and App permissions.
- `GET /api/work-snapshot`: `{work, now}` with `autoDispatch`; age leases against `now`. Open items whole; settled deliveries `summary: true`, no prose or histories. `view=coordination` trims open items; `view=full` exports all. Other views page by `cursor` (last number), `pageSize` (≤1000, default 100): `hasMore`, `nextCursor`, visible work only.
- `GET /api/work/ID|KEY`: one whole document; `/api/work`: all.
- `GET /api/interventions?window=7|30|90`: that window's ledger rows (`ledger.since`).
- `GET /api/retro`: every retro artefact, newest first, and each registry's `standing` revision; `/api/retro/standing` (any role): applied entries only. `graphyard status GY-N` adds them as `retroStanding`, and `retroCatalogued` for gate refusals an applied catalogue entry recognises. `GET /api/interventions` marks such instances `catalogue` and tallies them in `catalogued`.
- `GET /api/events?work=UUID`: one item's events, newest first (`graphyard events GY-N --all` walks them). Without `work`, the whole ledger; operator agents name an item unless holding `decision:approve` over every item (approvers; read-only).
- `GET /api/analytics/flow`, `/api/analytics/attribution`: bounded. Flow days: UTC midnights to today, the first holding earlier time. `window.covered`/`window.kinds`: scan and per-kind reach; `throughput[].covered: false`: unread, not zero. Merged is Deploy; `stepDwell[].sparse` (n<5): marked, unsplit. Reports cache 60 s per window and filters; facts coalesce 10 s; deployments invalidate immediately.
- Interventions, flow, `/api/shipping-pulse`: 3-connection, 20s-timeout report pool.
- `GET /api/deployments`: `POST /api/deployments` observations (`producer`/`admin`; `succeeded`, `failed` or `rolled_back`; never gates).
- `GET /api/tests`, `/api/tests/ID/runs`: case results, paged history.
- `GET /api/delegation`, `/api/proof-grants`, `/api/delivery`: slices, live proof authority, release state.

Events skip routine `github.observed`/`heartbeat` rows unless `routine=include`; page by `limit` (default 300), `cursor` (last `seq`); filter by `kind`, `since`, `until`.
