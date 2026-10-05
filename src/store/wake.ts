// Concern: waking items' observation jobs — webhook wakes, single and batched job wakes, and the per-transaction pending wakes.
import pg from 'pg';

/** How long a webhook wake keeps its job ahead of polled jobs before it is dropped from the front (the job stays due). */
export const webhookWakeTtlMs = 10 * 60_000;
/** How long a due observation job may wait behind the claim-priority list before it is claimed first. */
export const observationStarvedAfterMs = 5 * 60_000;

/**
 * Wake the jobs a verified GitHub webhook delivery names (GY-806): every job when it moved the base
 * branch or a merge-queue ref (`all`), else the items whose pull request, candidate or speculative
 * tip SHA, or candidate branch it names. An observation event also stamps their webhook wake, which
 * `takeJob` on any replica claims ahead of polled jobs. Returns the woken work ids.
 */
export async function wakeFromWebhook(db: Pick<pg.PoolClient, 'query'>, subjects: { all: boolean; prs: number[]; shas: string[]; branches: string[] }, observation: boolean): Promise<string[]> {
  // The job rows are locked in work-id order first (GY-1115), the order every other job wake takes them in.
  const woken = await db.query(`WITH target AS (SELECT work_id FROM jobs WHERE $1::boolean OR work_id IN (SELECT id FROM work_items
    WHERE document->'submission'->>'pr' = ANY($2::text[]) OR document->'candidate'->>'sha' = ANY($3::text[]) OR document->'queue'->'speculation'->>'tip' = ANY($3::text[]) OR document->'candidate'->>'branch' = ANY($6::text[]))
    ORDER BY work_id FOR UPDATE)
    UPDATE jobs SET available_at=LEAST(available_at, now()),generation=generation+1,
    webhook_at=CASE WHEN $4::boolean AND (webhook_at IS NULL OR webhook_at <= now() - ($5::text||' milliseconds')::interval) THEN now() ELSE webhook_at END
    FROM target WHERE jobs.work_id = target.work_id RETURNING jobs.work_id`,
    [subjects.all, subjects.prs.map(String), subjects.shas, observation, String(webhookWakeTtlMs), subjects.branches]);
  return woken.rows.map(row => String(row.work_id));
}

/** The job wakes a `Store.transaction` has asked for and not yet taken, per connection, each with whether it is prioritized (GY-1115). */
export const pendingWakes = new WeakMap<object, Map<string, boolean>>();
/**
 * Make an item's observation job due now. A wake never moves a job that is already due later: an
 * item saved every minute would otherwise look freshly due forever and never reach the starvation
 * bound `takeJob` claims ahead of the priority list (2026-09-26: items stuck for an hour on stale reads).
 * `prioritized` also stamps the job's webhook wake, so `takeJob` claims it ahead of the polled
 * backlog as it would a webhook's (GY-1099: a merge refused only for a stale observation). Like a
 * webhook's, a wake still standing keeps its stamp, so prioritized wakes are claimed oldest first.
 * Inside a `Store.transaction` the wake is taken just before
 * COMMIT, with the transaction's other wakes, in work-id order (GY-1115): every transaction then
 * locks its item rows before any job row, and job rows in one stable order, so a reconciliation
 * batch, a resync and an observation can no longer deadlock on a job row one of them took mid-way.
 */
export async function wakeJob(db: Pick<pg.PoolClient, 'query'>, id: string, prioritized = false) {
  const pending = pendingWakes.get(db);
  if (pending) pending.set(id, prioritized || pending.get(id) === true);
  else await wakeJobs(db, [id], prioritized ? [id] : []);
}
/** Make several items' observation jobs due in one statement, their rows locked in work-id order; those in `prioritized` are stamped as `wakeJob` stamps one. */
export async function wakeJobs(db: Pick<pg.PoolClient, 'query'>, ids: string[], prioritized: string[] = []) {
  if (!ids.length) return;
  await db.query(`INSERT INTO jobs(work_id,webhook_at) SELECT id, CASE WHEN id = ANY($2::uuid[]) THEN now() END FROM unnest($1::uuid[]) AS id ORDER BY id
    ON CONFLICT(work_id) DO UPDATE SET available_at=LEAST(jobs.available_at, now()),generation=jobs.generation+1,
    webhook_at=CASE WHEN EXCLUDED.webhook_at IS NOT NULL AND (jobs.webhook_at IS NULL OR jobs.webhook_at <= now() - ($3::text||' milliseconds')::interval) THEN now() ELSE jobs.webhook_at END`,
    [[...new Set(ids)].sort(), [...new Set(prioritized)], String(webhookWakeTtlMs)]);
}
