import { createHash } from 'node:crypto';
import { z } from 'zod';
import { admin, demand, type Principal } from './model.js';
import { runKey, type ScenarioRun } from './model/test-cases.js';
import type { Store } from './store.js';

export const scenarioSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).max(100),
  title: z.string().min(1).max(200),
  purpose: z.string().min(1).max(5000),
  setup: z.array(z.string().min(1).max(2000)).max(30).default([]),
  steps: z.array(z.string().min(1).max(2000)).min(1).max(50),
  expected: z.array(z.string().min(1).max(2000)).min(1).max(50),
  environment: z.string().regex(/^[a-zA-Z0-9._-]+$/).max(100),
  runner: z.string().min(1).max(100),
  testPath: z.string().min(1).max(1000),
  /** Set by the E2E case repository (src/e2e/case.ts); a case defined by hand has none. */
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
  expectedRevision: z.number().int().min(0).default(0),
}).strict();
export type Scenario = Omit<z.infer<typeof scenarioSchema>, 'expectedRevision'> & { revision: number; hash: string; createdAt: string; createdBy: string };
export async function scenarios(store: Store): Promise<Scenario[]> {
  return (await store.pool.query('SELECT document FROM scenarios ORDER BY id,revision DESC')).rows.map(r => r.document);
}
export async function defineScenario(store: Store, actor: Principal, input: unknown, key: string) {
  admin(actor);
  demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
  const data = scenarioSchema.parse(input);
  const fingerprint = createHash('sha256').update(JSON.stringify({ command: 'scenario.define', data })).digest('hex');
  return store.transaction(async (db, now) => {
    const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
    if (receipt) { demand(receipt.fingerprint === fingerprint, 'Idempotency key reused with different input'); return receipt.result as Scenario; }
    const latest = (await db.query('SELECT revision FROM scenarios WHERE id=$1 ORDER BY revision DESC LIMIT 1', [data.id])).rows[0];
    demand((latest?.revision ?? 0) === data.expectedRevision, 'Scenario changed; read the latest revision before publishing a new version');
    const { expectedRevision, ...definition } = data;
    const scenario: Scenario = { ...definition, revision: expectedRevision + 1, hash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'), createdAt: now.toISOString(), createdBy: actor.id };
    await db.query('INSERT INTO scenarios(id,revision,document) VALUES($1,$2,$3)', [scenario.id, scenario.revision, JSON.stringify(scenario)]);
    await db.query('INSERT INTO events(actor,kind,payload) VALUES($1,$2,$3)', [actor.id, 'scenario.defined', JSON.stringify({ scenario })]);
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(scenario)]);
    return scenario;
  });
}

/** One E2E case run (GY-1351) as `graphyard e2e run` reports it against a registered revision. */
export const caseRunSchema = z.object({
  revision: z.number().int().min(1),
  runId: z.string().regex(/^[a-zA-Z0-9._:-]+$/).max(100),
  baseUrl: z.string().url().max(500),
  /** The commit the target's /healthz reported serving, or null when it reported none. */
  sha: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  environment: z.string().regex(/^[a-zA-Z0-9._:-]+$/).max(100),
  durationMs: z.number().int().min(0).max(86_400_000),
  outcome: z.enum(['pass', 'fail']),
  /** The steps that ran, the failing one included. */
  executed: z.number().int().min(0).max(50),
  failingStep: z.object({ index: z.number().int().min(0).max(49), name: z.string().min(1).max(500), reason: z.string().min(1).max(1000) }).strict().nullable(),
}).strict().refine(run => (run.outcome === 'fail') === (run.failingStep !== null), 'A failed run names its failing step, and a passing run names none');

/**
 * Append one E2E case run to its scenario revision's history, an operator's command like defining
 * the case. The run is bound to the revision it measured, the base URL and the commit that URL
 * served; a retried report of the same run is the same row.
 */
export async function recordCaseRun(store: Store, actor: Principal, id: string, input: unknown): Promise<ScenarioRun> {
  admin(actor);
  const data = caseRunSchema.parse(input);
  return store.transaction(async (db, now) => {
    const scenario: Scenario | undefined = (await db.query('SELECT document FROM scenarios WHERE id=$1 AND revision=$2', [id, data.revision])).rows[0]?.document;
    demand(scenario, `Scenario ${id} has no revision ${data.revision}; run graphyard e2e sync first`, 404);
    const run: Omit<ScenarioRun, 'seq'> = { scenarioId: id, proof: `e2e:${id}`, result: data.outcome, scenarioRevision: data.revision, environment: data.environment,
      executed: data.executed, skipped: 0, sha: data.sha ?? 'unknown', baseSha: '', policyRevision: 0, workId: '', workKey: '', pr: null,
      run: { kind: 'e2e', id: data.runId, attempt: null, url: null }, evidenceId: '', producer: actor.id, at: now.toISOString(),
      e2e: { baseUrl: data.baseUrl, durationMs: data.durationMs, failingStep: data.failingStep } };
    const inserted = (await db.query('INSERT INTO scenario_runs(scenario,run_key,document) VALUES($1,$2,$3) ON CONFLICT (run_key) DO NOTHING RETURNING seq', [id, runKey(run), JSON.stringify(run)])).rows[0];
    if (!inserted) {
      const existing = (await db.query('SELECT seq, document FROM scenario_runs WHERE run_key=$1', [runKey(run)])).rows[0];
      return { ...existing.document, seq: Number(existing.seq) };
    }
    await db.query('INSERT INTO events(actor,kind,payload) VALUES($1,$2,$3)', [actor.id, 'scenario.run-recorded', JSON.stringify({ scenario: id, revision: data.revision, runId: data.runId, outcome: data.outcome, sha: data.sha, environment: data.environment })]);
    return { ...run, seq: Number(inserted.seq) };
  });
}
