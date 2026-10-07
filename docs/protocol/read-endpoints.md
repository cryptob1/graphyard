<!-- page: Agent protocol | 2 | status, events. -->
# Read endpoints

- `GET /healthz` (unauthenticated); `GET /api/status`: principal, integrations, `appPermissions`, held/failed jobs, `githubBudget`, clock.
- `GET /api/github/installation` (coordinator): live App permissions.
- `GET /api/work-snapshot`: `{work, now}` with `autoDispatch`; `view=coordination` trims open items, `view=full` exports all; others page by `cursor` and `pageSize` (≤1000).
- `GET /api/work/ID|KEY`: one item; `/api/work`: every item. Other reads (`/api/status`, `/api/board`, `/api/actions`, `/api/delegation`, flow analytics) read settled deliveries as the work index's summary.
- `GET /api/interventions?window=7|30|90`: ledger rows (`ledger.since`), catalogue-recognised ones marked (`catalogue`, `catalogued`).
- `GET /api/retro`: artefacts (newest first), each registry's `standing` revision; `/api/retro/standing` (any role): applied entries ([`retroStanding`](../operations-reference.md#retro-synthesis), `retroCatalogued`).
- `GET /api/events?work=UUID`: item events, newest first (`graphyard events GY-N --all`); no `work`: whole ledger. Routine rows need `routine=include`; page `limit` (300), `cursor`; filter `kind`, `since`, `until`.
- `GET /api/analytics/flow`, `/api/analytics/attribution`: bounded reads marking their reach (`window.covered`, `coverage.truncated`); `/drilldown` reads a metric's kinds from the work index, sharing identical concurrent reads. Flow, interventions and `/api/shipping-pulse` share three connections.
- `GET /api/deployments`: `POST /api/deployments` observations (`producer`/`admin`; `succeeded`, `failed`, `rolled_back`; never gates).
- `GET /api/tests`, `/api/tests/ID/runs`: case results, paged history; `GET /api/delegation`, `/api/proof-grants`, `/api/delivery`: slices, live proof authority, release state.
