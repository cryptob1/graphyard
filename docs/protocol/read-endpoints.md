<!-- page: Agent protocol | 2 | status, snapshots and events. -->
# Read endpoints

- `GET /healthz`: health, no token.
- `GET /api/status`: principal, integration configuration, `appPermissions`, held and failed jobs, `githubBudget`, server time.
- `GET /api/work-snapshot`: `{ work, now }` from one database snapshot, including each item's `autoDispatch` requests; age leases against its `now`.
- `GET /api/work`: every aggregate, in creation order.
- `GET /api/events?work=UUID`: one item's events, newest first.
- `GET /api/analytics/flow` and `/api/analytics/attribution`: bounded analytics.
- `GET /api/deployments`: provider observations recorded by `POST /api/deployments` (`producer` or `admin`; `state` `succeeded`, `failed` or `rolled_back`; they never move a gate).
- `GET /api/delegation`, `GET /api/proof-grants`, `GET /api/delivery`: slices, live proof authority, release state.

Event reads exclude routine `github.observed` and `heartbeat` rows unless `routine=include`; page with `limit` (default 300) and `cursor` (the last `seq`), filter with `kind`, `since` and `until`. `graphyard events GY-N --all` walks an item's whole life.
