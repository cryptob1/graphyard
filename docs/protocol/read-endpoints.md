<!-- page: Agent protocol | 2 | status, events. -->
# Read endpoints

- `GET /healthz` (unauthenticated); `/api/status`: principal, integrations, `appPermissions`, held/failed jobs, `githubBudget`, clock; `/api/github/installation` (coordinator): live App permissions.
- `GET /api/work-snapshot`: `{work, now}`, `autoDispatch`; settled deliveries `summary: true`; `view=coordination` trims open items, `view=full` exports all; else pages by `cursor` (last number), `pageSize` (≤1000, default 100) → `hasMore`, `nextCursor`.
- `GET /api/work/ID|KEY`: one item (CLI name resolution); `/api/work`: all, whole. Other reads, observation claim: open items whole, settled deliveries as index summaries.
- `GET /api/interventions?window=7|30|90`: ledger rows (`ledger.since`; catalogue matches `catalogue`, `catalogued`). The loop's rework for a required check failed on the head (binding `SHA:ci:CHECKS`) is none; hand rework counts. Widenings the loop grants on its grounds or the approver settles on a loop-routed ask aren't `scope-widening` (master-authored ones are); a partly widened ask counts once.
- `GET /api/retro`: artefacts (newest first), each registry's `standing` revision; `/api/retro/standing` (any role): applied entries ([`retroStanding`](../operations-reference.md#retro-synthesis), `retroCatalogued`).
- `GET /api/events?work=UUID`: newest first (`graphyard events GY-N --all`); no `work`: whole ledger (operator agents need `decision:approve` over all; read-only). Routine `github.observed`/`heartbeat` rows need `routine=include`; `limit` (300), `cursor` (last `seq`); filter `kind`, `since`, `until`.
- `GET /api/analytics/flow`, `/api/analytics/attribution`: bounded; scan reach `window.covered`/`window.kinds`; `throughput[].covered: false` unread; Merged is Deploy; `stepDwell[].sparse` (n<5); `/drilldown`: metric's kinds (`steps`: gate/merge facts) per filtered item from the work index, concurrent duplicates shared; `coverage.truncated`: truncated. Flow, interventions, `/api/shipping-pulse` share three connections.
- `GET /api/deployments`: `POST /api/deployments` observations (`producer`/`admin`; `succeeded`, `failed`, `rolled_back`; never gates).
- `GET /api/tests`, `/api/tests/ID/runs`: case results, paged history; `/api/delegation`, `/api/proof-grants`, `/api/delivery`: slices, live proof authority, release state.
