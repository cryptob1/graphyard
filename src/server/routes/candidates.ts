import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { demand, operatorCapability, operatorScopeIncludes, type Principal } from '../../model.js';
import { candidateIdentityText, candidateSource, candidateValidationKind, exactCandidateKind, type CandidateMember, type CandidateValidation, type ExactCandidate } from '../../model/release.js';
import { assessExactCut } from '../../daemon/candidate-cut.js';
import { defaultCandidateIdleMinutes, maxCandidateIdleMinutes } from '../../master/merge-writer-settings.js';
import { maxCandidateChanges, projectDelivery } from '../../project-applications.js';
import { uatValidationWindowMs } from '../../release-candidate.js';
import { candidatePromotionKind } from '../../delivery.js';
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
  /**
   * The first cut's newest legacy `rc/` source: the plane records its delivery's merge time after the
   * commit, so the boundary is the later of `since` and that recorded time, never re-cutting what it shipped.
   */
  sinceSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
}).strict();
const sha = z.string().regex(/^[0-9a-f]{40}$/, 'a full 40-character lower-case commit SHA');
const identity = z.string().regex(/^sha256:[0-9a-f]{64}$/);
/** GY-1905: what the validated candidate was built into — its build's artifact digests, or its source tree when it ships by commit. */
const artifact = z.string().regex(/^(sha256:[0-9a-f]{64}|tree:[0-9a-f]{40})$/, 'sha256:<64 hex> for a build, or tree:<40 hex> for a source tree');
const caseIds = z.array(z.string().min(1).max(100)).max(500);
const validationSchema = z.object({
  release: z.string().min(1).max(100), sha, identity,
  result: z.enum(['pass', 'fail']),
  cases: z.array(z.object({ id: z.string().min(1).max(100), result: z.string().min(1).max(40) }).strict()).max(500).default([]),
  failed: z.array(z.string().min(1).max(200)).max(500).default([]),
  /** GY-1905: the cases the run held required, the artifact it ran against and when the run was recorded. */
  required: caseIds.optional(), artifact: artifact.optional(), ranAt: z.iso.datetime().optional(),
}).strict();
/**
 * GY-1905: a request to select a validated candidate for an environment. It names exactly what the
 * promoter is about to deploy — the `rc/ID` record, its source, identity and artifact — and the
 * required cases the candidate's own checkout declares.
 */
const promotionSchema = z.object({ environment: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), release: z.string().min(1).max(100), sha, identity, artifact, required: caseIds }).strict();
export type PromotionRequest = z.infer<typeof promotionSchema>;
export type GatedValidation = CandidateValidation & { required?: string[]; artifact?: string; ranAt?: string };
/** GY-1905: the selection recorded once a candidate passed every promotion gate (`release.candidate.promotion`, append-only). */
export interface CandidatePromotion { environment: string; releaseId: string; sourceSha: string; identity: string; artifact: string; required: string[]; at: string; by: string }
export type PromotedCandidate = Omit<ExactCandidate, 'validation'> & { validation: GatedValidation | null; promotion?: CandidatePromotion | null };
export { candidatePromotionKind };
/** A required case passes only when it ran and passed: a pending (GY-1802), flaky or unrun result does not. */
const passing = 'pass';
const cutLock = `${exactCandidateKind}:cut`;
const candidatePath = /^\/api\/candidates\/([^/]+)$/;
const validationPath = /^\/api\/candidates\/([^/]+)\/validation$/;
const promotionPath = /^\/api\/candidates\/([^/]+)\/promotion$/;
const immutable = 'Candidate records are immutable: a candidate is only cut (POST /api/candidates), validated once (POST /api/candidates/ID/validation), promoted once per environment (POST /api/candidates/ID/promotion) and read; nothing edits, deletes or moves one through a lifecycle';

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
/** Each candidate with the validation appended for it and its production promotion, if any. */
async function withValidation(db: pg.PoolClient | pg.Pool, candidates: ExactCandidate[]): Promise<PromotedCandidate[]> {
  if (!candidates.length) return [];
  const rows = (await db.query('SELECT kind, payload FROM events WHERE kind = ANY($1::text[]) AND work_id IS NULL AND payload->>\'candidate\' = ANY($2::text[]) ORDER BY seq', [[candidateValidationKind, candidatePromotionKind], candidates.map(candidate => candidate.id)])).rows;
  const found = new Map(rows.filter(row => row.kind === candidateValidationKind).map(row => [row.payload.candidate as string, row.payload.validation as GatedValidation]));
  const promoted = new Map(rows.filter(row => row.kind === candidatePromotionKind && row.payload.promotion?.environment === 'production').map(row => [row.payload.candidate as string, row.payload.promotion as CandidatePromotion]));
  return candidates.map(candidate => ({ ...candidate, validation: found.get(candidate.id) ?? null, promotion: promoted.get(candidate.id) ?? null }));
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

/** The first cut's boundary: `since`, moved up to the recorded merge time of the delivery `sinceSha` names. */
export async function firstFloor(db: pg.PoolClient | pg.Pool, input: z.infer<typeof cutSchema>): Promise<string | null> {
  const recorded = input.sinceSha ? (await db.query(`SELECT max((document->'delivery'->>'mergedAt')::timestamptz) AS at FROM work_items
    WHERE lower(document->'delivery'->>'mergeSha') = $1`, [input.sinceSha])).rows[0]?.at as Date | null : null;
  const times = [input.since ? Date.parse(input.since) : null, recorded ? new Date(recorded).getTime() : null].filter((time): time is number => time !== null);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

/**
 * Cut the next candidate in `db`'s transaction, or refuse with why nothing is due. The advisory
 * lock serializes cuts, so a concurrent cut reads this one's members as taken and never repeats one.
 * The first cut fixes the backlog boundary — `since`, or none, so no waiting delivery is ever dropped
 * by age — and every later cut carries it. An operator agent's work-item scope must cover every
 * selected member before the cut is written; any out-of-scope member refuses the whole cut.
 */
export async function cutExactCandidate(db: pg.PoolClient, actor: Principal, now: Date, input: z.infer<typeof cutSchema>, cap = candidateCap()): Promise<ExactCandidate> {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [cutLock]);
  const previous = await newest(db);
  const floor = previous ? previous.floor ?? null : await firstFloor(db, input);
  const backlog = await candidateBacklog(db, floor, cap);
  const assessed = assessExactCut(backlog.members, { trigger: input.trigger, now: now.getTime(), cap, waitMinutes: input.waitMinutes ?? defaultCandidateIdleMinutes, total: backlog.total });
  demand(assessed.due, assessed.reason, 409);
  for (const member of assessed.members) {
    demand(operatorScopeIncludes(actor, { id: member.workId, key: member.key }),
      `Cutting a candidate that names ${member.key} is outside operator agent ${actor.id}'s scope`, 403);
  }
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

/** Submitted validation content excluding server-owned `at`/`by`, for identical-replay comparison. */
const validationContent = (value: Omit<GatedValidation, 'at' | 'by'> | z.infer<typeof validationSchema>) =>
  JSON.stringify({ release: value.release, sha: value.sha, identity: value.identity, result: value.result, cases: value.cases, failed: value.failed, required: value.required ?? null, artifact: value.artifact ?? null, ranAt: value.ranAt ?? null });

/**
 * Append the UAT verdict for candidate `id`, once. It must name the candidate's exact source and
 * identity — a run against any other commit or membership is not this candidate's validation — and a
 * second, different verdict is refused: the first one recorded is the candidate's. An operator
 * agent's work-item scope must cover every member before a validation is written.
 */
export async function recordCandidateValidation(db: pg.PoolClient, actor: Principal, now: Date, id: string, input: z.infer<typeof validationSchema>): Promise<PromotedCandidate> {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [cutLock]);
  const row = (await db.query('SELECT payload FROM events WHERE kind=$1 AND work_id IS NULL AND payload->>\'id\' = $2 LIMIT 1', [exactCandidateKind, id])).rows[0];
  demand(row, `Candidate ${id} not found`, 404);
  const [candidate] = await withValidation(db, [row.payload as ExactCandidate]);
  demand(visible(actor, candidate), `Candidate ${id} names work outside operator agent ${actor.id}'s scope`, 403);
  demand(input.sha === candidate.sourceSha && input.identity === candidate.identity,
    `Validation of ${id} must name its source ${candidate.sourceSha} and identity ${candidate.identity}; ${input.sha.slice(0, 12)} / ${input.identity.slice(0, 19)} is another candidate's`, 409);
  if (candidate.validation) {
    demand(validationContent(candidate.validation) === validationContent(input),
      `Candidate ${id} already holds ${candidate.validation.result} from ${candidate.validation.release}; a validation is recorded once`, 409);
    return candidate;
  }
  const validation: GatedValidation = { ...input, at: now.toISOString(), by: actor.id };
  await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, candidateValidationKind, JSON.stringify({ candidate: id, validation })]);
  return { ...candidate, validation };
}

/**
 * GY-1905: why `candidate` may not be selected for `ask.environment` at `now` — empty when it may.
 * Only the exact candidate that passed every combined required case promotes: its recorded
 * validation passed, names this source, identity and artifact, was run as the very `rc/ID` being
 * promoted, ran no longer ago than the UAT window (the run's own time, not when the plane recorded
 * it), and holds a `pass` for every required case
 * the candidate's checkout declares and the run held required. Anything absent fails closed, and a
 * candidate older than one already promoted there is superseded.
 */
export function promotionRefusals(candidate: PromotedCandidate, ask: PromotionRequest, now: Date, newest: { id: string; sequence: number } | null): string[] {
  const validation = candidate.validation, refusals: string[] = [];
  if (ask.sha !== candidate.sourceSha) refusals.push(`the source ${ask.sha.slice(0, 12)} is not candidate ${candidate.id}'s ${candidate.sourceSha.slice(0, 12)}`);
  if (ask.identity !== candidate.identity) refusals.push(`the identity ${ask.identity.slice(0, 19)} is not candidate ${candidate.id}'s membership ${candidate.identity.slice(0, 19)}`);
  if (!validation) return [...refusals, `candidate ${candidate.id} holds no validation; it promotes only after its combined required cases pass`];
  if (validation.result !== 'pass') refusals.push(`candidate ${candidate.id} failed its combined required cases${validation.failed.length ? `: ${validation.failed.join(', ')}` : ''}`);
  if (validation.sha !== candidate.sourceSha || validation.identity !== candidate.identity) refusals.push(`the validation of ${candidate.id} was run on another source or membership`);
  if (!validation.artifact) refusals.push(`the validation of ${candidate.id} names no artifact, so nothing binds what it tested to what would deploy`);
  else if (validation.artifact !== ask.artifact) refusals.push(`the artifact ${ask.artifact} is not the ${validation.artifact} the validation of ${candidate.id} tested`);
  if (validation.release !== ask.release) refusals.push(`the validation of ${candidate.id} was run as ${validation.release}, not ${ask.release}`);
  // The run's own time bounds freshness: a verdict recovered after a restart is recorded late, but ran when it ran.
  if (!validation.ranAt) refusals.push(`the validation of ${candidate.id} names no run time, so its freshness is unknown`);
  else {
    const ran = Math.min(Date.parse(validation.ranAt), Date.parse(validation.at)), age = now.getTime() - ran;
    if (!(age <= uatValidationWindowMs)) refusals.push(`the validation of ${candidate.id} ran at ${new Date(ran).toISOString()} and is stale: older than ${uatValidationWindowMs / 3_600_000} hours`);
  }
  const required = [...new Set([...ask.required, ...validation.required ?? []])].sort();
  if (!required.length) refusals.push(`no required case is named for ${candidate.id}; a candidate promotes only on its combined required cases`);
  const verdicts = new Map(validation.cases.map(entry => [entry.id, entry.result]));
  const missing = required.filter(id => !verdicts.has(id)), failing = required.filter(id => verdicts.has(id) && verdicts.get(id) !== passing);
  if (missing.length) refusals.push(`required case${missing.length > 1 ? 's' : ''} ${missing.join(', ')} never ran on ${candidate.id}`);
  if (failing.length) refusals.push(`required case${failing.length > 1 ? 's' : ''} ${failing.map(id => `${id} (${verdicts.get(id)})`).join(', ')} did not pass on ${candidate.id}`);
  if (newest && newest.id !== candidate.id && newest.sequence > candidate.sequence) refusals.push(`candidate ${candidate.id} is superseded: the later ${newest.id} is already promoted to ${ask.environment}`);
  return refusals;
}

/**
 * GY-1905: select candidate `id` for an environment, once, after `promotionRefusals` finds nothing:
 * the selection is appended as one `release.candidate.promotion` event the promoter deploys after.
 * A refused candidate writes nothing, so a failed one stays failed and the environment keeps the
 * candidate it last selected. The same request again answers the recorded selection.
 */
export async function recordCandidatePromotion(db: pg.PoolClient, actor: Principal, now: Date, id: string, ask: PromotionRequest): Promise<PromotedCandidate> {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [cutLock]);
  const row = (await db.query('SELECT payload FROM events WHERE kind=$1 AND work_id IS NULL AND payload->>\'id\' = $2 LIMIT 1', [exactCandidateKind, id])).rows[0];
  demand(row, `Candidate ${id} not found`, 404);
  const [candidate] = await withValidation(db, [row.payload as ExactCandidate]);
  demand(visible(actor, candidate), `Candidate ${id} names work outside operator agent ${actor.id}'s scope`, 403);
  const existing = (await db.query('SELECT payload FROM events WHERE kind=$1 AND work_id IS NULL AND payload->>\'candidate\' = $2 AND payload->\'promotion\'->>\'environment\' = $3 LIMIT 1', [candidatePromotionKind, id, ask.environment])).rows[0];
  if (existing) {
    const recorded = existing.payload.promotion as CandidatePromotion;
    demand(recorded.sourceSha === ask.sha && recorded.identity === ask.identity && recorded.artifact === ask.artifact && recorded.releaseId === ask.release,
      `Candidate ${id} is already promoted to ${ask.environment} as ${recorded.releaseId} (${recorded.artifact}); a promotion is recorded once`, 409);
    return candidate;
  }
  const newest = await promotedTo(db, ask.environment);
  const refusals = promotionRefusals(candidate, ask, now, newest && { id: newest.candidate, sequence: newest.sequence });
  demand(!refusals.length, `Candidate ${id} is not promoted: ${refusals.join('; ')}`, 409);
  const promotion: CandidatePromotion = { environment: ask.environment, releaseId: ask.release, sourceSha: ask.sha, identity: ask.identity, artifact: ask.artifact, required: [...new Set([...ask.required, ...candidate.validation!.required ?? []])].sort(), at: now.toISOString(), by: actor.id };
  await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, candidatePromotionKind, JSON.stringify({ candidate: id, sequence: candidate.sequence, promotion })]);
  return { ...candidate, ...(ask.environment === 'production' ? { promotion } : {}) };
}

/** The candidate an environment last selected — the release it keeps through any later failed candidate — or null. */
export async function promotedTo(db: pg.PoolClient | pg.Pool, environment: string): Promise<{ candidate: string; sequence: number; promotion: CandidatePromotion } | null> {
  const row = (await db.query('SELECT payload FROM events WHERE kind=$1 AND work_id IS NULL AND payload->\'promotion\'->>\'environment\' = $2 ORDER BY seq DESC LIMIT 1', [candidatePromotionKind, environment])).rows[0];
  return row ? { candidate: row.payload.candidate, sequence: Number(row.payload.sequence), promotion: row.payload.promotion } : null;
}

/**
 * The listing, newest first: the newest 20 and every candidate still without a verdict however old,
 * so a loop resuming untagged cuts always sees the oldest one and never tags a later one past it.
 */
export async function listCandidates(db: pg.PoolClient | pg.Pool): Promise<PromotedCandidate[]> {
  return withValidation(db, (await db.query(`SELECT payload FROM events c WHERE c.kind=$1 AND c.work_id IS NULL
      AND (c.seq >= COALESCE((SELECT min(seq) FROM (SELECT seq FROM events WHERE kind=$1 AND work_id IS NULL ORDER BY seq DESC LIMIT 20) newest), 0)
        OR NOT EXISTS (SELECT 1 FROM events v WHERE v.kind=$2 AND v.work_id IS NULL AND v.payload->>'candidate' = c.payload->>'id'))
    ORDER BY c.seq DESC`, [exactCandidateKind, candidateValidationKind])).rows.map(row => row.payload as ExactCandidate));
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
    const listed = await listCandidates(pool);
    const waiting = await candidateBacklog(pool, listed[0] ? listed[0].floor ?? null : null, candidateCap());
    const production = await promotedTo(pool, 'production');
    // The summary names the promoted candidate, so it is shown only to a reader that may read that candidate.
    const promoted = production && (await pool.query('SELECT payload FROM events WHERE kind=$1 AND work_id IS NULL AND payload->>\'id\' = $2 LIMIT 1', [exactCandidateKind, production.candidate])).rows[0]?.payload as ExactCandidate | undefined;
    return { candidates: listed.filter(candidate => visible(context.actor, candidate)), waiting: waiting.total,
      next: waiting.members.filter(member => operatorScopeIncludes(context.actor, { id: member.workId, key: member.key })), cap: candidateCap(),
      production: production && promoted && visible(context.actor, promoted) ? { candidate: production.candidate, ...production.promotion } : null };
  } },
  { method: 'POST', path: '/api/candidates', handle: async context => {
    cutter(context);
    const input = parsed(cutSchema.safeParse(await parseJson(context, 10_000, '{}')), 'A cut takes only {trigger: manual|schedule, waitMinutes?, since?, sinceSha?}');
    return once(context, input, async (db, now) => ({ ...await cutExactCandidate(db, context.actor, now, input), promotion: null }));
  } },
  { method: 'POST', path: validationPath, handle: async (context, [id]) => {
    cutter(context);
    const input = parsed(validationSchema.safeParse(await parseJson(context, 200_000, '{}')), 'A validation takes only {release, sha, identity, result: pass|fail, cases?, failed?}');
    return once(context, input, (db, now) => recordCandidateValidation(db, context.actor, now, decodeURIComponent(id), input));
  } },
  { method: 'POST', path: promotionPath, handle: async (context, [id]) => {
    cutter(context);
    const input = parsed(promotionSchema.safeParse(await parseJson(context, 50_000, '{}')), 'A promotion takes only {environment, release, sha, identity, artifact, required}');
    return once(context, input, (db, now) => recordCandidatePromotion(db, context.actor, now, decodeURIComponent(id), input));
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
