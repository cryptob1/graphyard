<!-- page: Agent protocol | 2 | status, snapshots and events. -->
# Read endpoints

- `GET /healthz` (unauthenticated); `GET /api/status`: principal, integrations, `appPermissions`, held/failed jobs, `githubBudget`, clock.
- `GET /api/github/installation` (coordinator): live App permissions.
- `GET /api/work-snapshot`: `{work, now}` with `autoDispatch`; age leases by `now`; settled deliveries `summary: true`. `view=coordination` trims open items; `view=full` exports all; others page by `cursor` (last number), `pageSize` (≤1000, default 100) → `hasMore`, `nextCursor`.
- `GET /api/work/ID|KEY` (one), `/api/work` (all).
- `GET /api/interventions?window=7|30|90`: ledger rows (`ledger.since`); catalogue-recognised ones marked `catalogue` (count `catalogued`).
- `GET /api/retro`: artefacts, newest first, with each registry's `standing` revision; `/api/retro/standing` (any role): applied entries (`graphyard status GY-N`: `retroStanding`; `retroCatalogued`: recognised refusals).
- `GET /api/events?work=UUID`: one item's events, newest first (`graphyard events GY-N --all`); without `work`, the whole ledger (operator agents need `decision:approve` over all). Routine `github.observed`/`heartbeat` rows need `routine=include`; page by `limit` (300), `cursor` (last `seq`); filter `kind`, `since`, `until`.
- `GET /api/analytics/flow`, `/api/analytics/attribution`: bounded, UTC days. `window.covered`/`window.kinds`: scan reach; `throughput[].covered: false`: unread, not zero; `stepDwell[].sparse`: n<5. Cached 60 s until a deployment. Pooled (3 connections, 20s timeout) with interventions, `/api/shipping-pulse`.
- `GET /api/deployments`: `POST /api/deployments` observations (`producer`/`admin`; `succeeded`, `failed`, `rolled_back`; never gates).
- `GET /api/tests` (`/ID/runs`: history), `/api/delegation`, `/api/proof-grants`, `/api/delivery`: cases, slices, proof authority, releases.
