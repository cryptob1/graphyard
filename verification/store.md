Paths: src/store/**, src/store.ts, src/engine.ts

## Tests

- `tests/store-locks.test.ts`: advisory locks and the coordination index matching the documents.
- `tests/per-item-locking.test.ts`: fleet-then-item lock order, renewals never overwritten.
- `tests/locked-read.test.ts`, `tests/snapshot-bounded-reads.test.ts`: bounded snapshot reads.
- `tests/ledger-compaction.test.ts`, `tests/store-init.test.ts`, `tests/store-close.test.ts`.

## Drive

Run one file with `node --import tsx tests/helpers/run-tests.ts` followed by its path; it starts an embedded Postgres on a reserved port, so never point a test at production data. Set `TMPDIR` to a scratch directory if `/tmp` is short of quota.

## Invariants

- Every domain mutation is one transaction that appends history and checks principal identity and lease epoch.
- Locks are taken fleet first, then item (`src/store/item-lock.ts`); a heartbeat takes only its item lock.
- The coordination index is written in the same transaction as the document it summarizes.
- External I/O (GitHub, git, Herdr) never runs inside a coordination transaction.

## Gotchas

- A test that stops its Postgres awaits `store.close()`, never `store.pool.end()`.
- Temporary directories come from `temporaryDirectory()` in `tests/helpers/temp-dirs.ts`, never a bare `mkdtemp`.
- Each advisory lock id in `src/store/locks.ts` belongs to one concern; never reuse one.
- A stale write retries on a fresh transaction: keep transaction bodies free of side effects.
