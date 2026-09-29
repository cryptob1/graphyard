<!-- page: Understand or contribute | 2 | how the work snapshot stays bounded and how to page it. -->
# Bounded snapshot reads (GY-864)

## The problem

The ledger ages: every delivered item keeps its whole document — every evidence record with its
artifacts and provenance, every dispatch and action row, its observation and pipeline timeline. A
read that loads every document therefore grows with the ledger, not with the work at hand (one
2026-09-27 read answered 19.2 MB for 863 items in 31 s), and every CLI command that made such a
read waited on it.

## What each view of `GET /api/work-snapshot` serves

- **default and `view=bounded`** — open items whole, and each settled delivery as its summary from
  the work index (`src/store/summary-sql.ts`). Bounded per item, but it still carries every open
  item's whole document, so it grows with open weight.
- **`view=coordination`** (or the `X-Graphyard-View: coordination` header) — the trimmed read the
  master loop polls: every item's decision state intact, its histories bounded to the last few
  entries, evidence trimmed to what a decision can still consult, and settled items served from
  the work index without reading their documents. Bytes stay flat however heavy the ledger is.
- **`view=full`** — every document whole, for an export. This is the only read that still grows
  with the ledger's whole weight.

`GET /api/work/{id}` (by UUID) or `GET /api/work/{key}` (for example `GET /api/work/GY-864`)
answers one item's whole document without reading any other.

## What the CLI commands read

No CLI command fetches every document (GY-864):

- `graphyard master status` reads the trimmed coordination snapshot, by header, on the same
  `work-snapshot` path the loop polls.
- `graphyard master scope GY-N` reads the single item `GET /api/work/GY-N`.
- The worker's `sync` conflict attribution and the watch supervisor's containment revalidation
  read the trimmed coordination snapshot (`work-snapshot?view=coordination`).

## Paging

`GET /api/work-snapshot` is paged for the reader that must still walk every document — an export,
a migration — so it streams instead of loading the ledger at once:

- `cursor` — the number of the work item the reader last saw (the suffix of its key, for example
  `864` for `GY-864`). The next page starts after it.
- `pageSize` — items per page, 1 to 1000; 100 when omitted.

A paged response carries `hasMore` and, when more follow, `nextCursor`. A request that names
neither parameter is not paged: it is answered whole, exactly as before, so no existing reader is
truncated. The coordination view is not paged; it is the loop's own bounded poll.

Example: `GET /api/work-snapshot?view=full&pageSize=50&cursor=100` answers work items after
`GY-100`, at most 50 of them, with `nextCursor` set when more remain.
