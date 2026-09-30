import type pg from 'pg';
import type { Work } from '../model.js';
import type { IntegrationJob } from '../coordination.js';
import { settledSummariesSql } from './summary-sql.js';

/**
 * One page of GET /api/work-snapshot (GY-864): items numbered after `cursor`, at most `pageSize` of them.
 * `visible` (ids or keys) limits the page to a scoped reader's work, so its rows and its paging fields
 * are derived from that work alone and never disclose the numbers of items outside it.
 */
export interface SnapshotPage { cursor?: number; pageSize: number; visible?: readonly string[] }

const jobsSql = "SELECT statement_timestamp() AS observed_at, (SELECT COALESCE(jsonb_agg(jsonb_build_object('work_id',work_id,'available_at',available_at,'locked_until',locked_until,'error',error,'held_until',held_until,'deferred_reason',deferred_reason,'unobserved',unobserved)), '[]'::jsonb) FROM jobs) AS jobs";
const settledScan = 'FROM work_index i WHERE i.settled OFFSET 0';
if (!settledSummariesSql.includes(settledScan)) throw new Error('settledSummariesSql no longer scans the settled work index as the paged snapshot expects');
// The settled summaries of the page's numbers only: they are applied where the index is scanned,
// so no document outside the page is read.
const settledInPageSql = settledSummariesSql.replace(settledScan, 'FROM work_index i WHERE i.settled AND i.number = ANY($1::bigint[]) OFFSET 0');

/**
 * A page of the work snapshot, read in the database: the page's numbers are chosen first from the
 * numbers alone (and, for a scoped reader, its visible work), then only those documents (or settled
 * summaries, for the bounded view) are read, so a page costs the same however large the ledger
 * grows. `full` pages whole documents; `bounded` pages the default view (open items whole,
 * settled deliveries summarized).
 */
export async function snapshotPage(pool: pg.Pool, view: 'bounded' | 'full', page: SnapshotPage): Promise<{ work: Work[]; now: string; jobs: IntegrationJob[]; hasMore: boolean; nextCursor?: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const after = page.cursor ?? 0;
    // A scoped reader's keys are matched on the index, so choosing its page detoasts no document.
    const numbers = (await client.query('SELECT w.number FROM work_items w LEFT JOIN work_index i ON i.id = w.id WHERE w.number > $1 AND ($3::text[] IS NULL OR w.id::text = ANY($3) OR i.key = ANY($3)) ORDER BY w.number LIMIT $2', [after, page.pageSize + 1, page.visible ?? null])).rows.map(row => Number(row.number));
    const hasMore = numbers.length > page.pageSize, selected = numbers.slice(0, page.pageSize), last = selected.at(-1) ?? after;
    const rows = !selected.length ? [] : view === 'full'
      ? (await client.query('SELECT number, document FROM work_items WHERE number = ANY($1::bigint[])', [selected])).rows
      : [
        ...(await client.query(settledInPageSql, [selected])).rows,
        ...(await client.query('SELECT w.number, w.document FROM work_items w WHERE w.number = ANY($1::bigint[]) AND NOT EXISTS (SELECT 1 FROM work_index i WHERE i.id = w.id AND i.settled)', [selected])).rows,
      ];
    const meta = (await client.query(jobsSql)).rows[0];
    await client.query('COMMIT');
    rows.sort((a, b) => Number(a.number) - Number(b.number));
    return { work: rows.map(row => row.document), now: meta.observed_at.toISOString(), jobs: meta.jobs, hasMore, ...(hasMore ? { nextCursor: last } : {}) };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
