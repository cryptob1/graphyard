import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { demand, operatorCapability, operatorScopeIncludes, type Principal } from '../../model.js';
import { candidateIdentityText, candidateSource, candidateValidationKind, exactCandidateKind, type CandidateMember, type CandidateValidation, type ExactCandidate } from '../../model/release.js';
import { assessExactCut } from '../../daemon/candidate-cut.js';
import { defaultCandidateIdleMinutes, maxCandidateIdleMinutes } from '../../master/merge-writer-settings.js';
import { maxCandidateChanges, projectDelivery } from '../../project-applications.js';
import { defineRoutes, parseJson, type RouteContext } from '../routes.js';

/**
 * GY-1904: the plane's exact candidates. `POST /api/candidates` cuts the next one from the changes
 * Graphyard delivered that no candidate holds yet — the oldest five at most (the project's
 * `candidateMaxChanges`, never above `maxCandidateChanges`), each bound to its work item and merge
 * commit — and appends it to the ledger as one immutable `release.candidate` event, under a lock
 * that makes concurrent cuts take disjoint members. The loop's release drive cuts through it and tags
 * `rc/ID` at the candidate's source (daemon/release-ports.ts), then appends the UAT verdict it ran
 * on that source through `POST /api/candidates/ID/validation`, once. `GET` reads them with their
 * validation. Nothing edits, deletes or moves a candidate: every other method is refused. This
 * module authorizes its callers itself, so it is matched ahead of the operator-agent route guard.
 */
const cutSchema = z.object({
  trigger: z.enum(['manual', 'schedule']),
  /** A scheduled cut's bounded wait for a partial batch: the loop's `run.candidates.idleMinutes`. */
  waitMinutes: z.number().int().min(1).max(maxCandidateIdleMinutes).optional(),
  /** The first cut's backlog boundary: deliveries merged at or before it are history. Later cuts carry the first's. */
  since: z.string().datetime().optional(),
}).strict();
const sha = z.string().regex(/^[0-9a-f]{40}$/, 'a full 40-character lower-case commit SHA');
const validationSchema = z.object({
  release: z.string().min(1).max(100), sha, identity: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  result: z.enum(['pass', 'fail']),
  cases: z.array(z.object({ id: z.string().min(1).max(100), result: z.string().min(1).max(40) }).strict()).max(500).default([]),
  failed: z.array(z.string().min(1).max(200)).max(500).default([]),
}).strict();
const cutLock = `${exactCandidateKind}:cut`;
const candidatePath = /^\/api\/candidates\/([^/]+)$/;
const validationPath = /^\/api\/candidates\/([^/]+)\/validation$/;
const immutable = 'Candidate records are immutable: a candidate is only cut (POST /api/candidates), validated once (POST /api/candidates/ID/validation) and read; nothing edits, deletes or moves one through a lifecycle';

function cutter({ actor, services }: RouteContext) {
  if (actor.role === 'operator-agent') return operatorCapability(actor, 'intent:create', undefined, services.repository);
  demand(actor.role === 'admin' || actor.role === 'coordinator', `${actor.id} is a ${actor.role}; cutting or validating a candidate needs admin or coordinator or an operator agent holding intent:create`, 403);
}
function reader({ actor, services }: RouteContext) {
  if (actor.role !== 'operator-agent') return;
  demand(actor.scope?.repositories?.includes(services.repository), `Operator agent ${actor.id}'s scope does not include ${services.repository}`, 403);
}
/** An operator agent reads only candidates whose every member is a work item its scope includes. */
const visible = (actor: Principal, candidate: Pick<ExactCandidate, 'members'>) => candidate.members.every(member => operatorScopeIncludes(actor, { id: member.workId, key: member.key }));

/** The project's per-candidate cap: its declared `candidateMaxChanges`, never more than five. */
export const candidateCap = () => Math.min(projectDelivery().delivery?.candidateMaxChanges ?? maxCandidateChanges, maxCandidateChanges);

const newest = async (db: pg.PoolClient | pg.Pool) => (await db.query('SELECT payload FROM events WHERE kind=$1 AND work_id IS NULL ORDER BY seq DESC LIMIT 1', [exactCandidateKind])).rows[0]?.payload as ExactCandidate | undefined;
/** Each candidate with the validation appended for it, if any. */
async function withValidation(db: pg.PoolClient | pg.Pool, candidates: ExactCandidate[]): Promise<ExactCandidate[]> {
  if (!candidates.length) return candidates;
  const rows = (await db.query('SELECT payload FROM events WHERE kind=$1 AND work_id IS NULL AND payload->>\'candidate\' = ANY($2::text[]) ORDER BY seq', [candidateValidationKind, candidates.map(candidate => candidate.id)])).rows;
  const found = new Map(rows.map(row => [row.payload.candidate as string, row.payload.validation as CandidateValidation]));
  return candidates.map(candidate => ({ ...candidate, validation: found.get(candidate.id) ?? null }));
}

/**
 * The backlog: done items carrying their own delivery (a split parent's is its children's) merged
 * after `floor` (every delivery when null) whose exact (work item, merge commit) pair no candidate
 * names — a reverted item's later merge is a new change — in main's merge order: merge time, then
 * the order the plane recorded the deliveries in, which the one merge writer makes main's own.
 */
export async function candidateBacklog(db: pg.PoolClient | pg.Pool, floor: string | null, limit: number): Promise<{ members: CandidateMember[]; total: number }> {
  const rows = (await db.query(`SELECT w.id, w.document->>'key' AS key, lower(w.document->'delivery'->>'mergeSha') AS merge_sha, w.document->'delivery'->>'mergedAt' AS merged_at,
      w.document->'candidate'->>'pr' AS pr, count(*) OVER () AS total,
      (SELECT min(e.seq) FROM events e WHERE e.work_id = w.id AND lower(e.payload->'work'->'delivery'->>'mergeSha') = lower(w.document->'delivery'->>'mergeSha')) AS recorded
    FROM work_index i JOIN work_items w ON w.id = i.id
    WHERE i.stage = 'done' AND w.document->'delivery'->>'mergeSha' IS NOT NULL AND NOT (w.document->'delivery' ? 'children')
      AND ($1::timestamptz IS NULL OR (w.document->'delivery'->>'mergedAt')::timestamptz > $1::timestamptz)
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.kind = $2 AND e.work_id IS NULL
        AND e.payload->'members' @> jsonb_build_array(jsonb_build_object('workId', w.id::text, 'mergeSha', lower(w.document->'delivery'->>'mergeSha'))))
    ORDER BY (w.document->'delivery'->>'mergedAt')::timestamptz, recorded NULLS LAST, i.number LIMIT $3`, [floor, exactCandidateKind, limit])).rows;
  const pr = (value: string | null) => { const number = Number(value); return value !== null && Number.isInteger(number) && number > 0 ? number : null; };
  return {
    members: rows.map(row => ({ workId: row.id, key: row.key, mergeSha: String(row.merge_sha), mergedAt: new Date(row.merged_at).toISOString(), pr: pr(row.pr) })),
    total: Number(rows[0]?.total ?? 0),
  };
}

/**
 * Cut the next candidate in `db`'s transaction, or refuse with why nothing is due. The advisory
 * lock serializes cuts, so a concurrent cut reads this one's members as taken and never repeats one.
 * The first cut fixes the backlog boundary — `since`, or none, so no waiting delivery is ever dropped
 * by age — and every later cut carries it.
 */
export async function cutExactCandidate(db: pg.PoolClient, actor: Pick<Principal, 'id'>, now: Date, input: z.infer<typeof cutSchema>, cap = candidateCap()): Promise<ExactCandidate> {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [cutLock]);
  const previous = await newest(db);
  const floor = previous ? previous.floor ?? null : input.since ? new Date(input.since).toISOString() : null;
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

/**
 * Append the UAT verdict for candidate `id`, once. It must name the candidate's exact source and
 * identity — a run against any other commit or membership is not this candidate's validation — and a
 * second, different verdict is refused: the first one recorded is the candidate's.
 */
export async function recordCandidateValidation(db: pg.PoolClient, actor: Pick<Principal, 'id'>, now: Date, id: string, input: z.infer<typeof validationSchema>): Promise<ExactCandidate> {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [cutLock]);
  const row = (await db.query('SELECT payload FROM events WHERE kind=$1 AND work_id IS NULL AND payload->>\'id\' = $2 LIMIT 1', [exactCandidateKind, id])).rows[0];
  demand(row, `Candidate ${id} not found`, 404);
  const [candidate] = await withValidation(db, [row.payload as ExactCandidate]);
  demand(input.sha === candidate.sourceSha && input.identity === candidate.identity,
    `Validation of ${id} must name its source ${candidate.sourceSha} and identity ${candidate.identity}; ${input.sha.slice(0, 12)} / ${input.identity.slice(0, 19)} is another candidate's`, 409);
  if (candidate.validation) {
    const same = candidate.validation.release === input.release && candidate.validation.result === input.result;
    demand(same, `Candidate ${id} already holds ${candidate.validation.result} from ${candidate.validation.release}; a validation is recorded once`, 409);
    return candidate;
  }
  const validation: CandidateValidation = { ...input, at: now.toISOString(), by: actor.id };
  await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, candidateValidationKind, JSON.stringify({ candidate: id, validation })]);
  return { ...candidate, validation };
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
const parsed = <T>(result: z.ZodSafeParseResult<T>, shape: string): T => {
  demand(result.success, result.success ? '' : `${shape}: ${result.error.issues.map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ')}`, 400);
  return result.data!;
};

export const candidateRoutes = defineRoutes('candidates', [
  { method: 'GET', path: '/api/candidates', handle: async context => {
    reader(context);
    const pool = context.services.engine.store.pool;
    const listed = await withValidation(pool, (await pool.query('SELECT payload FROM events WHERE kind=$1 AND work_id IS NULL ORDER BY seq DESC LIMIT 20', [exactCandidateKind])).rows.map(row => row.payload as ExactCandidate));
    const waiting = await candidateBacklog(pool, listed[0] ? listed[0].floor ?? null : null, candidateCap());
    return { candidates: listed.filter(candidate => visible(context.actor, candidate)), waiting: waiting.total,
      next: waiting.members.filter(member => operatorScopeIncludes(context.actor, { id: member.workId, key: member.key })), cap: candidateCap() };
  } },
  { method: 'POST', path: '/api/candidates', handle: async context => {
    cutter(context);
    const input = parsed(cutSchema.safeParse(await parseJson(context, 10_000, '{}')), 'A cut takes only {trigger: manual|schedule, waitMinutes?, since?}');
    return once(context, input, (db, now) => cutExactCandidate(db, context.actor, now, input));
  } },
  { method: 'POST', path: validationPath, handle: async (context, [id]) => {
    cutter(context);
    const input = parsed(validationSchema.safeParse(await parseJson(context, 200_000, '{}')), 'A validation takes only {release, sha, identity, result: pass|fail, cases?, failed?}');
    return once(context, input, (db, now) => recordCandidateValidation(db, context.actor, now, decodeURIComponent(id), input));
  } },
  { method: 'GET', path: candidatePath, handle: async (context, [id]) => {
    reader(context);
    const pool = context.services.engine.store.pool;
    const row = (await pool.query('SELECT payload FROM events WHERE kind=$1 AND work_id IS NULL AND payload->>\'id\' = $2 LIMIT 1', [exactCandidateKind, decodeURIComponent(id)])).rows[0];
    demand(row, `Candidate ${decodeURIComponent(id)} not found`, 404);
    const [candidate] = await withValidation(pool, [row.payload as ExactCandidate]);
    demand(visible(context.actor, candidate), `Candidate ${candidate.id} names work outside operator agent ${context.actor.id}'s scope`, 403);
    return candidate;
  } },
  { method: '*', path: /^\/api\/candidates(?:\/.*)?$/, handle: async () => { demand(false, immutable, 405); } },
]);
