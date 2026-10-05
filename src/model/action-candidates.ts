import { actionSettleMs } from './action-progress.js';
import type { ActionRow } from './actions.js';
import type { NextActionKind } from './next-action.js';
import type { Work } from './work.js';

/**
 * Whether a row is what stands between its item and the merge: a `resync` or `merge` row on an item
 * already at the merge stage. Every other gate has passed, so nothing but this row holds it.
 */
export const unblocksMerge = (work: Work, row: ActionRow) => work.stage === 'merge' && (row.kind === 'resync' || row.kind === 'merge');

/**
 * The order executors claim rows in (GY-1132): the item's priority first, then rows that unblock a
 * merge before any other kind, then the oldest request, then the id so the order is total.
 *
 * Age alone let 34 dispatch rows, hours old and failing on every attempt for want of a worker,
 * hold a P0 item's resync for 25 minutes. Age still decides among peers, so the row open longest
 * among its priority and kind is taken first and none of them starves; a failed row waits out its
 * `retryAt` (`claimable`), and the rows behind it are claimed meanwhile. `claimCandidatesSql`
 * orders the items it finds by the same key, read from each item's first row in this order.
 */
export const claimOrder = (a: { work: Work; row: ActionRow }, b: { work: Work; row: ActionRow }): number =>
  (a.work.priority ?? 2) - (b.work.priority ?? 2)
  || Number(!unblocksMerge(a.work, a.row)) - Number(!unblocksMerge(b.work, b.row))
  || compare(requestedTime(a.row), requestedTime(b.row))
  || compare(a.row.id, b.row.id);
/** A missing or malformed `requestedAt` counts as oldest, as the SQL's `NULLS FIRST` does, so the sort stays total. */
const requestedTime = (row: ActionRow) => { const time = Date.parse(row.requestedAt); return Number.isNaN(time) ? -Infinity : time; };
/** Code-unit order, which is the SQL's `COLLATE "C"` for these ASCII ids; `localeCompare` could disagree with it. */
const compare = <T extends number | string>(a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Whether this row steps aside for `executor` once: its last record is that executor's failed
 * attempt, and it has not yet yielded to it since. One executor then never takes the same failing
 * row twice running while another row is claimable, yet the row yields only one turn — decided
 * from the row alone, so it holds whichever other items the claim happened to load. Claiming the
 * row clears the mark (`claimAction`), so its next failure yields once again.
 */
export const yieldsTo = (row: ActionRow, executor: string) => {
  const last = row.history.at(-1);
  return last?.event === 'failed' && last.executor === executor && row.yielded !== executor;
};

/**
 * The ids of the items holding a row an executor may take now, found in SQL without loading a
 * document: the SQL form of `openActions` (`claimable`, the delivered-item rule, the kinds and the
 * item filter) over the stored rows, read at the database clock. The work index narrows it first
 * (GY-203): only an item one of whose rows is already due by its `due_at` has its document read,
 * so an idle poll touches the index alone and answers from this; a poll that finds candidates
 * loads only those documents, and `claimAction` decides again under the lock, so a row that
 * changed in between is simply not taken.
 *
 * The items come back in claim order (`claimOrder`, GY-1132), each placed by its first claimable
 * row: the item's priority, then a row that unblocks a merge (`resync` or `merge` at the merge
 * stage), then the oldest request, then the row id — so the item whose row `claimAction` takes is
 * the first one listed here. A missing or malformed `requestedAt` counts as oldest rather than
 * failing the whole query, and ids compare bytewise (`COLLATE "C"`), as `claimOrder` does.
 */
export const claimCandidatesSql = `SELECT w.id FROM work_index i JOIN work_items w ON w.id = i.id
  CROSS JOIN LATERAL (SELECT
      CASE WHEN w.document->>'stage' = 'merge' AND entry->>'kind' IN ('resync', 'merge') THEN 0 ELSE 1 END AS unblocks,
      CASE WHEN pg_input_is_valid(entry->>'requestedAt', 'timestamptz') THEN (entry->>'requestedAt')::timestamptz END AS requested,
      (entry->>'id') COLLATE "C" AS row_id
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.document->'actionQueue'->'actions') = 'array' THEN w.document->'actionQueue'->'actions' ELSE '[]'::jsonb END) AS a(entry)
      WHERE (w.document->>'stage' IS DISTINCT FROM 'done' OR entry->>'kind' = 'verify-deployment')
        AND ($2::text[] IS NULL OR entry->>'kind' = ANY($2::text[]))
        AND (entry->>'retryAt' IS NULL OR (entry->>'retryAt')::timestamptz <= clock_timestamp())
        AND NOT (entry->>'state' = 'done' AND entry->>'resolvedAt' IS NOT NULL AND (entry->>'resolvedAt')::timestamptz > clock_timestamp() - make_interval(secs => $3::double precision / 1000))
        AND (entry->>'state' = 'pending' OR jsonb_typeof(entry->'claim') IS DISTINCT FROM 'object' OR (entry->'claim'->>'expiresAt')::timestamptz <= clock_timestamp())
    ORDER BY unblocks, requested NULLS FIRST, row_id LIMIT 1) first
  WHERE i.due_at <= clock_timestamp() AND ($1::text IS NULL OR i.id::text = $1 OR i.key = $1)
  ORDER BY COALESCE(i.priority, 2), first.unblocks, first.requested NULLS FIRST, first.row_id, i.number`;
export const claimCandidatesParams = (work: string | undefined, kinds: readonly NextActionKind[] | undefined) => [work ?? null, kinds ? [...kinds] : null, actionSettleMs];
