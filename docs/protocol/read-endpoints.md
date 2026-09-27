<!-- page: Agent protocol | 2 | status, snapshots and events. -->
# Read endpoints

- `GET /healthz`: unauthenticated.
- `GET /api/status`: principal, integrations, `appPermissions`, held/failed jobs, `githubBudget`, clock.
- `GET /api/work-snapshot`: `{work, now}` with `autoDispatch` requests; age leases against `now`. Open items whole; settled deliveries `summary: true`, without prose or histories. `view=coordination` trims open items; `view=full` exports everything.
- `GET /api/work/ID|KEY`: one whole document; `/api/work`: all.
- `GET /api/interventions?window=7|30|90`: the window's ledger rows only (`ledger.since`).
- `GET /api/events?work=UUID`: one item's events, newest first (`graphyard events GY-N --all` walks them). Without `work`, the whole ledger; operator agents must name an item unless they hold `decision:approve` over every item (the approver, verifying a decision; read only).
- `GET /api/analytics/flow`, `/api/analytics/attribution`: bounded. Flow days: UTC midnights to today, the first holding earlier time. `window.covered`/`window.kinds`: scan and per-kind reach; `throughput[].covered: false`: unread, not zero. Merged is Deploy; `stepDwell[].sparse` (n<5): marked, unsplit. Reports are cached up to 60 s per window and filters. New flow facts coalesce for 10 s from the start of a report read; the next read after that interval recomputes if facts changed. Concurrent reads share the in-flight computation. Deployment observations invalidate immediately, and a new production-watch pass uses a new cache key. Cold reads and refreshes still pay the bounded database-read cost.
- Interventions, flow, `/api/shipping-pulse`: 3-connection, 20s-timeout report pool.
- `GET /api/deployments`: `POST /api/deployments` observations (`producer`/`admin`; `state` `succeeded`, `failed` or `rolled_back`; never moves a gate).
- `GET /api/delegation`, `/api/proof-grants`, `/api/delivery`: slices, live proof authority, release state.

Events skip routine `github.observed`/`heartbeat` rows unless `routine=include`; page by `limit` (default 300) and `cursor` (last `seq`); filter by `kind`, `since`, `until`.
