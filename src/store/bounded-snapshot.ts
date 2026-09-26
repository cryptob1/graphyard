import type pg from 'pg';
import type { Work } from '../model.js';
import type { IntegrationJob } from '../coordination.js';
import { settledSummariesSql } from './summary-sql.js';

/**
 * The work snapshot every reader polls (GY-422): open items whole, and each settled delivery —
 * done, with nothing owed and nothing running — as its summary (`settledSummariesSql`): the work
 * index's stored settled form without prose, with its bounded timeline, recent sessions and
 * completed-action count. A reader that needs one delivered item's history asks for that document.
 */
export async function boundedSnapshot(pool: pg.Pool): Promise<{ work: Work[]; now: string; jobs: IntegrationJob[] }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const settled = (await client.query(settledSummariesSql)).rows;
    const live = (await client.query('SELECT w.number, w.document FROM work_items w WHERE NOT EXISTS (SELECT 1 FROM work_index i WHERE i.id = w.id AND i.settled)')).rows;
    const meta = (await client.query("SELECT statement_timestamp() AS observed_at, (SELECT COALESCE(jsonb_agg(jsonb_build_object('work_id',work_id,'available_at',available_at,'locked_until',locked_until,'error',error,'held_until',held_until)), '[]'::jsonb) FROM jobs) AS jobs")).rows[0];
    await client.query('COMMIT');
    const rows = [...settled, ...live].sort((a, b) => Number(a.number) - Number(b.number));
    return { work: rows.map(row => row.document), now: meta.observed_at.toISOString(), jobs: meta.jobs };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

/** One item's whole document by id or display key, or null; the key is matched on the work index, so no other document is read. */
export async function workDocument(pool: pg.Pool, idOrKey: string): Promise<Work | null> {
  const row = (await pool.query('SELECT w.document FROM work_index i JOIN work_items w ON w.id = i.id WHERE i.id::text = $1 OR i.key = $1 ORDER BY i.number LIMIT 1', [idOrKey])).rows[0];
  return row?.document ?? null;
}
