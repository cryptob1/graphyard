import type pg from 'pg';
import type { Work } from '../model.js';
import { servedFor } from '../model/release.js';

export const replayColumns = ['Up next', 'Building', 'Review', 'Trial', 'Merged', 'Shipped'] as const;
export interface ReplayPoint { at: number; column: number; runner: string | null }
export interface ReplayItem { id: string; key: string; points: ReplayPoint[] }
export interface WorkReplay { start: number; end: number; items: ReplayItem[] }
function column(work: Work) {
  if (work.closure) return -1;
  switch (work.stage) {
    case 'backlog': case 'ready': return 0;
    case 'build': return 1;
    case 'review': return 2;
    case 'test': case 'acceptance': case 'merge': return 3;
    case 'done': return work.delivery ? servedFor(work) ? 5 : 4 : -1;
  }
}

/** Lifecycle saves stay whole; release observations may be deltas. Read the window and
 * each participating item's preceding snapshot in one statement, never one request per item. */
export async function readWorkReplay(db: Pick<pg.Pool, 'query'>, hours: number, end = Date.now()): Promise<WorkReplay> {
  const start = end - hours * 3_600_000;
  const result = await db.query(`WITH recent AS MATERIALIZED (
    SELECT seq, work_id, created_at, payload FROM events
    WHERE created_at >= $1 AND created_at <= $2 AND work_id IS NOT NULL
      AND (payload ? 'work' OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(payload->'delta'->'ops', '[]')) op
        WHERE op->0->>0 IN ('stage', 'delivery', 'releaseDeliveries')))
  ), snapshots AS (
    SELECT * FROM recent UNION ALL
    SELECT preceding.* FROM (SELECT DISTINCT work_id FROM recent) item
    CROSS JOIN LATERAL (SELECT seq, work_id, created_at, payload FROM events
      WHERE work_id = item.work_id AND created_at < $1 AND (payload ? 'work' OR payload ? 'delta')
      ORDER BY seq DESC LIMIT 1) preceding
  ) SELECT created_at, graphyard_event_work(work_id, payload) AS work FROM snapshots ORDER BY created_at, seq`, [new Date(start), new Date(end)]);
  const items = new Map<string, ReplayItem>();
  for (const row of result.rows) {
    const work = row.work as Work;
    if (!work) continue;
    const item = items.get(work.id) ?? { id: work.id, key: work.key, points: [] };
    const point = { at: Math.max(start, new Date(row.created_at).getTime()), column: column(work), runner: work.lease?.owner ?? work.implementers?.at(-1) ?? null };
    const last = item.points.at(-1);
    if (!last || last.column !== point.column || last.runner !== point.runner) item.points.push(point);
    items.set(work.id, item);
  }
  return { start, end, items: [...items.values()].filter(item => item.points.some(point => point.at > start && point.column >= 0)) };
}
