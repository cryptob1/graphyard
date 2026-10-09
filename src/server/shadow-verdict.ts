import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { demand, type Principal, type Work } from '../model.js';
import {
  compareVerdicts, githubOutcome, isPlaceholderVerdict, trialFailureCause, placeholderRunnerFailure, shadowDisagreement,
  shadowDisagreementPair, shadowExplanationPairsMax, trialLogTailLength, type ShadowExplanationRef, type ShadowVerdict,
} from '../merge-writer/shadow.js';
import { DELIVERY_EVENT_PREDICATE } from '../store/tables/production.js';
import { defineRoutes, parseJson, type Services } from './routes.js';

/**
 * GY-1522. The shadow merge gate's verdict for one head, recorded by the loop's coordinator
 * identity as a work event (`shadow.verdict`). It is an observation: it changes nothing on the item
 * and gates nothing; the comparison with GitHub's gate is read from these events and the item's
 * own delivery and main guard record.
 *
 * GY-1560. A disagreement explanation (`shadow.disagreement.explained`) is recorded beside it: one
 * per (work key, head, baseTip), by a coordinator or admin, citing the verdict's evidence. The
 * merger switch and `master status` both read these events.
 */
const sha = z.string().regex(/^[0-9a-f]{40}$/);
export const shadowVerdictBodySchema = z.object({
  head: sha, baseTip: sha, mergeSha: sha.nullable(), risk: z.enum(['sensitive', 'normal']), build: z.enum(['pass', 'fail']),
  tests: z.object({ passed: z.number().int().min(0), failed: z.array(z.string().max(300)).max(100), files: z.number().int().min(0) }).strict(),
  conflict: z.array(z.string().max(500)).max(100).default([]), durationMs: z.number().int().min(0),
  // The trial's log tail, present when the trial did not pass: the build, a test file, or the runner's exit (GY-1549).
  logTail: z.string().max(trialLogTailLength).optional(),
}).strict();
export const shadowVerdictEvent = 'shadow.verdict';
/** One explanation of a shadow-only-fail or shadow-missed verdict (GY-1560). */
export const shadowDisagreementExplainedEvent = 'shadow.disagreement.explained';
export const shadowExplainBodySchema = z.object({
  head: sha, baseTip: sha, reason: z.string().trim().min(1).max(2000),
}).strict();

export interface ShadowDisagreementExplanation {
  key: string; head: string; baseTip: string; reason: string; actor: string; at: string;
  /** The verdict evidence the explanation cites: merge sha, failing files, and logTail when the verdict carried one. */
  evidence: { mergeSha: string | null; failed: string[]; logTail?: string; placeholder?: boolean };
}

type Queryable = Pick<pg.PoolClient, 'query'>;

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pairKey = (entry: { key: string; head: string; baseTip: string }) =>
  `${entry.key}:${entry.head.toLowerCase()}:${entry.baseTip.toLowerCase()}`;

export async function recordShadowVerdict(services: Services, actor: Principal, id: string, body: unknown, key: string) {
  demand(actor.role === 'coordinator', 'Only the loop\'s coordinator identity records a shadow verdict', 403);
  const data = shadowVerdictBodySchema.parse(body);
  const fingerprint = digest({ id, data });
  return services.engine.store.transaction(async (db: pg.PoolClient) => {
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const replay = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
    if (replay) { demand(replay.fingerprint === fingerprint, 'Idempotency key reused with different input'); return replay.result; }
    // The index resolves a key or id without reading a document (GY-1027); the verdict itself needs none.
    const item = (await db.query('SELECT i.id::text AS id, i.key FROM work_index i WHERE i.id::text=$1 OR i.key=$1 ORDER BY i.number LIMIT 1', [id])).rows[0] as { id: string; key: string } | undefined;
    demand(item, 'Work item not found', 404);
    await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [item.id, actor.id, shadowVerdictEvent, JSON.stringify({ key: item.key, ...data })]);
    const result = { recorded: true, key: item.key, head: data.head, baseTip: data.baseTip };
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
    return result;
  });
}

/** Every disagreement explanation on the ledger, oldest first. */
export async function listShadowDisagreementExplanations(db: Queryable): Promise<ShadowDisagreementExplanation[]> {
  const rows = (await db.query(
    `SELECT e.actor, e.payload, e.created_at FROM events e WHERE e.kind=$1 ORDER BY e.seq`,
    [shadowDisagreementExplainedEvent],
  )).rows;
  return rows.flatMap(row => {
    const payload = row.payload ?? {};
    if (typeof payload.key !== 'string' || typeof payload.head !== 'string' || typeof payload.baseTip !== 'string') return [];
    const evidence = payload.evidence && typeof payload.evidence === 'object' ? payload.evidence as ShadowDisagreementExplanation['evidence'] : { mergeSha: null, failed: [] as string[] };
    return [{
      key: payload.key, head: String(payload.head).toLowerCase(), baseTip: String(payload.baseTip).toLowerCase(),
      reason: typeof payload.reason === 'string' ? payload.reason : '', actor: String(row.actor),
      at: new Date(row.created_at).toISOString(),
      evidence: {
        mergeSha: typeof evidence.mergeSha === 'string' ? evidence.mergeSha : evidence.mergeSha === null ? null : null,
        failed: Array.isArray(evidence.failed) ? evidence.failed.map(String) : [],
        ...(typeof evidence.logTail === 'string' ? { logTail: evidence.logTail } : {}),
        ...(evidence.placeholder === true ? { placeholder: true } : {}),
      },
    }];
  });
}

/**
 * Which of the named (key, head, baseTip) pairs carry an explanation, as identifiers alone: the
 * loop's per-cycle read (GY-1560). It reads only the named items' own events through their index,
 * at most `shadowExplanationPairsMax` pairs, so its cost follows the pairs asked, not the ledger.
 */
export async function explainedShadowPairs(db: Queryable, pairs: readonly ShadowExplanationRef[]): Promise<ShadowExplanationRef[]> {
  if (!pairs.length) return [];
  const rows = (await db.query(
    `SELECT DISTINCT i.key, lower(e.payload->>'head') AS head, lower(e.payload->>'baseTip') AS base_tip
     FROM work_index i JOIN events e ON e.work_id = i.id
     JOIN unnest($2::text[], $3::text[], $4::text[]) AS wanted(key, head, base_tip)
       ON wanted.key = i.key AND wanted.head = lower(e.payload->>'head') AND wanted.base_tip = lower(e.payload->>'baseTip')
     WHERE i.key = ANY($2::text[]) AND e.kind = $1`,
    [shadowDisagreementExplainedEvent, pairs.map(pair => pair.key), pairs.map(pair => pair.head.toLowerCase()), pairs.map(pair => pair.baseTip.toLowerCase())],
  )).rows as { key: string; head: string; base_tip: string }[];
  return rows.map(row => ({ key: row.key, head: row.head, baseTip: row.base_tip }));
}

const pairQuery = z.array(z.string().regex(/^[^:\s]{1,200}:[0-9a-fA-F]{40}:[0-9a-fA-F]{40}$/)).min(1).max(shadowExplanationPairsMax);

/** The shadow.verdict event for one (key, head, baseTip), or null when none is recorded. */
async function verdictEvidence(db: Queryable, key: string, head: string, baseTip: string) {
  const row = (await db.query(
    `SELECT payload FROM events WHERE kind=$1 AND payload->>'key'=$2 AND lower(payload->>'head')=$3 AND lower(payload->>'baseTip')=$4 ORDER BY seq DESC LIMIT 1`,
    [shadowVerdictEvent, key, head.toLowerCase(), baseTip.toLowerCase()],
  )).rows[0] as { payload: Record<string, unknown> } | undefined;
  if (!row) return null;
  const tests = row.payload.tests as { passed?: number; failed?: string[]; files?: number } | undefined;
  const failed = Array.isArray(tests?.failed) ? tests!.failed.map(String) : [];
  const build = row.payload.build === 'pass' || row.payload.build === 'fail' ? row.payload.build : 'fail';
  const passed = typeof tests?.passed === 'number' ? tests.passed : 0;
  const files = typeof tests?.files === 'number' ? tests.files : 0;
  const placeholder = isPlaceholderVerdict({ build, tests: { passed, failed, files } });
  return {
    mergeSha: typeof row.payload.mergeSha === 'string' ? row.payload.mergeSha : null,
    failed,
    ...(typeof row.payload.logTail === 'string' ? { logTail: row.payload.logTail as string } : {}),
    ...(placeholder ? { placeholder: true as const } : {}),
  };
}

/**
 * Record one explanation of a shadow disagreement for (head, baseTip) on the named work item.
 * Idempotent under Idempotency-Key; a second explanation for the same pair returns the first.
 */
export async function recordShadowDisagreementExplanation(services: Services, actor: Principal, id: string, body: unknown, key: string) {
  demand(actor.role === 'coordinator' || actor.role === 'admin', 'Only a coordinator or admin identity records a shadow disagreement explanation', 403);
  const data = shadowExplainBodySchema.parse(body);
  const fingerprint = digest({ action: 'shadow-explain', id, data });
  return services.engine.store.transaction(async (db: pg.PoolClient, now: Date) => {
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const replay = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
    if (replay) { demand(replay.fingerprint === fingerprint, 'Idempotency key reused with different input'); return replay.result; }
    const item = (await db.query('SELECT i.id::text AS id, i.key FROM work_index i WHERE i.id::text=$1 OR i.key=$1 ORDER BY i.number LIMIT 1', [id])).rows[0] as { id: string; key: string } | undefined;
    demand(item, 'Work item not found', 404);
    const existing = (await listShadowDisagreementExplanations(db)).find(entry => entry.key === item.key && entry.head === data.head && entry.baseTip === data.baseTip);
    if (existing) {
      const result = { ...existing, already: true };
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
      return result;
    }
    const evidence = await verdictEvidence(db, item.key, data.head, data.baseTip);
    demand(evidence, `No shadow.verdict is recorded for ${item.key} head ${data.head} on ${data.baseTip}; an explanation cites the verdict's evidence`, 404);
    const at = now.toISOString();
    const explanation: ShadowDisagreementExplanation = {
      key: item.key, head: data.head, baseTip: data.baseTip, reason: data.reason, actor: actor.id, at, evidence,
    };
    await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [
      item.id, actor.id, shadowDisagreementExplainedEvent,
      JSON.stringify({ key: item.key, head: data.head, baseTip: data.baseTip, reason: data.reason, evidence, at }),
    ]);
    const result = { ...explanation, already: false };
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
    return result;
  });
}

/** A recorded shadow.verdict payload plus the work key, shaped like a ShadowVerdict pending re-judgement. */
function verdictFromEvent(payload: Record<string, unknown>, key: string): Pick<ShadowVerdict, 'key' | 'id' | 'head' | 'baseTip' | 'mergeSha' | 'build' | 'tests' | 'conflict' | 'durationMs' | 'at' | 'outcome' | 'logTail'> | null {
  if (typeof payload.head !== 'string' || typeof payload.baseTip !== 'string') return null;
  const tests = payload.tests as { passed?: number; failed?: string[]; files?: number } | undefined;
  return {
    key, id: typeof payload.id === 'string' ? payload.id : key, head: payload.head.toLowerCase(), baseTip: payload.baseTip.toLowerCase(),
    mergeSha: typeof payload.mergeSha === 'string' ? payload.mergeSha : null,
    build: payload.build === 'pass' ? 'pass' : 'fail',
    tests: { passed: Number(tests?.passed ?? 0), failed: Array.isArray(tests?.failed) ? tests!.failed.map(String) : [], files: Number(tests?.files ?? 0) },
    conflict: Array.isArray(payload.conflict) ? payload.conflict.map(String) : [],
    durationMs: Number(payload.durationMs ?? 0), at: typeof payload.at === 'string' ? payload.at : new Date(0).toISOString(),
    outcome: 'pending',
    ...(typeof payload.logTail === 'string' ? { logTail: payload.logTail } : {}),
  };
}

/**
 * The merge commits GitHub made of the given heads, recovered when an item was later reopened and its
 * delivery/candidate cleared (GY-1560): the newest delivery event on the ledger (`github.observed`
 * with a recorded delivery) for each (key, head), in one query whatever the number of pairs.
 */
async function recoveredDeliveredMerges(db: Queryable, pairs: readonly { key: string; head: string }[]): Promise<Map<string, string>> {
  if (!pairs.length) return new Map();
  const rows = (await db.query(
    `SELECT DISTINCT ON (i.key, lower(e.payload->'work'->'candidate'->>'sha'))
       i.key, lower(e.payload->'work'->'candidate'->>'sha') AS head, lower(e.payload->'work'->'delivery'->>'mergeSha') AS merge_sha
     FROM events e JOIN work_index i ON i.id = e.work_id
     JOIN unnest($1::text[], $2::text[]) AS wanted(key, head) ON wanted.key = i.key AND wanted.head = lower(e.payload->'work'->'candidate'->>'sha')
     WHERE ${DELIVERY_EVENT_PREDICATE} AND e.payload->'work'->'delivery'->>'mergeSha' IS NOT NULL
     ORDER BY i.key, lower(e.payload->'work'->'candidate'->>'sha'), e.seq DESC`,
    [pairs.map(pair => pair.key), pairs.map(pair => pair.head.toLowerCase())],
  )).rows as { key: string; head: string; merge_sha: string }[];
  return new Map(rows.map(row => [`${row.key}:${row.head}`, row.merge_sha]));
}

/** One standing shadow disagreement as the status and merger switch read it. */
export interface StandingShadowDisagreement {
  key: string; head: string; baseTip: string; outcome: 'shadow-only-fail' | 'shadow-missed';
  mergeSha: string | null; build: 'pass' | 'fail'; tests: ShadowVerdict['tests']; conflict: string[]; at: string; explained: boolean;
  /** The failing cause the recorded log tail names, or null when the record names none (GY-1564); the log itself stays on the ledger. */
  cause: string | null;
}

/** The documents of the named work items alone, by key: a bounded read safe under the coordination lock. */
async function workByKeys(db: Queryable, keys: readonly string[]): Promise<Work[]> {
  if (!keys.length) return [];
  return ((await db.query('SELECT w.document FROM work_items w JOIN work_index i ON i.id = w.id WHERE i.key = ANY($1::text[])', [[...keys]])).rows as { document: Work }[]).map(row => row.document);
}

/**
 * Every shadow-only-fail or shadow-missed verdict on the ledger, re-judged with the delivered merge
 * identity recovered when the item was reopened. Used by the merger switch and master status (GY-1560).
 * Without `work`, only the items that carry a verdict are read, so the merger switch's transaction
 * never reads the whole board.
 */
export async function standingShadowDisagreements(db: Queryable, work?: readonly Work[]): Promise<StandingShadowDisagreement[]> {
  const rows = (await db.query(
    `SELECT i.key, e.payload FROM events e JOIN work_index i ON i.id = e.work_id WHERE e.kind=$1 ORDER BY e.seq`,
    [shadowVerdictEvent],
  )).rows as { key: string; payload: Record<string, unknown> }[];
  const explained = new Set((await listShadowDisagreementExplanations(db)).map(pairKey));
  const newest = new Map<string, NonNullable<ReturnType<typeof verdictFromEvent>>>();
  for (const row of rows) {
    const verdict = verdictFromEvent(row.payload, row.key);
    if (!verdict) continue;
    newest.set(pairKey({ key: row.key, head: verdict.head, baseTip: verdict.baseTip }), verdict);
  }
  const items = work ?? await workByKeys(db, [...new Set([...newest.values()].map(verdict => verdict.key))]);
  const byKey = new Map(items.map(item => [item.key, item]));
  // The current document judges most verdicts; only those it cannot judge (a reopened item whose
  // delivery of that head was cleared) recover the delivered merge, in one batched query.
  const judged = [...newest.values()].map(verdict => ({ verdict, item: byKey.get(verdict.key), outcome: compareVerdicts(verdict, githubOutcome(byKey.get(verdict.key), verdict.head)) }));
  const unjudged = judged.filter(entry => entry.outcome === 'pending' && entry.item);
  const recovered = await recoveredDeliveredMerges(db, unjudged.map(entry => ({ key: entry.verdict.key, head: entry.verdict.head })));
  const standing: StandingShadowDisagreement[] = [];
  for (const { verdict, item, outcome: current } of judged) {
    const mergeSha = current === 'pending' ? recovered.get(`${verdict.key}:${verdict.head}`) : undefined;
    const outcome = mergeSha ? compareVerdicts(verdict, githubOutcome(item, verdict.head, { mergeSha })) : current;
    if (outcome !== 'shadow-only-fail' && outcome !== 'shadow-missed') continue;
    standing.push({
      key: verdict.key, head: verdict.head, baseTip: verdict.baseTip, outcome,
      mergeSha: verdict.mergeSha, build: verdict.build, tests: verdict.tests, conflict: verdict.conflict, at: verdict.at,
      cause: trialFailureCause(verdict.logTail),
      explained: explained.has(shadowDisagreementPair(verdict)),
    });
  }
  return standing;
}

/**
 * Every shadow-only-fail or shadow-missed verdict on the ledger that has no explanation, re-judged
 * against recovered deliveries. Used by the merger switch (GY-1560).
 */
export async function unexplainedShadowDisagreements(db: Queryable, work?: readonly Work[]): Promise<{ key: string; head: string; baseTip: string; outcome: string }[]> {
  return (await standingShadowDisagreements(db, work)).filter(entry => !entry.explained)
    .map(entry => ({ key: entry.key, head: entry.head, baseTip: entry.baseTip, outcome: entry.outcome }));
}

/** Read path for the loop and merger status: explanations, standing disagreements, and the placeholder name. */
export async function shadowDisagreementStatus(db: Queryable, work: readonly Work[]) {
  const [explanations, disagreements] = await Promise.all([
    listShadowDisagreementExplanations(db),
    standingShadowDisagreements(db, work),
  ]);
  return { explanations, disagreements, placeholderFailure: placeholderRunnerFailure };
}

/**
 * GY-1560 routes: list explanations with their evidence and the standing disagreements (master
 * status), answer which named pairs are explained (the loop, every cycle: identifiers only, for the
 * disagreements its cursor holds, so its cost does not grow with the ledger), and record one per work item.
 * Registered ahead of the operator-agent guard like the main watch (routes.ts).
 */
export const shadowDisagreementRoutes = defineRoutes('shadow-disagreements', [
  {
    method: 'GET', path: '/api/shadow-disagreements',
    async handle({ actor, services }) {
      demand(['admin', 'coordinator', 'reader', 'operator-agent'].includes(actor.role), 'Shadow disagreement explanations are readable by admin, coordinator, reader and operator-agent identities', 403);
      return shadowDisagreementStatus(services.engine.store.pool, await services.engine.store.list());
    },
  },
  {
    method: 'GET', path: '/api/shadow-explanations',
    async handle({ actor, services, url }) {
      demand(['admin', 'coordinator', 'reader', 'operator-agent'].includes(actor.role), 'Shadow disagreement explanations are readable by admin, coordinator, reader and operator-agent identities', 403);
      const asked = pairQuery.safeParse(url.searchParams.getAll('pair'));
      demand(asked.success, `Name 1 to ${shadowExplanationPairsMax} pairs as pair=KEY:HEAD:BASETIP; the full explanations are at /api/shadow-disagreements`, 400);
      const pairs = asked.data.map(pair => { const [key, head, baseTip] = pair.split(':') as [string, string, string]; return { key, head, baseTip }; });
      return { explanations: await explainedShadowPairs(services.engine.store.pool, pairs) };
    },
  },
  {
    method: 'POST', path: /^\/api\/work\/([^/]+)\/shadow-explain$/,
    async handle(context, [id]) {
      return recordShadowDisagreementExplanation(context.services, context.actor, decodeURIComponent(id), await parseJson(context), context.idempotencyKey());
    },
  },
]);
