<!-- page: Agent protocol | 2 | status, snapshots and events. -->
# Read endpoints

- `GET /healthz` (unauthenticated); `GET /api/status`: principal, integrations, `appPermissions`, held/failed jobs, `githubBudget`, clock.
- `GET /api/github/installation` (coordinator): live App permissions.
- `GET /api/work-snapshot`: `{work, now}` with `autoDispatch`; age leases against `now`. Open items whole, settled deliveries `summary: true` (no prose/histories); `view=coordination` trims open items, `view=full` exports all; others page visible work by `cursor` (last number), `pageSize` (≤1000, default 100) → `hasMore`, `nextCursor`.
- `GET /api/work/ID|KEY` (one), `/api/work` (all).
- `GET /api/interventions?window=7|30|90`: ledger rows (`ledger.since`); catalogue-recognised ones marked `catalogue`, counted in `catalogued`.
- `GET /api/retro`: artefacts (newest first), each registry's `standing` revision; `/api/retro/standing` (any role): applied entries ([`retroStanding`](../operations-reference.md#retro-synthesis), `retroCatalogued`).
- `GET /api/events?work=UUID`: item events, newest first (`graphyard events GY-N --all`); no `work`: whole ledger (operator agents name an item unless holding `decision:approve` over all; read-only). Routine `github.observed`/`heartbeat` rows need `routine=include`; page `limit` (300), `cursor` (last `seq`); filter `kind`, `since`, `until`.
- `GET /api/analytics/flow`, `/api/analytics/attribution`: bounded; flow days: UTC midnights to today (first holds earlier time). `window.covered`/`window.kinds`: scan reach; `throughput[].covered: false`: unread (not zero); Merged is Deploy; `stepDwell[].sparse` (n<5): marked, unsplit. Cached 60 s per window/filters; facts coalesce 10 s; deployments invalidate immediately. Flow, `GET /api/interventions`, `/api/shipping-pulse`: shared 3-connection, 20s-timeout pool.
- `GET /api/deployments`: `POST /api/deployments` observations (`producer`/`admin`; `succeeded`, `failed`, `rolled_back`; never gates).
- `GET /api/tests`, `/api/tests/ID/runs`: case results, paged history; `GET /api/delegation`, `/api/proof-grants`, `/api/delivery`: slices, live proof authority, release state.
