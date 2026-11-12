import type pg from 'pg';
import { demand } from '../model.js';
import type { TrialScreenshots } from '../model/trial-screenshots.js';
import type { Services } from './routes.js';

/** How long the control plane keeps a trial's screenshots (GY-3267). */
export const trialScreenshotRetentionDays = 30;

/**
 * GY-3267: keep the screenshots of a trial record — one row per browser case, the item's earlier
 * rows replaced, and every row past its retention taken back in the same transaction — and answer
 * the names the item's page reads. The bytes never reach the ledger.
 */
export async function keepTrialScreenshots(db: pg.PoolClient, workId: string, shots: readonly { case: string; before?: string; after?: string }[]): Promise<TrialScreenshots['cases']> {
  await db.query('DELETE FROM trial_case_screenshots WHERE work_id=$1', [workId]);
  const cases: TrialScreenshots['cases'] = [];
  for (const shot of shots) {
    const before = shot.before === undefined ? null : Buffer.from(shot.before, 'base64');
    const after = shot.after === undefined ? null : Buffer.from(shot.after, 'base64');
    if (!before && !after) continue;
    await db.query('INSERT INTO trial_case_screenshots(work_id, case_name, before_bytes, after_bytes) VALUES($1,$2,$3,$4)', [workId, shot.case, before, after]);
    cases.push({ case: shot.case, ...(before ? { before: true } : {}), ...(after ? { after: true } : {}) });
  }
  await db.query('DELETE FROM trial_case_screenshots WHERE recorded_at < now() - make_interval(days => $1)', [trialScreenshotRetentionDays]);
  return cases;
}

/** One kept screenshot of an item's merge trial, for its page; 404 when none is kept by that case and side. */
export async function readTrialScreenshot(services: Services, id: string, name: string, side: 'before' | 'after'): Promise<Buffer> {
  const column = side === 'before' ? 'before_bytes' : 'after_bytes';
  const row = (await services.engine.store.pool.query(`SELECT s.${column} AS bytes FROM trial_case_screenshots s JOIN work_items w ON w.id = s.work_id WHERE (w.id::text=$1 OR w.document->>'key'=$1) AND s.case_name=$2`, [id, name])).rows[0];
  demand(row?.bytes, 'No such trial screenshot', 404);
  return row.bytes;
}
