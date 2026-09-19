<!-- page: Agent protocol | 3 | status, work snapshots, events, delegation, and proof authority reads. -->
# Read endpoints

| Method and path | Result |
| --- | --- |
| `GET /healthz` | Database reachability, no token required |
| `GET /api/status` | Current principal, integration configuration, failed jobs, server time |
| `GET /api/work-snapshot` | Work, integration job metadata and database time from one snapshot |
| `GET /api/work` | Work aggregates, in creation order |
| `GET /api/events?work=UUID` | Latest 300 events for one item; omit filter for latest global events |
| `GET /api/delegation` | Slices, leads, engineers, workers, reviewers and bottlenecks; filtered by operator-agent scope |
| `GET /api/proof-grants` | Live proof authority per principal, and the grant records behind it |
| `GET /api/proof-grants/ID/history` | Append-only grant history for one principal |

The initial list API is unpaginated. Do not use it as an unlimited analytics export. Event payload snapshots can reconstruct historical item revisions; full archival/export pagination is future work.
