<!-- page: How Graphyard works | -- | bounded snapshot reads for performance. -->
# Bounded snapshot reads (GY-864)

## Overview

The `GET /api/work-snapshot` endpoint serves work items and related data. To keep read latency bounded regardless of repository size, Graphyard provides multiple views and pagination support.

## Views

- **`view=bounded` (default)**: Returns open items with trimmed histories and delivered items from the work index only. This view is optimized for high-volume reading and CLI commands.
- **`view=coordination`**: Trims open items to what the coordination process needs; used by the master loop.
- **`view=full`**: Exports everything; use only when the full document set is required.

CLI commands (`master status`, `master scope`, worker `sync` and `complete`) use the bounded view to avoid loading full work items with all their histories.

## Paging

All views support cursor-based paging to allow streaming large result sets without loading all documents at once:

- `cursor` (query parameter): Work item number for continuation; defaults to the start.
- `pageSize` (query parameter): Results per page (1–1000, default 100).

The response includes:
- `work`: Array of work items in this page.
- `nextCursor`: The work number of the last item in this page (present if more results exist).
- `hasMore`: Boolean indicating whether more results follow.

Example: `GET /api/work-snapshot?view=bounded&pageSize=50&cursor=1234` returns the next 50 items after work number 1234.

## Single item reads

To fetch a complete work item without reading the entire snapshot, use `GET /api/work/{id}` (by UUID) or `GET /api/work/{key}` (by display key, e.g., `GY-864`).
