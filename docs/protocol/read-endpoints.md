<!-- page: Agent protocol | 2 | status, snapshots and events. -->
# Read endpoints

- `GET /healthz`: unauthenticated health.
- `GET /api/status`: principal, integrations, `appPermissions`, held/failed jobs, `githubBudget`, server time.
- `GET /api/work-snapshot`: `{work, now}` from one snapshot, with `autoDispatch` requests; age leases against `now`.
- `GET /api/work`: every aggregate, creation-ordered.
- `GET /api/events?work=UUID`: one item's events, newest first; `graphyard events GY-N --all` walks all.
- `GET /api/analytics/flow`, `/api/analytics/attribution`: bounded. Flow days: UTC midnights to today, the first holding earlier time. `window.covered`/`window.kinds`: scan and per-kind reach; `throughput[].covered: false`: unread, not zero. Merged is Deploy; `stepDwell[].sparse` (n<5): marked, unsplit.
- `GET /api/deployments`: `POST /api/deployments` observations (`producer`/`admin`; `state` `succeeded`, `failed` or `rolled_back`; never moves a gate).
- `GET /api/delegation`, `/api/proof-grants`, `/api/delivery`: slices, live proof authority, release state.

Events skip routine `github.observed`/`heartbeat` rows unless `routine=include`; page by `limit` (default 300) and `cursor` (last `seq`); filter by `kind`, `since`, `until`.
