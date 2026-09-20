<!-- page: Agent protocol | 4 | which GET returns what. -->
# Read endpoints

For a client reading Graphyard, and what bounds each read.

- `GET /healthz`: Database reachability and the running release; no token required
- `GET /api/status`: Current principal, integration configuration, the App permission preflight (`appPermissions`), `heldJobs`, failed jobs, `delegationLimits`, `production`, server time
- `GET /api/work-snapshot`: Work (with each item's `autoDispatch` requests), integration job metadata and database time from one Postgres statement snapshot, as `{ work, now }` ordered by work number
- `GET /api/work`: Work aggregates, in creation order
- `GET /api/events?work=UUID`: Latest 300 events for one item; omit the filter for the latest global events
- `GET /api/analytics/flow[/drilldown|/export]`: Bounded [delivery-flow](../flow-analytics.md) report, its records, or a deterministic export
- `GET /api/analytics/attribution[/drilldown]`: The [attribution](../attribution.md) report for a window, and up to 200 rows
- `GET /api/attribution/manifest/RELEASE_ID/REVISION`: A release manifest with its `hash`, `digestHash` and membership
- `GET /api/attribution/work/UUID`: One item's attribution ledger, newest last, at most 200 rows
- `GET /api/deployments`: Latest recorded deployment-provider observations
- `GET /api/delegation`: Slices, leads, engineers, workers, reviewers and bottlenecks, filtered by operator-agent scope
- `GET /api/proof-grants[/ID/history]`: Live proof authority per principal, and one principal's append-only grant history
- `GET /api/delivery[/observations?environment=ID]`: Every environment's delivery state and the release registry, or one environment's paged observations
- `GET /api/validation[/capacity|/definitions|/candidate/UUID|/attempt/REQUEST_ID]`: Requests, runner capacity, definition history, one candidate, or the attempt authority a host attestor reads
- `GET /api/shipping-pulse`: The repository [delivery pulse](../shipping-pulse.md); not offered to operator agents

Every attribution endpoint is a read: the ledger is written only by validation and observation ingest inside their own transactions, so no credential moves a request, attempt, result or evidence record through these routes, and a `POST` to one is not found.

Flow analytics reads are bounded in window, work items, records scanned, buckets, drill-down rows and payload size, report when a bound was reached, and are not offered to operator agents. The list API is unpaginated and is not an analytics export: event payload snapshots reconstruct historical revisions, and archival export pagination is future work.
