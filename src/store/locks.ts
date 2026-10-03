/**
 * Every advisory lock the store's callers take, one id per concern (GY-203, GY-1124). The coordination/fleet
 * lock serializes cross-item coordination decisions (dispatch admission, merge-queue order, dependency release,
 * overlap/exclusive-resource checks), while per-item locks (namespace item) serialize writes to one item and
 * allow writes to different items to run concurrently. Commands needing both acquire fleet-then-item in a fixed
 * order so no deadlock is possible. A migration and a backup or restore each take their own, so a release
 * migrating at startup never queues behind a busy live replica's coordination work (or holds it up), and a
 * backup never stalls a claim. Two migrations still serialize on theirs; DDL that must not run beside a write
 * waits on that table's own lock, bounded by the migration's deadline. The flow projection's id is listed so
 * none reuses it, and the ledger compaction's (compaction.ts) keeps two replicas from compacting at once.
 */
export const advisoryLocks = {
  item: 71490320,
  coordination: 71490321,
  flowProjection: 71490322,
  migration: 71490323,
  backup: 71490324,
  ledgerCompaction: 71490325,
} as const;
