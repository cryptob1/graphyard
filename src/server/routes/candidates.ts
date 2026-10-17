import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { demand, operatorCapability, type Principal } from '../../model.js';
import { candidateFloorMs, candidateIdentityText, candidateSource, exactCandidateKind, type CandidateMember, type ExactCandidate } from '../../model/release.js';
import { assessExactCut } from '../../daemon/candidate-cut.js';
import { defaultCandidateIdleMinutes, maxCandidateIdleMinutes } from '../../master/merge-writer-settings.js';
import { maxCandidateChanges, projectDelivery } from '../../project-applications.js';
import { defineRoutes, parseJson, type RouteContext } from '../routes.js';

/**
 * GY-1904: the plane's exact candidates. `POST /api/candidates` cuts the next one from the changes
 * Graphyard delivered that no candidate holds yet — the oldest five at most (the project's
 * `candidateMaxChanges`, never above `maxCandidateChanges`), each bound to its work item and merge
 * commit — and appends it to the ledger as one immutable `release.candidate` event, under a lock
 * that makes concurrent cuts take disjoint members. `GET` reads them. There is no route that edits,
 * deletes or moves a candidate through a lifecycle: every other method is refused. This module
 * authorizes its callers itself, so it is matched ahead of the operator-agent route guard.
 */
const cutSchema = z.object({
  trigger: z.enum(['manual', 'schedule']),
  /** A scheduled cut's bounded wait for a partial batch: the loop's `run.candidates.idleMinutes`. */
  waitMinutes: z.number().int().min(1).max(maxCandidateIdleMinutes).optional(),
}).strict();
const cutLock = `${exactCandidateKind}:cut`;
const candidatePath = /^\/api\/candidates\/([^/]+)$/;
const immutable = 'Candidate records are immutable: a candidate is only cut (POST /api/candidates) and read; nothing edits, deletes or moves one through a lifecycle';

function cutter({ actor, services }: RouteContext) {
  if (actor.role === 'operator-agent') return operatorCapability(actor, 'intent:create', undefined, services.repository);
  demand(actor.role === 'admin' || actor.role === 'coordinator', `${actor.id} is a ${actor.role}; cutting a candidate needs admin or coordinator or an operator agent holding intent:create`, 403);
}
function reader({ actor, services }: RouteContext) {
  if (actor.role !== 'operator-agent') return;
  demand(actor.scope?.repositories?.includes(services.repository), `Operator agent ${actor.id}'s scope does not include ${services.repository}`, 403);
}

/** The project's per-candidate cap: its declared `candidateMaxChanges`, never more than five. */
export const candidateCap = () => Math.min(projectDelivery().delivery?.candidateMaxChanges ?? maxCandidateChanges, maxCandidateChanges);

const newest = async (db: pg.PoolClient | pg.Pool) => (await db.query('SELECT payload FROM events WHERE kind=$1 ORDER BY seq DESC LIMIT 1', [exactCandidateKind])).rows[0]?.payload as ExactCandidate | undefined;

/**
 * The backlog: done items carrying a delivery merged at or after `floor` that no candidate names,
 * oldest merge first (then by item number), with how many there are in all.
 */
export async function candidateBacklog(db: pg.PoolClient | pg.Pool, floor: string, limit: number): Promise<{ members: CandidateMember[]; total: number }> {
  const rows = (await db.query(`SELECT w.id, w.document->>'key' AS key, w.document->'delivery'->>'mergeSha' AS merge_sha, w.document->'delivery'->>'mergedAt' AS merged_at,
      w.document->'candidate'->>'pr' AS pr, count(*) OVER () AS total
    FROM work_index i JOIN work_items w ON w.id = i.id
    WHERE i.stage = 'done' AND w.document->'delivery'->>'mergeSha' IS NOT NULL AND (w.document->'delivery'->>'mergedAt')::timestamptz >= $1::timestamptz
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.kind = $2 AND e.work_id IS NULL AND e.payload->'members' @> jsonb_build_array(jsonb_build_object('workId', w.id::text)))
    ORDER BY (w.document->'delivery'->>'mergedAt')::timestamptz, i.number LIMIT $3`, [floor, exactCandidateKind, limit])).rows;
  const pr = (value: string | null) => { const number = Number(value); return value !== null && Number.isInteger(number) && number > 0 ? number : null; };
  return {
    members: rows.map(row => ({ workId: row.id, key: row.key, mergeSha: String(row.merge_sha).toLowerCase(), mergedAt: new Date(row.merged_at).toISOString(), pr: pr(row.pr) })),
    total: Number(rows[0]?.total ?? 0),
  };
}

/**
 * Cut the next candidate in `db`'s transaction, or refuse with why nothing is due. The advisory
 * lock serializes cuts, so a concurrent cut reads this one's members as taken and never repeats one.
 */
export async function cutExactCandidate(db: pg.PoolClient, actor: Pick<Principal, 'id'>, now: Date, input: z.infer<typeof cutSchema>, cap = candidateCap()): Promise<ExactCandidate> {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [cutLock]);
  const previous = await newest(db);
  const floor = previous?.floor ?? new Date(now.getTime() - candidateFloorMs).toISOString();
  const backlog = await candidateBacklog(db, floor, cap);
  const assessed = assessExactCut(backlog.members, { trigger: input.trigger, now: now.getTime(), cap, waitMinutes: input.waitMinutes ?? defaultCandidateIdleMinutes, total: backlog.total });
  demand(assessed.due, assessed.reason, 409);
  const sourceSha = candidateSource(assessed.members), sequence = (previous?.sequence ?? 0) + 1;
  const candidate: ExactCandidate = {
    id: `C-${sequence}`, sequence, cutAt: now.toISOString(), cutBy: actor.id, trigger: input.trigger,
    members: assessed.members, sourceSha,
    identity: `sha256:${createHash('sha256').update(candidateIdentityText(sourceSha, assessed.members)).digest('hex')}`,
    previous: previous ? { id: previous.id, sourceSha: previous.sourceSha } : null,
    floor, waiting: assessed.waiting, validation: null,
  };
  await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, exactCandidateKind, JSON.stringify(candidate)]);
  return candidate;
}

/** A cut runs once per Idempotency-Key, as the other mutating routes do; a key reused with other input is refused. */
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

export const candidateRoutes = defineRoutes('candidates', [
  { method: 'GET', path: '/api/candidates', handle: async context => {
    reader(context);
    const pool = context.services.engine.store.pool;
    const candidates = (await pool.query('SELECT payload FROM events WHERE kind=$1 ORDER BY seq DESC LIMIT 20', [exactCandidateKind])).rows.map(row => row.payload as ExactCandidate);
    const floor = candidates[0]?.floor ?? new Date(Date.now() - candidateFloorMs).toISOString();
    const waiting = await candidateBacklog(pool, floor, candidateCap());
    return { candidates, waiting: waiting.total, next: waiting.members, cap: candidateCap() };
  } },
  { method: 'POST', path: '/api/candidates', handle: async context => {
    cutter(context);
    const parsed = cutSchema.safeParse(await parseJson(context, 10_000, '{}'));
    demand(parsed.success, parsed.success ? '' : `A cut takes only {trigger: manual|schedule, waitMinutes?}: ${parsed.error.issues.map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ')}`, 400);
    return once(context, parsed.data, (db, now) => cutExactCandidate(db, context.actor, now, parsed.data));
  } },
  { method: 'GET', path: candidatePath, handle: async (context, [id]) => {
    reader(context);
    const row = (await context.services.engine.store.pool.query('SELECT payload FROM events WHERE kind=$1 AND work_id IS NULL AND payload->>$2 = $3 LIMIT 1', [exactCandidateKind, 'id', decodeURIComponent(id)])).rows[0];
    demand(row, `Candidate ${decodeURIComponent(id)} not found`, 404);
    return row.payload as ExactCandidate;
  } },
  { method: '*', path: /^\/api\/candidates(?:\/.*)?$/, handle: async () => { demand(false, immutable, 405); } },
]);
