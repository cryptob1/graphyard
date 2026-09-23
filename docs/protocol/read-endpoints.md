<!-- page: Agent protocol | 4 | per-endpoint reads. -->
# Read endpoints

For a client reading Graphyard, and what bounds each read.

- `GET /healthz`: Database reachability and the running release; no token required
- `GET /api/status`: Current principal, integration configuration, the App permission preflight (`appPermissions`), `heldJobs`, failed jobs, `delegationLimits`, `production`, server time
- `GET /api/work-snapshot`: Work (with each item's `autoDispatch` requests), integration job metadata and database time from one Postgres statement snapshot, as `{ work, now }` ordered by work number; `?view=coordination`: the bounded view the master loop and dispatcher poll
- `GET /api/work`: Work aggregates, in creation order
- `GET /api/events?work=UUID`: Event rows for one item, newest first; see [an item's history](#reading-an-items-history)
- `GET /api/analytics/flow[/drilldown|/export]`, `GET /api/analytics/attribution[/drilldown]`, `GET /api/deployments`: [Flow analytics](../flow-analytics.md#privacy-boundary-and-api), with their query parameters and audit-role rule
- `GET /api/attribution/manifest/RELEASE_ID/REVISION`: A release manifest with its `hash`, `digestHash` and membership
- `GET /api/attribution/work/UUID`: One item's attribution ledger, newest last, at most 200 rows; a worker reads only its own assignment; identifiers follow the same audit-role rule
- `GET /api/delegation`: Slices, leads, engineers, workers, reviewers and bottlenecks, by operator-agent scope
- `GET /api/proof-grants[/ID/history]`: Live proof authority per principal, and one principal's append-only grant history
- `GET /api/delivery[/observations?environment=ID]`: Every environment's delivery state and the release registry, or one environment's observations
- `GET /api/validation[/capacity|/definitions|/candidate/UUID|/attempt/REQUEST_ID]`: Requests, runner capacity, definition history, one candidate, or the attempt authority a host attestor reads
- `GET /api/shipping-pulse`: The repository [delivery pulse](../shipping-pulse.md); not offered to operator agents

## Reading an item's history

`GET /api/events` excludes the routine kinds `github.observed` (one per reconciliation pass) and `heartbeat` (one per lease renewal) by default, summarising them instead.

- `work`: One item's UUID; omitted, the whole ledger
- `kind`: Only these kinds, repeated or comma-separated; naming a routine kind selects it
- `since`, `until`: Half-open `[since, until)` on the recorded instant
- `order`: `desc` (default) or `asc`
- `limit`: Rows per page, 1-1000 (default 300)
- `cursor`: The `seq` of the previous page's last row; paging never revisits a row
- `routine`: `exclude` (default) or `include`
- `payload`: `full` (default), `details` (without the embedded work snapshot) or `none`

- **`graphyard events GY-N`:** `--kind`, `--since`, `--until`, `--order`, `--limit`, `--cursor` and `--payload` (default `details`) are these parameters; `--routine` includes the routine rows; `--all` follows `nextCursor` forwards (`order=asc` unless given) for at most 200 pages, `page.complete` saying whether the range ended. Without an item, `graphyard events` reads the latest ledger rows and takes no flags

## Bounds

- **Paged reads:** `GET /api/validation[/definitions|/reuse|/replays]?cursor=C` and `GET /api/delivery/observations?cursor=C` take the previous response's `nextCursor`, null when finished
- **`GET /api/work`:** unpaginated and not an analytics export
