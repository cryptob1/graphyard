/**
 * Every advisory lock the store's callers take, one id per concern (GY-203). The coordination lock
 * serializes coordination transactions (Store.transaction) and nothing else: a migration and a
 * backup or restore each take their own, so a release migrating at startup never queues behind a
 * busy live replica's coordination work (or holds it up), and a backup never stalls a claim. Two
 * migrations still serialize on theirs; DDL that must not run beside a write waits on that table's
 * own lock, bounded by the migration's deadline. The flow projection's id is listed so none reuses it,
 * the ledger compaction's (compaction.ts) keeps two replicas from compacting at once, and the retro
 * index's (retro-synthesis.ts) keeps two replicas from building events_retro_id at once.
 */
export const advisoryLocks = { coordination: 71490321, flowProjection: 71490322, migration: 71490323, backup: 71490324, ledgerCompaction: 71490325, retroIndex: 71490326 } as const;
