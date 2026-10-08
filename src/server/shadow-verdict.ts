import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { demand, type Principal, type Work } from '../model.js';
import {
  compareVerdicts, githubOutcome, isPlaceholderVerdict, placeholderRunnerFailure, shadowDisagreement,
  trialLogTailLength, type ShadowVerdict,
} from '../merge-writer/shadow.js';
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
 * Every shadow-only-fail or shadow-missed verdict on the ledger that has no explanation, re-judged
 * against the work items' deliveries. Used by the merger switch (GY-1560).
 */
export async function unexplainedShadowDisagreements(db: Queryable, work: readonly Work[]): Promise<{ key: string; head: string; baseTip: string; outcome: string }[]> {
  const rows = (await db.query(
    `SELECT i.key, e.payload FROM events e JOIN work_index i ON i.id = e.work_id WHERE e.kind=$1 ORDER BY e.seq`,
    [shadowVerdictEvent],
  )).rows as { key: string; payload: Record<string, unknown> }[];
  const explained = new Set((await listShadowDisagreementExplanations(db)).map(pairKey));
  const newest = new Map<string, ReturnType<typeof verdictFromEvent>>();
  for (const row of rows) {
    const verdict = verdictFromEvent(row.payload, row.key);
    if (!verdict) continue;
    newest.set(pairKey({ key: row.key, head: verdict.head, baseTip: verdict.baseTip }), verdict);
  }
  const unexplained: { key: string; head: string; baseTip: string; outcome: string }[] = [];
  for (const verdict of newest.values()) {
    if (!verdict) continue;
    const item = work.find(candidate => candidate.key === verdict.key);
    const outcome = compareVerdicts(verdict, githubOutcome(item, verdict.head, item ? undefined : null));
    if (!shadowDisagreement(outcome)) continue;
    if (explained.has(pairKey(verdict))) continue;
    unexplained.push({ key: verdict.key, head: verdict.head, baseTip: verdict.baseTip, outcome });
  }
  return unexplained;
}

/** Read path for the loop and merger status: every explanation, plus the fabricated-runner placeholder name. */
export async function shadowDisagreementStatus(db: Queryable) {
  return { explanations: await listShadowDisagreementExplanations(db), placeholderFailure: placeholderRunnerFailure };
}

/**
 * GY-1560 routes: list explanations (loop + merger status), and record one per work item.
 * Registered ahead of the operator-agent guard like the main watch (routes.ts).
 */
export const shadowDisagreementRoutes = defineRoutes('shadow-disagreements', [
  {
    method: 'GET', path: '/api/shadow-disagreements',
    async handle({ actor, services }) {
      demand(['admin', 'coordinator', 'reader', 'operator-agent'].includes(actor.role), 'Shadow disagreement explanations are readable by admin, coordinator, reader and operator-agent identities', 403);
      return shadowDisagreementStatus(services.engine.store.pool);
    },
  },
  {
    method: 'POST', path: /^\/api\/work\/([^/]+)\/shadow-explain$/,
    async handle(context, [id]) {
      return recordShadowDisagreementExplanation(context.services, context.actor, decodeURIComponent(id), await parseJson(context), context.idempotencyKey());
    },
  },
]);
