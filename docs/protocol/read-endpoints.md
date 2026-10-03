<!-- page: Agent protocol | 2 | status, snapshots and events. -->
# Read endpoints

- `GET /healthz`: unauthenticated; `GET /api/status`: principal, integrations, `appPermissions`, held/failed jobs, `githubBudget`, clock.
- `GET /api/github/installation` (coordinator): live App permissions.
- `GET /api/work-snapshot`: `{work, now}` with `autoDispatch`; settled deliveries `summary: true`. `view=coordination` trims open items; `view=full` exports all; else page by `cursor`, `pageSize` (≤1000, default 100) → `hasMore`, `nextCursor`.
- `GET /api/work/ID|KEY` (one), `/api/work` (all).
- `GET /api/interventions?window=7|30|90`: ledger rows (`ledger.since`); catalogue-recognised ones marked `catalogue` (count `catalogued`).
- `GET /api/retro`: artefacts with `standing` revisions; `/api/retro/standing` (any role): applied entries (`retroStanding`, `retroCatalogued` in status).
- `GET /api/events?work=UUID`: one item's events, newest first; without `work`, the whole ledger (operator agents need `decision:approve`). Routine `github.observed`/`heartbeat` rows need `routine=include`; page by `limit` (300), `cursor` (`seq`); filter `kind`, `since`, `until`.
- `GET /api/analytics/flow`, `/api/analytics/attribution`, `/api/shipping-pulse`: bounded UTC days, cached 60 s; `throughput[].covered: false` means unread, not zero; `/drilldown` reads metric kinds.
- `GET /api/deployments`: observations posted by `producer`/`admin` (`succeeded`, `failed`, `rolled_back`; never gates).
- `GET /api/tests` (`/ID/runs`: history), `/api/delegation`, `/api/proof-grants`, `/api/delivery`: cases, slices, proof authority, releases.
