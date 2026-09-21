<!-- page: Agent protocol | 3 | status, work snapshots, events, delegation, and proof authority reads. -->
# Read endpoints

| Method and path | Result |
| --- | --- |
| `GET /healthz` | Database reachability, no token required |
| `GET /api/status` | Current principal, integration configuration, the App permission preflight (`appPermissions`: required, granted, missing, attention, installation URL) and `heldJobs`, failed jobs, server time |
| `GET /api/work-snapshot` | Work (including each item's `autoDispatch` review and producer requests), integration job metadata and database time from one snapshot |
| `GET /api/work` | Work aggregates, in creation order |
| `GET /api/events?work=UUID` | Event rows for one item, newest first; omit `work` for the whole ledger |
| `GET /api/events?view=history&…` | The same read with its paging cursor and the summary of the routine rows it left out |
| `GET /api/analytics/flow` | Bounded delivery-flow report for a 7-, 30-, or 90-day window |
| `GET /api/analytics/flow/drilldown` | Bounded underlying records behind one aggregate |
| `GET /api/analytics/flow/export` | The same bounded records as deterministic CSV or JSON |
| `GET /api/deployments` | Latest recorded deployment-provider observations |
| `GET /api/delegation` | Slices, leads, engineers, workers, reviewers and bottlenecks; filtered by operator-agent scope |
| `GET /api/proof-grants` | Live proof authority per principal, and the grant records behind it |
| `GET /api/proof-grants/ID/history` | Append-only grant history for one principal |

Flow analytics reads are bounded in window, work items, records scanned, buckets, drill-down rows, and payload size, and report when a bound was reached. They are not available to operator agents. See [flow analytics](../flow-analytics.md).

## Reading an item's history

The control plane writes two kinds continuously — one `github.observed` per reconciliation pass
and one `heartbeat` per lease renewal — and on a live item they are most of the ledger. They are
therefore **excluded by default** and summarised instead, so a page of history is a page of the
item's life rather than of its polling.

| Parameter | Meaning |
| --- | --- |
| `work` | One item's history (a UUID); omitted, the read spans the whole ledger |
| `kind` | Only these kinds, repeated or comma-separated. Naming `heartbeat` or `github.observed` selects it; the default exclusion never empties an explicit selection |
| `since`, `until` | Half-open `[since, until)` on the recorded instant |
| `order` | `desc` (default, newest first) or `asc` to read a lifetime forwards |
| `limit` | Rows per page, 1-1000 (default 300) |
| `cursor` | The `seq` of the previous page's last row; paging never revisits a row |
| `routine` | `exclude` (default) or `include` to page through the routine rows themselves |
| `payload` | `full` (default), `details` (the event's own details without the work snapshot it embeds), or `none` |
| `view` | `rows` (default, the event array), `history` (the array plus `page` and `routine`), or `page` (`history` without the routine summary, for the pages after the first of one walk) |

`view=history` answers with `filters`, `events`, `page` (`returned`, `hasMore`, `nextCursor`,
first and last `seq` and instant) and `routine`: the kinds excluded, each with its count and its
first and last instant over the whole filtered range, the total, and a `statement` that names
them. The summary's own scan is bounded and reports `truncated` when it filled that bound.
Following `nextCursor` with `order=asc` retrieves an item's complete lifecycle however old it
is; `graphyard events GY-N --all` is that walk (it asks for the summary once, with the first
page), and `--kind`, `--since`, `--until`, `--routine` and `--payload` are the same parameters.
The flags belong to an item's history: `graphyard events` without an item reads the latest rows
of the whole ledger and takes none.

The initial list API is unpaginated. Do not use it as an unlimited analytics export.
