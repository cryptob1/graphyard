import type pg from 'pg';
import { advisoryLocks } from './locks.js';
import { routineSaveKinds } from './snapshot-delta.js';
import { DELIVERY_EVENT_PREDICATE } from './tables/production.js';

/**
 * Ledger compaction (GY-979): routine rows past their retention window are deleted, a bounded
 * batch at a time, with an audit row naming what went.
 *
 * The ledger is append-only history, but its routine kinds (`routineSaveKinds`: observations,
 * renewals, reconciliation passes, action-queue claims and failures, queue and session
 * bookkeeping) are the continuous writes no lifecycle reader looks back at, and they filled a
 * 19 GB volume in production. A row is removed only when every one of these holds:
 * - its kind is routine — the events trigger itself refuses any other kind, and any delete not
 *   made under this module's transaction setting (`graphyard.ledger_compaction`);
 * - it is older than the retention window, the flow projection has already read it, and it is not
 *   its item's newest save (the ledger's copy of the current document);
 * - it is no delta's base: a delta row is never one, and a whole row goes only when a newer whole
 *   row of its item exists (so no save can still take it as a base) and no delta names it;
 * - a whole row repeats the stage and delivery of the item's previous whole row, so every stage
 *   timeline (the intervention report's "stage before") reads the same;
 * - it is not a delivery event (`DELIVERY_EVENT_PREDICATE`), nor the revision an item's delivery
 *   cites as its authorization (the shipping pulse reads it back), nor a row of an item observed
 *   merged but not yet done (its merge is still judged against the record before it).
 * Every surviving row therefore resolves to exactly the document it resolved to before.
 */
export const ledgerRetentionMs = 14 * 24 * 60 * 60 * 1000;
/** The retention window: `GRAPHYARD_LEDGER_RETENTION_DAYS` (at least one day), else `ledgerRetentionMs`. */
export function configuredLedgerRetentionMs(env: NodeJS.ProcessEnv = process.env) {
  const days = Number(env.GRAPHYARD_LEDGER_RETENTION_DAYS);
  return Number.isFinite(days) && days >= 1 ? Math.floor(days * 24 * 60 * 60 * 1000) : ledgerRetentionMs;
}
/** Rows one batch deletes at most, per phase; each batch is its own short transaction. */
export const ledgerCompactionBatch = 2_000;
/** Batches one run takes at most, so a backlog drains across runs. */
export const ledgerCompactionBatches = 5;
/** How often the server's reconciliation tick runs a compaction. */
export const ledgerCompactionIntervalMs = 10 * 60_000;
/** The audit row each batch that removed anything appends (never itself compacted: not a routine kind). */
export const ledgerCompactedKind = 'ledger.compacted';

const kinds = `ARRAY[${routineSaveKinds.map(kind => `'${kind}'`).join(',')}]::text[]`;

/**
 * The events table's own immutability trigger: every UPDATE is refused, and every DELETE unless it
 * is of a routine kind inside a compaction transaction. Installed with the events DDL in place of
 * the shared `graphyard_immutable` trigger.
 */
export const eventsImmutableDdl = `CREATE OR REPLACE FUNCTION graphyard_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('graphyard.ledger_compaction', true) = 'on' AND OLD.kind = ANY(${kinds}) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'The event ledger is append-only';
END $$;
DROP TRIGGER IF EXISTS immutable_events ON events;
CREATE TRIGGER immutable_events BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION graphyard_events_immutable();`;

// $1 routine kinds, $2 cutoff, $3 batch. `revision` is the revision the candidate row stands for.
const scope = (revision: string) => `e.kind = ANY($1::text[]) AND e.created_at < $2 AND e.seq <= (SELECT last_event FROM flow_projection WHERE id=1)
    AND NOT COALESCE(i.pr_state = 'merged' AND i.stage IS DISTINCT FROM 'done', false)
    AND cited.revision IS DISTINCT FROM ${revision}`;
// The revision the item's delivery cites, from its first delivery event (a delivery is never rewritten).
const cited = `LEFT JOIN LATERAL (SELECT x.payload->'work'->'delivery'->>'authorizationRevision' AS revision FROM events x
    WHERE x.work_id = e.work_id AND ${DELIVERY_EVENT_PREDICATE} ORDER BY x.seq LIMIT 1) cited ON true`;
/** Delta and document-less routine rows: never a base. The item's newest save, its current document, stays. */
const loose = `SELECT e.seq FROM events e JOIN work_index i ON i.id = e.work_id ${cited}
  WHERE ${scope("e.payload->'delta'->>'revision'")} AND NOT (e.payload ? 'work')
    AND EXISTS (SELECT 1 FROM events n WHERE n.work_id = e.work_id AND n.seq > e.seq AND (n.payload ? 'work' OR n.payload ? 'delta'))
  ORDER BY e.created_at LIMIT $3`;
/** Whole routine rows that no save or delta can still need, repeating the previous whole row's stage and delivery. */
const whole = `SELECT e.seq FROM events e JOIN work_index i ON i.id = e.work_id ${cited}
  CROSS JOIN LATERAL (SELECT n.seq FROM events n WHERE n.work_id = e.work_id AND n.seq > e.seq AND n.payload ? 'work' ORDER BY n.seq LIMIT 1) nxt
  CROSS JOIN LATERAL (SELECT p.payload->'work'->'stage' AS stage, p.payload->'work'->'delivery' AS delivery FROM events p
    WHERE p.work_id = e.work_id AND p.seq < e.seq AND p.payload ? 'work' ORDER BY p.seq DESC LIMIT 1) prev
  WHERE ${scope("e.payload->'work'->>'revision'")} AND e.payload ? 'work'
    AND prev.stage IS NOT DISTINCT FROM e.payload->'work'->'stage' AND prev.delivery IS NOT DISTINCT FROM e.payload->'work'->'delivery'
    AND NOT EXISTS (SELECT 1 FROM events d WHERE d.work_id = e.work_id AND d.seq > e.seq AND d.seq < nxt.seq AND d.payload ? 'delta' AND d.payload->'delta'->>'base' = e.seq::text)
    AND NOT EXISTS (SELECT 1 FROM events x WHERE x.seq = e.seq AND ${DELIVERY_EVENT_PREDICATE})
  ORDER BY e.created_at LIMIT $3`;
const remove = (candidates: string) => `DELETE FROM events WHERE seq IN (${candidates}) RETURNING seq, kind`;

export interface LedgerCompaction { removed: Record<string, number>; total: number; batches: number; cutoff: string; skipped?: 'busy' }

/**
 * Compact routine rows older than `retentionMs`, at most `batches` batches of at most `batch` rows
 * per phase. Runs on the pool, outside the coordination lock: a save only ever extends its item's
 * newest whole row, which is never removed. Each batch that removed rows appends one
 * `ledger.compacted` audit row with the counts per kind in the same transaction.
 */
export async function compactLedger(pool: pg.Pool, options: { retentionMs?: number; batch?: number; batches?: number; actor?: string } = {}): Promise<LedgerCompaction> {
  const retentionMs = Math.max(0, Math.floor(options.retentionMs ?? ledgerRetentionMs));
  const batch = Math.max(1, Math.floor(options.batch ?? ledgerCompactionBatch)), batches = Math.max(1, Math.floor(options.batches ?? ledgerCompactionBatches));
  const removed: Record<string, number> = {};
  let total = 0, ran = 0, cutoff = new Date(Date.now() - retentionMs), measured = false;
  for (; ran < batches; ran++) {
    const db = await pool.connect();
    let count = 0, byKind: Record<string, number> = {};
    try {
      await db.query('BEGIN');
      if (!(await db.query('SELECT pg_try_advisory_xact_lock($1) AS ok', [advisoryLocks.ledgerCompaction])).rows[0].ok) {
        await db.query('ROLLBACK');
        return { removed, total, batches: ran, cutoff: cutoff.toISOString(), skipped: 'busy' };
      }
      // One cutoff for the whole run, on the database clock the rows were stamped with.
      if (!measured) { measured = true; cutoff = (await db.query(`SELECT clock_timestamp() - ($1::text||' milliseconds')::interval AS cutoff`, [String(retentionMs)])).rows[0].cutoff; }
      await db.query("SET LOCAL graphyard.ledger_compaction = 'on'");
      const rows = [
        ...(await db.query(remove(loose), [[...routineSaveKinds], cutoff, batch])).rows,
        ...(await db.query(remove(whole), [[...routineSaveKinds], cutoff, batch])).rows,
      ] as { seq: string; kind: string }[];
      await db.query("SET LOCAL graphyard.ledger_compaction = 'off'");
      for (const row of rows) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
      count = rows.length;
      if (count) {
        const seqs = rows.map(row => Number(row.seq));
        await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [options.actor ?? 'graphyard', ledgerCompactedKind,
          JSON.stringify({ details: { removed: byKind, total: count, cutoff: cutoff.toISOString(), retentionMs, firstSeq: Math.min(...seqs), lastSeq: Math.max(...seqs) } })]);
      }
      await db.query('COMMIT');
      for (const [kind, n] of Object.entries(byKind)) removed[kind] = (removed[kind] ?? 0) + n;
      total += count;
    } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; } finally { db.release(); }
    if (!count) { ran++; break; }
  }
  return { removed, total, batches: ran, cutoff: cutoff.toISOString() };
}
