import type { Store } from './store.js';
import { save } from './store.js';
import { demand, type Work } from './model.js';
import { flowLimits } from './flow-analytics.js';
import { ledgerEntry, ledgerReplayColumns, mergeTimeline, pipelineTimeline, timelineReplay, type TimelineBackfill } from './pipeline-speed.js';

/**
 * Populating the per-item timeline for the items that predate it.
 *
 * The timeline shipped as something the lifecycle commands append to, so only items claimed after
 * it existed carry one and every earlier delivery is reported as unmeasured — which was every
 * delivery the pipeline had made. The facts were never missing: each command wrote the whole work
 * document into the append-only ledger, so an item's attempts, submissions, reworks and hand-offs
 * can be replayed from its own history.
 *
 * This is that replay. Reading the ledger and recording the result are two different costs and
 * are kept apart:
 *
 * - The read never selects an event's payload. Every row embeds the whole work document, and the
 *   routine rows that are most of a long-lived item's ledger are thousands of such documents, so
 *   the read projects the few JSON paths the replay uses (`ledgerReplayColumns`), a page of
 *   `flowLimits.batch` rows at a time, folds each page into the replay and drops it. It runs on a
 *   plain pool connection: the coordination lock every claim, heartbeat and submit serializes on
 *   is never held while ledger rows are transferred or parsed.
 * - The write is one short coordination transaction per item, recorded like any other domain
 *   mutation: it re-reads the document, refuses if anything but the timeline would move, and
 *   appends its own `pipeline.backfilled` event with the range of ledger rows that were read.
 *
 * One run reads a bounded number of rows. An item whose ledger outlasts the bound is not given up
 * on: the marker records where the replay stood (`resume`) and the next run continues from the
 * row after `toEvent`, so a ledger of any length is read to its end, and only then is the item's
 * timeline written (see `mergeTimeline`). A finished marker is what makes the work bounded — an
 * item is reconstructed once, never on every read.
 *
 * Rows a lifecycle command appends while a reconstruction is reading are not lost to it: every
 * such command records the live timeline on the document, which the write re-reads under the lock
 * and unites with the replay.
 *
 * It reaches delivered items, because those are the ones a delivery measurement is about, and the
 * only field it may touch is the derived `pipeline` timeline: no gate, requirement, candidate,
 * evidence or delivery field is writable here, and the transaction refuses to write if anything
 * else changed. A delivered item's intent stays immutable; only the report of what already
 * happened to it becomes readable.
 */
export const backfillLimits = { items: 25, events: 20_000, page: flowLimits.batch, settledMs: 300_000 } as const;

export interface TimelineBackfillRun {
  at: string; scanned: number; backfilled: number; pending: boolean;
  /** Ledger rows this run read, over every item; the run stops reading at `backfillLimits.events`. */
  events: number;
  items: { key: string; events: number; retained: boolean; truncated: boolean; measured: boolean }[];
  /** Items whose reconstruction failed in this run. Each is set aside so the rest of the queue proceeds. */
  failed: { key: string; error: string }[];
}

interface PendingItem { id: string; key: string; backfill: TimelineBackfill | null }
/**
 * Items whose timeline has never been reconstructed, or whose reconstruction is unfinished,
 * oldest first; a finished marker is never re-read. Only the marker is selected, not the document.
 */
async function pendingItems(store: Store, limit: number, skip: string[]): Promise<PendingItem[]> {
  return (await store.pool.query(`SELECT id, document->>'key' AS key, document->'pipeline'->'backfill' AS backfill FROM work_items
     WHERE (document->'pipeline'->'backfill' IS NULL OR document->'pipeline'->'backfill'->>'truncated'='true') AND NOT (id=ANY($2::uuid[]))
     ORDER BY number LIMIT $1`, [limit, skip])).rows;
}

interface TimelineBackfillFailure { key: string; error: string; at: number }
const state: { lastRun: TimelineBackfillRun | null; lastError: string | null; settledUntil: number; backfilled: number; running: boolean; failed: Map<string, TimelineBackfillFailure> } =
  { lastRun: null, lastError: null, settledUntil: 0, backfilled: 0, running: false, failed: new Map() };

/**
 * Reconstruct the timelines of up to `items` items, reading at most `events` ledger rows in all.
 * Each item is read outside the coordination lock and written in one short transaction of its
 * own. A failure belongs to its item: it is recorded, the item is set aside for the settle
 * window, and the run moves on, so one unreadable item never blocks the ones queued behind it.
 */
export async function backfillPipelineTimelines(store: Store, options: { items?: number; events?: number; page?: number; now?: number } = {}): Promise<TimelineBackfillRun> {
  const limit = Math.max(1, Math.min(options.items ?? backfillLimits.items, backfillLimits.items));
  const eventLimit = Math.max(1, Math.min(options.events ?? backfillLimits.events, backfillLimits.events));
  const pageSize = Math.max(1, Math.min(options.page ?? backfillLimits.page, backfillLimits.page));
  const clock = options.now ?? Date.now();
  for (const [id, failure] of state.failed) if (failure.at + backfillLimits.settledMs <= clock) state.failed.delete(id);
  const queue = await pendingItems(store, limit + 1, [...state.failed.keys()]);
  const selected = queue.slice(0, limit);
  const run: TimelineBackfillRun = { at: new Date(clock).toISOString(), scanned: 0, backfilled: 0, pending: queue.length > limit, events: 0, items: [], failed: [] };
  for (const queued of selected) {
    // The row bound is the run's, not the item's: what is left unread stays pending for the next run.
    if (run.events >= eventLimit) { run.pending = true; break; }
    run.scanned++;
    try {
      const marker = queued.backfill;
      const replay = timelineReplay(marker?.resume);
      let cursor = marker?.toEvent ?? '0', read = 0, exhausted = false;
      let fromEvent = marker?.fromEvent ?? null, retained = marker?.retained ?? false;
      while (!exhausted && run.events + read < eventLimit) {
        const size = Math.min(pageSize, eventLimit - run.events - read);
        const rows = (await store.pool.query(`SELECT ${ledgerReplayColumns} FROM events WHERE work_id=$1 AND seq>$2 ORDER BY seq LIMIT $3`, [queued.id, cursor, size])).rows;
        if (rows.length && !marker && !read) {
          fromEvent = String(rows[0].seq);
          // An item whose first retained row is not its creation lost history to retention; its
          // reconstruction is a floor, and the speed report says so rather than counting it as measured.
          retained = rows[0].kind === 'create';
        }
        for (const row of rows) replay.apply(ledgerEntry(row));
        if (rows.length) cursor = String(rows.at(-1).seq);
        read += rows.length;
        exhausted = rows.length < size;
      }
      run.events += read;
      const applied = await store.transaction(async (db, now) => {
        const work: Work | undefined = (await db.query('SELECT document FROM work_items WHERE id=$1', [queued.id])).rows[0]?.document;
        // Re-read inside the transaction: another replica may have continued or finished this item.
        const current = work?.pipeline?.backfill ?? null;
        if (!work || (current?.toEvent ?? null) !== (marker?.toEvent ?? null) || !current !== !marker || (current && !current.truncated)) return null;
        const backfill: TimelineBackfill = {
          at: now.toISOString(), source: 'ledger', events: (marker?.events ?? 0) + read, fromEvent, toEvent: read || marker ? cursor : null,
          retained, truncated: !exhausted, passes: (marker?.passes ?? 0) + 1, ...(exhausted ? {} : { resume: replay.state() }),
        };
        const untouched = JSON.stringify({ ...work, pipeline: null });
        // Only a ledger read to its end is a timeline; until then the marker alone moves.
        if (exhausted) work.pipeline = mergeTimeline(work.pipeline, replay.timeline(), backfill);
        else pipelineTimeline(work).backfill = backfill;
        // The reconstruction is a report, not a decision: nothing but the timeline may move.
        demand(untouched === JSON.stringify({ ...work, pipeline: null }), `Timeline reconstruction of ${work.key} would change more than its pipeline timeline`, 500);
        await save(db, work, 'graphyard', 'pipeline.backfilled', now, { events: backfill.events, fromEvent: backfill.fromEvent, toEvent: backfill.toEvent, retained: backfill.retained, truncated: backfill.truncated, passes: backfill.passes, attempts: work.pipeline!.attempts.length, submittedAt: work.pipeline!.submittedAt });
        return { key: work.key, events: backfill.events, retained: backfill.retained, truncated: backfill.truncated, measured: work.pipeline!.submittedAt !== null };
      });
      if (applied) { run.backfilled++; run.items.push(applied); if (applied.truncated) run.pending = true; }
    } catch (error: any) {
      const message = error?.message ?? String(error);
      state.failed.set(queued.id, { key: queued.key, error: message, at: clock });
      run.failed.push({ key: queued.key, error: message });
    }
  }
  return run;
}

export interface TimelineBackfillState {
  lastRun: TimelineBackfillRun | null; lastError: string | null; settled: boolean; backfilled: number;
  /** Items set aside after a failed reconstruction; each is retried once the settle window has passed. */
  failed: { key: string; error: string; at: string }[];
}

/** What the catch-up has done in this process, for the control-plane status read. */
export const pipelineBackfillState = (now = Date.now()): TimelineBackfillState =>
  ({ lastRun: state.lastRun, lastError: state.lastError, settled: state.settledUntil > now, backfilled: state.backfilled,
    failed: [...state.failed.values()].map(failure => ({ key: failure.key, error: failure.error, at: new Date(failure.at).toISOString() })) });

/**
 * The bounded catch-up the work-snapshot read runs, in the shape the flow projection uses: a
 * little work per read until nothing is left, then nothing at all until the settle window lapses,
 * so a converged installation pays one small query over the work items and no writes. One catch-up
 * runs at a time in a process: a poll that arrives while another is reconstructing reads its
 * snapshot without walking the same queue. A failure is recorded and reported through
 * `/api/status` rather than failing the read the master polls.
 */
export async function catchUpPipelineTimelines(store: Store, options: { items?: number; events?: number; page?: number; now?: number } = {}): Promise<TimelineBackfillRun | null> {
  const now = options.now ?? Date.now();
  if (state.running || state.settledUntil > now) return null;
  state.running = true;
  try {
    const run = await backfillPipelineTimelines(store, { ...options, now });
    state.lastRun = run; state.lastError = null; state.backfilled += run.backfilled;
    state.settledUntil = run.pending ? 0 : now + backfillLimits.settledMs;
    return run;
  } catch (error: any) {
    state.lastError = error?.message ?? String(error);
    // Retry on the next read rather than hammering a failing database on every poll.
    state.settledUntil = now + backfillLimits.settledMs;
    return null;
  } finally { state.running = false; }
}

/** Test seam: forget what this process has done, so a fresh catch-up runs immediately. */
export function resetPipelineBackfillState() { state.lastRun = null; state.lastError = null; state.settledUntil = 0; state.backfilled = 0; state.running = false; state.failed.clear(); }
