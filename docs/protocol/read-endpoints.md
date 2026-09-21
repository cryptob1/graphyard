<!-- page: Agent protocol | 4 | which GET returns what. -->
# Read endpoints

For a client reading Graphyard, and what bounds each read.

- `GET /healthz`: Database reachability and the running release; no token required
- `GET /api/status`: Current principal, integration configuration, the App permission preflight (`appPermissions`), `heldJobs`, failed jobs, `delegationLimits`, `production`, server time
- `GET /api/work-snapshot`: Work (with each item's `autoDispatch` requests), integration job metadata and database time from one Postgres statement snapshot, as `{ work, now }` ordered by work number; `?view=coordination`: the bounded view the master loop and dispatcher poll
- `GET /api/work`: Work aggregates, in creation order
- `GET /api/events?work=UUID`: Latest 300 events for one item; omit the filter for the latest global events
- `GET /api/analytics/flow[/drilldown|/export]`, `GET /api/analytics/attribution[/drilldown]`, `GET /api/deployments`: [Flow analytics](../flow-analytics.md#privacy-boundary-and-api), with their query parameters and audit-role rule
- `GET /api/attribution/manifest/RELEASE_ID/REVISION`: A release manifest with its `hash`, `digestHash` and membership
- `GET /api/attribution/work/UUID`: One item's attribution ledger, newest last, at most 200 rows; a worker reads only its own assignment; identifiers follow the same audit-role rule
- `GET /api/delegation`: Slices, leads, engineers, workers, reviewers and bottlenecks, by operator-agent scope
- `GET /api/proof-grants[/ID/history]`: Live proof authority per principal, and one principal's append-only grant history
- `GET /api/delivery[/observations?environment=ID]`: Every environment's delivery state and the release registry, or one environment's observations
- `GET /api/validation[/capacity|/definitions|/candidate/UUID|/attempt/REQUEST_ID]`: Requests, runner capacity, definition history, one candidate, or the attempt authority a host attestor reads
- `GET /api/shipping-pulse`: The repository [delivery pulse](../shipping-pulse.md); not offered to operator agents

## Bounds

- **Attribution endpoints:** reads only — the ledger is written by validation and observation ingest inside their transactions, so no credential moves a request, attempt, result or evidence record through them, and a `POST` to one is not found
- **Flow analytics:** bounded in window, work items, records scanned, buckets, drill-down rows and payload size; reports when a bound was reached; not offered to operator agents
- **Paged reads:** `GET /api/validation[/definitions|/reuse|/replays]?cursor=C` and `GET /api/delivery/observations?cursor=C` take the previous response's `nextCursor`, null when finished
- **The list API:** unpaginated and not an analytics export — event payload snapshots reconstruct historical revisions, and archival export pagination is future work
