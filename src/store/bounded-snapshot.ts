import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { Work } from '../model.js';
import type { IntegrationJob } from '../coordination.js';
import { settledSummariesSql } from './summary-sql.js';

const settledScan = 'FROM work_index i WHERE i.settled OFFSET 0';
if (!settledSummariesSql.includes(settledScan)) throw new Error('settledSummariesSql no longer scans the settled work index as the bounded snapshot expects');
const settledByIdSql = settledSummariesSql.replace('SELECT d.number,', 'SELECT d.id::text AS id, d.number,').replace(settledScan, 'FROM work_index i WHERE i.settled AND i.id = ANY($1::uuid[]) OFFSET 0');
/** A summary is rebuilt at least this often, so sessions leave its 24-hour window (GY-3187). */
const summaryMaxAgeMs = 3_600_000;
type Cached = { version: string; readAt: number; row: { number: string; document: Work } };
const summaryCaches = new WeakMap<pg.Pool, { id: string; entries: Map<string, Cached> }>();

/**
 * The work snapshot every reader polls (GY-422): open items whole, and each settled delivery —
 * done, with nothing owed and nothing running — as its summary (`settledSummariesSql`): the work
 * index's stored settled form without prose, with its bounded timeline, recent sessions and
 * completed-action count. A reader that needs one delivered item's history asks for that document.
 *
 * Settled summaries are kept per pool (GY-3187): every write to an item rewrites its index row, so
 * the row's `xmin` versions the summary, and a poll reads the settled index rows alone, rebuilding
 * only the summaries whose row changed (or aged past `summaryMaxAgeMs`), never every settled document.
 *
 * Every answer carries a `cursor`. A poll that passes the previous one as `since` (GY-3231: the
 * dashboard) gets the open items whole and only the settled summaries rebuilt after it, marked
 * `delta: true`, instead of every settled delivery again: 26 MB every five seconds outran a remote
 * browser's poll, so newly filed items never showed. A cursor from another process is answered whole.
 */
export async function boundedSnapshot(pool: pg.Pool, since?: string | null): Promise<{ work: Work[]; now: string; jobs: IntegrationJob[]; cursor: string; delta?: true }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const caches = summaryCaches.get(pool) ?? { id: randomUUID(), entries: new Map<string, Cached>() };
    summaryCaches.set(pool, caches);
    const cache = caches.entries;
    const versions = new Map<string, string>((await client.query('SELECT i.id::text AS id, i.xmin::text AS version FROM work_index i WHERE i.settled')).rows.map(row => [row.id, row.version]));
    const now = Date.now();
    const stale = [...versions].filter(([id, version]) => cache.get(id)?.version !== version || now - cache.get(id)!.readAt > summaryMaxAgeMs).map(([id]) => id);
    for (const id of cache.keys()) if (!versions.has(id)) cache.delete(id);
    if (stale.length) { const rows = (await client.query(settledByIdSql, [stale])).rows, readAt = Date.now(); for (const { id, ...row } of rows) cache.set(id, { version: versions.get(id)!, readAt, row }); }
    const [sinceId, sinceAt] = since?.split(':') ?? [], after = sinceId === caches.id ? Number(sinceAt) : Number.NaN, cursor = `${caches.id}:${Date.now()}`;
    const settled = [...versions.keys()].map(id => cache.get(id)).filter(entry => entry !== undefined && !(entry.readAt < after)).map(entry => entry!.row);
    const live = (await client.query('SELECT w.number, w.document FROM work_items w WHERE NOT EXISTS (SELECT 1 FROM work_index i WHERE i.id = w.id AND i.settled)')).rows;
    const meta = (await client.query("SELECT statement_timestamp() AS observed_at, (SELECT COALESCE(jsonb_agg(jsonb_build_object('work_id',work_id,'available_at',available_at,'locked_until',locked_until,'error',error,'deferred_reason',deferred_reason,'unobserved',unobserved)), '[]'::jsonb) FROM jobs) AS jobs")).rows[0];
    await client.query('COMMIT');
    const rows = [...settled, ...live].sort((a, b) => Number(a.number) - Number(b.number));
    return { work: rows.map(row => row.document), now: meta.observed_at.toISOString(), jobs: meta.jobs, cursor, ...(Number.isFinite(after) ? { delta: true as const } : {}) };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

/** One item's whole document by id or display key, or null; the key is matched on the work index, so no other document is read. */
export async function workDocument(pool: pg.Pool, idOrKey: string): Promise<Work | null> {
  const row = (await pool.query('SELECT w.document FROM work_index i JOIN work_items w ON w.id = i.id WHERE i.id::text = $1 OR i.key = $1 ORDER BY i.number LIMIT 1', [idOrKey])).rows[0];
  return row?.document ?? null;
}
