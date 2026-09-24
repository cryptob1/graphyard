<!-- page: Agent protocol | 3 | status, snapshots, events, analytics and delivery reads. -->
# Read endpoints

| Method and path | Result |
| --- | --- |
| `GET /healthz` | Database reachability, no token |
| `GET /api/status` | Principal, integration configuration, App permission preflight (`appPermissions`), held and failed jobs, server time |
| `GET /api/work-snapshot` | `{ work, now }` from one database snapshot, including each item's `autoDispatch` requests; age leases against its `now` |
| `GET /api/work` | Work aggregates, in creation order |
| `GET /api/events?work=UUID` | One item's events, newest first; omit `work` for the whole ledger |
| `GET /api/analytics/flow`, `/drilldown`, `/export` | Bounded [flow analytics](../flow-analytics.md) (not for operator agents) |
| `GET /api/deployments` | Latest deployment-provider observations |
| `GET /api/delegation` | Slices, leads, workers, reviewers and bottlenecks |
| `GET /api/proof-grants`, `/ID/history` | Live proof authority and its append-only history |
| `GET /api/delivery`, `/api/delivery/observations?environment=ID` | Release and delivery state ([delivery](../delivery.md)); mutations are `POST /api/delivery/{build,release,approve,select,lease,observe,notify,sweep}` |

[Validation](../validation.md) requests are inspected with `graphyard validation`.

## Reading an item's history

Routine `github.observed` and `heartbeat` rows are excluded by default and summarised.

| Parameter | Meaning |
| --- | --- |
| `kind` | Only these kinds (naming a routine kind selects it) |
| `since`, `until` | Half-open range on the recorded instant |
| `order` | `desc` (default) or `asc` |
| `limit` | 1–1000 (default 300) |
| `cursor` | The previous page's last `seq` |
| `routine` | `exclude` (default) or `include` |
| `payload` | `full`, `details` or `none` |
| `view` | `rows`, `history` (adds `page` and the `routine` summary) or `page` |

`graphyard events GY-N --all` walks an item's whole life with `order=asc`; `--kind`, `--since`, `--until`, `--routine` and `--payload` map to the parameters.
