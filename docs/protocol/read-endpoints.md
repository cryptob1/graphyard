<!-- page: Agent protocol | 3 | status, work snapshots, events, delegation, and proof authority reads. -->
# Read endpoints

| Method and path | Result |
| --- | --- |
| `GET /healthz` | Database reachability, no token required |
| `GET /api/status` | Current principal, integration configuration, the App permission preflight (`appPermissions`: required, granted, missing, attention, installation URL) and `heldJobs`, failed jobs, server time |
| `GET /api/work-snapshot` | Work, integration job metadata and database time from one snapshot |
| `GET /api/work` | Work aggregates, in creation order |
| `GET /api/events?work=UUID` | Latest 300 events for one item; omit filter for latest global events |
| `GET /api/analytics/flow` | Bounded delivery-flow report for a 7-, 30-, or 90-day window |
| `GET /api/analytics/flow/drilldown` | Bounded underlying records behind one aggregate |
| `GET /api/analytics/flow/export` | The same bounded records as deterministic CSV or JSON |
| `GET /api/deployments` | Latest recorded deployment-provider observations |
| `GET /api/delegation` | Slices, leads, engineers, workers, reviewers and bottlenecks; filtered by operator-agent scope |
| `GET /api/proof-grants` | Live proof authority per principal, and the grant records behind it |
| `GET /api/proof-grants/ID/history` | Append-only grant history for one principal |

Flow analytics reads are bounded in window, work items, records scanned, buckets, drill-down rows, and payload size, and report when a bound was reached. They are not available to operator agents. See [flow analytics](../flow-analytics.md).

The initial list API is unpaginated. Do not use it as an unlimited analytics export. Event payload snapshots can reconstruct historical item revisions; full archival/export pagination is future work.
