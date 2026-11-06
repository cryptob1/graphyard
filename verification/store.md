Paths: src/store/**, src/store.ts, src/engine.ts, src/engine/**, src/reconcile/**

## Tests

- `tests/test-postgres-helper.test.ts`: shared-cluster lifecycle, isolation, fixture scan.
- `tests/store-locks.test.ts`: advisory locks and the coordination index.
- `tests/per-item-locking.test.ts`: fleet-then-item lock order, renewals never overwritten.
- `tests/locked-read.test.ts`, `tests/snapshot-bounded-reads.test.ts`: bounded snapshot reads.
- `tests/ledger-compaction.test.ts`, `tests/store-init.test.ts`, `tests/store-close.test.ts`.

## Drive

Run: `node --import tsx tests/helpers/run-tests.ts tests/store-locks.test.ts`. The runner owns one shared Postgres; never point a test at production data. Set `TMPDIR` to scratch if `/tmp` is short of quota.

## Invariants

- Every domain mutation is one transaction appending history, checking principal identity and lease epoch.
- Locks go fleet first, then item (`src/store/item-lock.ts`); a heartbeat takes only its item lock.
- The coordination index is written with the document it summarizes, in one transaction.
- External I/O (GitHub, git, Herdr) never runs inside a coordination transaction.

## Gotchas

- `await withDatabase(label)`, then `store.init()` and `store.close()` in teardown. Labels may repeat: every allocation is its own database; no fixture assigns a Postgres port.
- Migration, backup and child-server tests keep `databaseUrl(label)` URLs for replicas. Outage tests use `databaseAvailable(url, false)`, which disconnects only their own clients. Scope `pg_locks`/`pg_stat_activity` probes to the current database.
- Direct `node --test` runs get one cluster per process from the same helper; private-root checks start it in their isolated process.
- Temporary directories come from `temporaryDirectory()` (`tests/helpers/temp-dirs.ts`), never a bare `mkdtemp`.
- Each advisory lock id in `src/store/locks.ts` belongs to one concern; never reuse one.
- A stale write retries on a fresh transaction: keep transaction bodies side-effect free.
