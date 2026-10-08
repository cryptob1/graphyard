import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { demand, type Principal } from '../model.js';
import type { Services } from './routes.js';

/**
 * GY-1522. The shadow merge gate's verdict for one head, recorded by the loop's coordinator
 * identity as a work event (`shadow.verdict`). It is an observation: it changes nothing on the item
 * and gates nothing; the comparison with GitHub's gate is read from these events and the item's
 * own delivery and main guard record.
 */
const sha = z.string().regex(/^[0-9a-f]{40}$/);
export const shadowVerdictBodySchema = z.object({
  head: sha, baseTip: sha, mergeSha: sha.nullable(), risk: z.enum(['sensitive', 'normal']), build: z.enum(['pass', 'fail']),
  tests: z.object({ passed: z.number().int().min(0), failed: z.array(z.string().max(300)).max(100), files: z.number().int().min(0) }).strict(),
  conflict: z.array(z.string().max(500)).max(100).default([]), durationMs: z.number().int().min(0),
}).strict();
export const shadowVerdictEvent = 'shadow.verdict';

export async function recordShadowVerdict(services: Services, actor: Principal, id: string, body: unknown, key: string) {
  demand(actor.role === 'coordinator', 'Only the loop\'s coordinator identity records a shadow verdict', 403);
  const data = shadowVerdictBodySchema.parse(body);
  const fingerprint = createHash('sha256').update(JSON.stringify({ id, data })).digest('hex');
  return services.engine.store.transaction(async (db: pg.PoolClient) => {
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const replay = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
    if (replay) { demand(replay.fingerprint === fingerprint, 'Idempotency key reused with different input'); return replay.result; }
    const item = (await db.query("SELECT id, document->>'key' AS key FROM work_items WHERE id::text=$1 OR document->>'key'=$1", [id])).rows[0];
    demand(item, 'Work item not found', 404);
    await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [item.id, actor.id, shadowVerdictEvent, JSON.stringify({ key: item.key, ...data })]);
    const result = { recorded: true, key: item.key, head: data.head, baseTip: data.baseTip };
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
    return result;
  });
}
