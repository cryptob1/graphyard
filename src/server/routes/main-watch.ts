import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { demand } from '../../model.js';
import { directMergeWindows, type DirectMergeWindow } from '../../direct-merge.js';
import { defineRoutes, parseJson, type RouteContext } from '../routes.js';

/**
 * The main watch's policy (GY-1519, daemon/main-watch.ts): an admin's acknowledgement of a commit
 * on the base branch that nothing Graphyard recorded explains, which lifts the promotion freeze
 * on it. The acknowledgement lives on the append-only ledger (`policy.main-watch.acknowledged`,
 * no work item), like direct-merge mode; only an admin credential records one, and no agent
 * identity can acknowledge a commit it may itself have pushed.
 */
export const mainWatchAcknowledgedEvent = 'policy.main-watch.acknowledged';
const sha = z.string().trim().regex(/^[0-9a-f]{40}$/i, 'Name the commit by its full 40-hex sha').transform(value => value.toLowerCase());
const acknowledgeSchema = z.object({ sha, reason: z.string().trim().min(1).max(1000) }).strict();
type Queryable = Pick<pg.PoolClient, 'query'>;

export interface MainWatchAcknowledgement { sha: string; reason: string; by: string; at: string }

/** Every acknowledgement the ledger records, oldest first, and the direct-merge windows the watch classifies against. */
export async function mainWatchPolicy(db: Queryable, environment: DirectMergeWindow | null) {
  const rows = (await db.query('SELECT actor, payload, created_at FROM events WHERE work_id IS NULL AND kind=$1 ORDER BY seq', [mainWatchAcknowledgedEvent])).rows;
  const acknowledged: MainWatchAcknowledgement[] = rows.flatMap(row => typeof row.payload?.sha === 'string'
    ? [{ sha: String(row.payload.sha).toLowerCase(), reason: typeof row.payload.reason === 'string' ? row.payload.reason : '', by: String(row.actor), at: new Date(row.created_at).toISOString() }] : []);
  return { acknowledged, directMergeWindows: (await directMergeWindows(db, environment)).map(window => ({ since: window.since, until: window.until })) };
}

/** Runs once per Idempotency-Key for this actor, as every mutating route does; a key reused with other input is refused. */
async function once<T>(context: RouteContext, input: unknown, run: (db: pg.PoolClient, now: Date) => Promise<T>): Promise<T> {
  const key = context.idempotencyKey();
  demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
  const fingerprint = createHash('sha256').update(JSON.stringify([context.url.pathname, input])).digest('hex');
  return context.services.engine.store.transaction(async (db, now) => {
    const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [context.actor.id, key])).rows[0];
    if (receipt) { demand(receipt.fingerprint === fingerprint, 'Idempotency key reused with different input'); return receipt.result as T; }
    const result = await run(db, now);
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [context.actor.id, key, fingerprint, JSON.stringify(result)]);
    return result;
  });
}

export const mainWatchRoutes = defineRoutes('main-watch', [
  // Read by the loop (its coordinator credential), the master and the dashboard.
  {
    method: 'GET', path: '/api/main-watch',
    async handle({ actor, services }) {
      demand(['admin', 'coordinator', 'reader', 'operator-agent'].includes(actor.role), 'The main watch policy is readable by admin, coordinator, reader and operator-agent identities', 403);
      return mainWatchPolicy(services.engine.store.pool, services.engine.directMergeEnvironment);
    },
  },
  // Recorded with an admin credential only: an acknowledgement is the human's statement that the commit is theirs or understood.
  {
    method: 'POST', path: '/api/main-watch/acknowledge',
    async handle(context) {
      const { actor, services } = context;
      demand(actor.role === 'admin', 'A main watch acknowledgement is recorded only with an admin credential; agent identities cannot acknowledge a commit on the base branch', 403);
      const data = acknowledgeSchema.parse(await parseJson(context));
      return once(context, data, async (db, now) => {
        const earlier = (await mainWatchPolicy(db, services.engine.directMergeEnvironment)).acknowledged.find(entry => entry.sha === data.sha);
        if (earlier) return { ...earlier, already: true };
        const at = (await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3) RETURNING created_at', [actor.id, mainWatchAcknowledgedEvent, JSON.stringify({ sha: data.sha, reason: data.reason, at: now.toISOString() })])).rows[0].created_at as Date;
        return { sha: data.sha, reason: data.reason, by: actor.id, at: new Date(at).toISOString(), already: false };
      });
    },
  },
]);
