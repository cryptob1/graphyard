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
 * - it is older than the retention window, and it is not
 *   its item's newest save (the ledger's copy of the current document);
 * - it is no delta's base: a delta row is never one, and a whole row goes only when a newer whole
 *   row of its item exists (so no save can still take it as a base) and no delta names it;
 * - a whole row repeats the stage and delivery of the item's previous whole row, so every stage
 *   timeline (the intervention report's "stage before") reads the same;
 * - it is not a delivery event (`DELIVERY_EVENT_PREDICATE`), nor the revision an item's delivery
 *   cites as its authorization, nor a row of an item observed
 *   merged but not yet done (its merge is still judged against the record before it).
 * Every surviving row therefore resolves to exactly the document it resolved to before.
 *
 * A batch reads a window of the ledger in seq order from a saved cursor (GY-3111), never the whole
 * ledger ordered by age: each finishes well inside the statement timeout, and a run keeps the
 * progress of every batch it committed.
 */
export const ledgerRetentionMs = 14 * 24 * 60 * 60 * 1000;
/** The retention window: `GRAPHYARD_LEDGER_RETENTION_DAYS` (at least one day), else `ledgerRetentionMs`. */
export function configuredLedgerRetentionMs(env: NodeJS.ProcessEnv = process.env) {
  const days = Number(env.GRAPHYARD_LEDGER_RETENTION_DAYS);
  return Number.isFinite(days) && days >= 1 ? Math.floor(days * 24 * 60 * 60 * 1000) : ledgerRetentionMs;
}
/** Ledger rows one batch reads (and so deletes at most); each batch is its own short transaction. */
export const ledgerCompactionBatch = 2_000;
/** Batches one run takes at most; the saved cursor carries a pass across runs. */
export const ledgerCompactionBatches = 20;
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

// $1 routine kinds, $2 cutoff, $3 window start (exclusive), $4 window end (inclusive): a batch reads only
// the rows of its own seq window. The items in the window are taken once, with the revision each one's
// delivery cites (its first delivery event, through events_work_delivery; a delivery is never
// rewritten); an item observed merged but not yet done is left out whole.
const items = `WITH items AS MATERIALIZED (SELECT w.work_id, (SELECT x.payload->'work'->'delivery'->>'authorizationRevision' FROM events x
      WHERE x.work_id = w.work_id AND ${DELIVERY_EVENT_PREDICATE} ORDER BY x.seq LIMIT 1) AS cited
    FROM (SELECT DISTINCT work_id FROM events WHERE seq > $3 AND seq <= $4 AND work_id IS NOT NULL) w JOIN work_index i ON i.id = w.work_id
    WHERE NOT COALESCE(i.pr_state = 'merged' AND i.stage IS DISTINCT FROM 'done', false))`;
// `revision` is the revision the candidate row stands for.
const scope = (revision: string) => `e.seq > $3 AND e.seq <= $4 AND e.kind = ANY($1::text[]) AND e.created_at < $2 AND c.cited IS DISTINCT FROM ${revision}`;
/** Delta and document-less routine rows: never a base. The item's newest save, its current document, stays. */
const loose = `${items} SELECT e.seq FROM events e JOIN items c ON c.work_id = e.work_id
  WHERE ${scope("e.payload->'delta'->>'revision'")} AND NOT (e.payload ? 'work')
    AND EXISTS (SELECT 1 FROM events n WHERE n.work_id = e.work_id AND n.seq > e.seq AND (n.payload ? 'work' OR n.payload ? 'delta'))`;
/** Whole routine rows that no save or delta can still need, repeating the previous whole row's stage and delivery. */
const whole = `${items} SELECT e.seq FROM events e JOIN items c ON c.work_id = e.work_id
  CROSS JOIN LATERAL (SELECT n.seq FROM events n WHERE n.work_id = e.work_id AND n.seq > e.seq AND n.payload ? 'work' ORDER BY n.seq LIMIT 1) nxt
  CROSS JOIN LATERAL (SELECT p.payload->'work'->'stage' AS stage, p.payload->'work'->'delivery' AS delivery FROM events p
    WHERE p.work_id = e.work_id AND p.seq < e.seq AND p.payload ? 'work' ORDER BY p.seq DESC LIMIT 1) prev
  WHERE ${scope("e.payload->'work'->>'revision'")} AND e.payload ? 'work'
    AND prev.stage IS NOT DISTINCT FROM e.payload->'work'->'stage' AND prev.delivery IS NOT DISTINCT FROM e.payload->'work'->'delivery'
    AND NOT EXISTS (SELECT 1 FROM events d WHERE d.work_id = e.work_id AND d.payload ? 'delta' AND d.payload->'delta'->>'base' = e.seq::text AND d.seq > e.seq AND d.seq < nxt.seq)
    AND NOT EXISTS (SELECT 1 FROM events x WHERE x.seq = e.seq AND ${DELIVERY_EVENT_PREDICATE})`;
const remove = (candidates: string) => `DELETE FROM events WHERE seq IN (${candidates}) RETURNING seq, kind`;

export interface LedgerCompaction { removed: Record<string, number>; total: number; batches: number; cutoff: string; cursor: number; skipped?: 'busy' }

/**
 * Compact routine rows older than `retentionMs`: at most `batches` batches, each reading the next
 * `batch` ledger rows past the saved cursor (`ledger_compaction_cursor`). Each batch is one short
 * transaction that deletes what may go in its window, appends one `ledger.compacted` audit row with
 * the counts per kind when it removed anything, and saves the cursor at the window's end, so a run
 * resumes where the last stopped. Past the newest row old enough to compact, the cursor returns to
 * the start for the next pass. Runs on the pool, outside the coordination lock: a save only ever
 * extends its item's newest whole row, which is never removed.
 */
export async function compactLedger(pool: pg.Pool, options: { retentionMs?: number; batch?: number; batches?: number; actor?: string } = {}): Promise<LedgerCompaction> {
  const retentionMs = Math.max(0, Math.floor(options.retentionMs ?? ledgerRetentionMs));
  const batch = Math.max(1, Math.floor(options.batch ?? ledgerCompactionBatch)), batches = Math.max(1, Math.floor(options.batches ?? ledgerCompactionBatches));
  const removed: Record<string, number> = {};
  let total = 0, ran = 0, cutoff = new Date(Date.now() - retentionMs), upper: string | null = null, cursor = '0', measured = false;
  for (; ran < batches; ran++) {
    const db = await pool.connect();
    let end: string | null = null, byKind: Record<string, number> = {};
    try {
      await db.query('BEGIN');
      if (!(await db.query('SELECT pg_try_advisory_xact_lock($1) AS ok', [advisoryLocks.ledgerCompaction])).rows[0].ok) {
        await db.query('ROLLBACK');
        return { removed, total, batches: ran, cutoff: cutoff.toISOString(), cursor: Number(cursor), skipped: 'busy' };
      }
      // One cutoff for the whole run, on the database clock the rows were stamped with, and the newest row it reaches.
      if (!measured) {
        measured = true;
        cutoff = (await db.query(`SELECT clock_timestamp() - ($1::text||' milliseconds')::interval AS cutoff`, [String(retentionMs)])).rows[0].cutoff;
        upper = (await db.query('SELECT seq FROM events WHERE created_at < $1 ORDER BY created_at DESC, seq DESC LIMIT 1', [cutoff])).rows[0]?.seq ?? '0';
        cursor = (await db.query('SELECT seq FROM ledger_compaction_cursor')).rows[0]?.seq ?? '0';
      }
      end = (await db.query('SELECT max(seq) AS seq FROM (SELECT seq FROM events WHERE seq > $1 AND seq <= $2 ORDER BY seq LIMIT $3) w', [cursor, upper, batch])).rows[0].seq;
      await db.query("SET LOCAL graphyard.ledger_compaction = 'on'");
      const rows = end === null ? [] : [
        ...(await db.query(remove(loose), [[...routineSaveKinds], cutoff, cursor, end])).rows,
        ...(await db.query(remove(whole), [[...routineSaveKinds], cutoff, cursor, end])).rows,
      ] as { seq: string; kind: string }[];
      await db.query("SET LOCAL graphyard.ledger_compaction = 'off'");
      for (const row of rows) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
      if (rows.length) {
        const seqs = rows.map(row => Number(row.seq));
        await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [options.actor ?? 'graphyard', ledgerCompactedKind,
          JSON.stringify({ details: { removed: byKind, total: rows.length, cutoff: cutoff.toISOString(), retentionMs, firstSeq: Math.min(...seqs), lastSeq: Math.max(...seqs) } })]);
      }
      await db.query('INSERT INTO ledger_compaction_cursor(id,seq) VALUES(true,$1) ON CONFLICT (id) DO UPDATE SET seq = EXCLUDED.seq', [end ?? '0']);
      await db.query('COMMIT');
      cursor = end ?? '0';
      for (const [kind, n] of Object.entries(byKind)) removed[kind] = (removed[kind] ?? 0) + n;
      total += rows.length;
    } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; } finally { db.release(); }
    if (end === null) { ran++; break; }
  }
  return { removed, total, batches: ran, cutoff: cutoff.toISOString(), cursor: Number(cursor) };
}
