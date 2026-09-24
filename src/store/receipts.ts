import type pg from 'pg';
import type { Work } from '../model.js';

/**
 * Idempotency receipts answer a client's retry of a command it already sent. No client retries
 * for longer than minutes (the CLI times a request out after 30 s and every renewal uses a new
 * key), so a receipt is kept for a week and then pruned: the table had no timestamp and nothing
 * pruned it, and every lease renewal stored a whole work document under a fresh key.
 * The event ledger, not this table, is the history; pruning never touches it.
 */
export const receiptReplayWindowMs = 7 * 24 * 60 * 60 * 1000;
/** Rows one prune run deletes at most, so a backlog drains across runs instead of in one statement. */
export const receiptPruneBatch = 5_000;
/** How often the server's reconciliation tick runs the prune. */
export const receiptPruneIntervalMs = 10 * 60_000;

/**
 * What a lease renewal's receipt keeps: the fields a renewal's caller reads (the supervisor reads
 * the lease and `updatedAt`), not the whole document. The first answer is still the full document;
 * a replay answers this.
 */
export const compactHeartbeatReceipt = (work: Work) => ({
  id: work.id, key: work.key, stage: work.stage, revision: work.revision, policyRevision: work.policyRevision,
  epoch: work.epoch, lease: work.lease, updatedAt: work.updatedAt, compactReceipt: true as const,
});

/**
 * Delete receipts older than the replay window, at most `limit` per run. It runs on the pool, outside
 * any coordination transaction and without the advisory lock. A row with no `created_at` came from a
 * restore of a backup that predates the column; its age is unknown, and a restore already ends every
 * in-flight retry, so it is pruned too. Rows that existed when the column was added read the
 * migration's time and are pruned a window after it.
 */
export async function pruneReceipts(pool: pg.Pool, options: { windowMs?: number; limit?: number } = {}) {
  const windowMs = options.windowMs ?? receiptReplayWindowMs, limit = options.limit ?? receiptPruneBatch;
  const result = await pool.query(`DELETE FROM receipts WHERE (actor,key) IN (
    SELECT actor,key FROM receipts WHERE created_at IS NULL OR created_at < now() - ($1::text||' milliseconds')::interval LIMIT $2)`,
  [String(Math.max(0, Math.floor(windowMs))), limit]);
  return result.rowCount ?? 0;
}
