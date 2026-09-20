import type pg from 'pg';
import type { Store } from './store.js';
import { save } from './store.js';
import { demand, type Work } from './model.js';
import { mergeTimeline, reconstructTimeline, type LedgerEntry, type TimelineBackfill } from './pipeline-speed.js';

/**
 * Populating the per-item timeline for the items that predate it.
 *
 * The timeline shipped as something the lifecycle commands append to, so only items claimed after
 * it existed carry one and every earlier delivery is reported as unmeasured — which was every
 * delivery the pipeline had made. The facts were never missing: each command wrote the whole work
 * document into the append-only ledger, so an item's attempts, submissions, reworks and hand-offs
 * can be replayed from its own history.
 *
 * This is that replay, run once per item and recorded like any other domain mutation: inside the
 * coordination transaction, appending its own `pipeline.backfilled` event with the range of ledger
 * rows it read. Whatever a live command recorded wins; the reconstruction only fills the gaps
 * (see `mergeTimeline`). The marker it leaves on the document is what makes the work bounded —
 * an item is reconstructed once, never on every read.
 *
 * It reaches delivered items, because those are the ones a delivery measurement is about, and the
 * only field it may touch is the derived `pipeline` timeline: no gate, requirement, candidate,
 * evidence or delivery field is writable here, and the transaction refuses to write if anything
 * else changed. A delivered item's intent stays immutable; only the report of what already
 * happened to it becomes readable.
 */
export const backfillLimits = { items: 25, events: 20_000, settledMs: 300_000 } as const;

export interface TimelineBackfillRun {
  at: string; scanned: number; backfilled: number; pending: boolean;
  items: { key: string; events: number; retained: boolean; truncated: boolean; measured: boolean }[];
}

/** Items whose timeline has never been reconstructed, oldest first; a marked document is never re-read. */
async function pendingItems(db: pg.PoolClient, limit: number): Promise<Work[]> {
  return (await db.query(`SELECT document FROM work_items WHERE document->'pipeline'->'backfill' IS NULL ORDER BY number LIMIT $1`, [limit])).rows.map(row => row.document);
}

/**
 * Reconstruct the timelines of up to `items` items. Each item is one transaction: a long ledger
 * never holds the coordination lock for the whole batch, and a failure part way leaves every item
 * already reconstructed marked and the rest pending.
 */
export async function backfillPipelineTimelines(store: Store, options: { items?: number; events?: number } = {}): Promise<TimelineBackfillRun> {
  const limit = Math.max(1, Math.min(options.items ?? backfillLimits.items, backfillLimits.items));
  const eventLimit = Math.max(1, Math.min(options.events ?? backfillLimits.events, backfillLimits.events));
  const queue = await store.transaction(db => pendingItems(db, limit + 1));
  const selected = queue.slice(0, limit);
  const run: TimelineBackfillRun = { at: new Date().toISOString(), scanned: selected.length, backfilled: 0, pending: queue.length > limit, items: [] };
  for (const queued of selected) {
    const applied = await store.transaction(async (db, now) => {
      // Re-read inside the transaction: another replica may have reconstructed this item already.
      const work: Work | undefined = (await db.query('SELECT document FROM work_items WHERE id=$1', [queued.id])).rows[0]?.document;
      if (!work || work.pipeline?.backfill) return null;
      const rows = (await db.query('SELECT seq,kind,payload,created_at FROM events WHERE work_id=$1 ORDER BY seq LIMIT $2', [work.id, eventLimit + 1])).rows as LedgerEntry[];
      const truncated = rows.length > eventLimit;
      const events = truncated ? rows.slice(0, eventLimit) : rows;
      const backfill: TimelineBackfill = {
        at: now.toISOString(), source: 'ledger', events: events.length,
        fromEvent: events[0] ? String(events[0].seq) : null, toEvent: events.at(-1) ? String(events.at(-1)!.seq) : null,
        // An item whose first retained row is not its creation lost history to retention; its
        // reconstruction is a floor, and the speed report says so rather than counting it as measured.
        retained: events[0]?.kind === 'create', truncated,
      };
      const untouched = JSON.stringify({ ...work, pipeline: null });
      work.pipeline = mergeTimeline(work.pipeline, reconstructTimeline(events), backfill);
      // The reconstruction is a report, not a decision: nothing but the timeline may move.
      demand(untouched === JSON.stringify({ ...work, pipeline: null }), `Timeline reconstruction of ${work.key} would change more than its pipeline timeline`, 500);
      await save(db, work, 'graphyard', 'pipeline.backfilled', now, { events: backfill.events, fromEvent: backfill.fromEvent, toEvent: backfill.toEvent, retained: backfill.retained, truncated: backfill.truncated, attempts: work.pipeline.attempts.length, submittedAt: work.pipeline.submittedAt });
      return { key: work.key, events: backfill.events, retained: backfill.retained, truncated, measured: work.pipeline.submittedAt !== null };
    });
    if (applied) { run.backfilled++; run.items.push(applied); }
  }
  return run;
}

export interface TimelineBackfillState { lastRun: TimelineBackfillRun | null; lastError: string | null; settled: boolean; backfilled: number }
const state: { lastRun: TimelineBackfillRun | null; lastError: string | null; settledUntil: number; backfilled: number } = { lastRun: null, lastError: null, settledUntil: 0, backfilled: 0 };

/** What the catch-up has done in this process, for the control-plane status read. */
export const pipelineBackfillState = (now = Date.now()): TimelineBackfillState =>
  ({ lastRun: state.lastRun, lastError: state.lastError, settled: state.settledUntil > now, backfilled: state.backfilled });

/**
 * The bounded catch-up the work-snapshot read runs, in the shape the flow projection uses: a
 * little work per read until nothing is left, then nothing at all until the settle window lapses,
 * so a converged installation pays one indexed lookup and no writes. A failure is recorded and
 * reported through `/api/status` rather than failing the read the master polls.
 */
export async function catchUpPipelineTimelines(store: Store, options: { items?: number; events?: number; now?: number } = {}): Promise<TimelineBackfillRun | null> {
  const now = options.now ?? Date.now();
  if (state.settledUntil > now) return null;
  try {
    const run = await backfillPipelineTimelines(store, options);
    state.lastRun = run; state.lastError = null; state.backfilled += run.backfilled;
    state.settledUntil = run.pending ? 0 : now + backfillLimits.settledMs;
    return run;
  } catch (error: any) {
    state.lastError = error?.message ?? String(error);
    // Retry on the next read rather than hammering a failing database on every poll.
    state.settledUntil = now + backfillLimits.settledMs;
    return null;
  }
}

/** Test seam: forget what this process has done, so a fresh catch-up runs immediately. */
export function resetPipelineBackfillState() { state.lastRun = null; state.lastError = null; state.settledUntil = 0; state.backfilled = 0; }
