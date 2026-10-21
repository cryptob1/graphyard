import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { admin, demand, type Principal } from './model.js';
import { flakiness, type RunIdentity, type ScenarioRun } from './model/test-cases.js';
import { testSummary, type CaseSummary } from './test-runs.js';
import { caseDirectory, caseRunner, caseSchema, scenarioDefinition, type E2eCase } from './e2e/case.js';
import type { Store } from './store.js';

/**
 * GY-1708: scenario id the capacity fault-class filing cites as `e2e:capacity-limit-redispatch`.
 * Revision 1 ships in this module (`capacityLimitRedispatchRevision`); listing, create and
 * run-recording materialize it into the scenarios table so filings, e2e sync and case runs work
 * on a fresh install without a prior sync. The matching optional case under `e2e/cases/` stays
 * the source e2e sync revises later.
 */
export const capacityLimitRedispatchScenario = 'capacity-limit-redispatch';

/** Query surface used to resolve a scenario revision (pool or a transaction client). */
type ScenarioDb = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/**
 * GY-1708: revision 1 of `capacity-limit-redispatch`, shipped with the release so master create
 * accepts `e2e:capacity-limit-redispatch` before any e2e sync. Fields match
 * `scenarioDefinition` of `e2e/cases/capacity-limit-redispatch.json`.
 */
export function capacityLimitRedispatchRevision(createdAt = '1970-01-01T00:00:00.000Z', createdBy = 'graphyard'): Scenario {
  const listStep = JSON.stringify({
    kind: 'http', name: 'shipped scenario revision is listed', method: 'GET', path: '/api/scenarios', status: 200,
    expect: [{ path: '', includes: { id: capacityLimitRedispatchScenario, revision: 1, runner: caseRunner, testPath: `e2e/cases/${capacityLimitRedispatchScenario}.json` } }],
  });
  const proofStep = JSON.stringify({
    kind: 'command', name: 'mid-attempt capacity redispatch proofs',
    // Through the reserving harness: e2e stepEnvironment omits GRAPHYARD_TEST_PORT, so
    // `node --test` would bind fixed ports outside any reserved window.
    run: 'node --import tsx tests/helpers/run-tests.ts tests/capacity-redispatch-preserves-attempt.test.ts tests/capacity-hold-respects-machine-bounds.test.ts',
    timeoutSeconds: 600,
  });
  const definition = {
    id: capacityLimitRedispatchScenario,
    title: 'Mid-attempt provider limit exhaustion redispatches without losing work',
    purpose: 'Asserts the shipped capacity-limit-redispatch scenario revision is listed and runs the mid-attempt redispatch proofs (hold, failover, preserved work, truthful role bounds) without creating backlog items.',
    setup: [] as string[],
    steps: [listStep, proofStep],
    expected: [
      'GET /api/scenarios answers 200',
      `(body) includes ${JSON.stringify({ id: capacityLimitRedispatchScenario, revision: 1, runner: caseRunner, testPath: `e2e/cases/${capacityLimitRedispatchScenario}.json` })}`,
      'mid-attempt capacity redispatch proofs exits 0',
    ],
    environment: 'any',
    runner: caseRunner,
    testPath: `e2e/cases/${capacityLimitRedispatchScenario}.json`,
    tags: ['capacity'],
    required: false,
  };
  return { ...definition, revision: 1, hash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'), createdAt, createdBy };
}

/**
 * GY-1800: the fixture project's declared application cases. GOAL-1's required uat cases
 * (preview-serves-change, previews-for-declared-apps and preview-isolation-cleanup) create work whose
 * criteria cite `e2e:fixture-static-home` and `e2e:fixture-compose-app`, and create refuses a proof
 * naming a scenario the registry lacks, so each failed at its first create until revision 1 of each
 * shipped here. They target
 * `any`: each runs against a change's preview of the fixture site or app, never UAT itself. The
 * matching files under `e2e/cases/` stay the source e2e sync revises later.
 */
export const fixtureStaticHomeScenario = 'fixture-static-home';
export const fixtureComposeAppScenario = 'fixture-compose-app';
const fixtureCase = (id: string, what: string, title: string, description: string, heading: string): E2eCase => caseSchema.parse({
  id, title, description, tags: ['fixture', 'preview'], target: 'any', required: false,
  steps: [{ kind: 'browser', name: `open the ${what}'s preview`, action: 'open', path: '/' }, { kind: 'browser', action: 'expectText', text: heading, exact: false }],
});
/** The fixture cases exactly as their files under `e2e/cases/` define them. */
export const fixtureCases = (): E2eCase[] => [
  fixtureCase(fixtureStaticHomeScenario, 'static site', "The fixture static site's home shows the change",
    "The declared static site of the fixture project, served in a change's local preview: its home page shows the site, and the change on it.", 'Fixture static site'),
  fixtureCase(fixtureComposeAppScenario, 'compose app', "The fixture compose app's page shows the change",
    "The declared Compose-backed application of the fixture project, served in a change's local preview against its own database: its page shows the running app, and the change on it.", 'Fixture compose app'),
];

/** Revision 1 of a case shipped in code: exactly the revision `e2e sync` registers from its file under `e2e/cases/`. */
export function shippedCaseRevision(definition: E2eCase, createdAt = '1970-01-01T00:00:00.000Z', createdBy = 'graphyard'): Scenario {
  const scenario = scenarioDefinition({ file: `${caseDirectory}/${definition.id}.json`, definition });
  return { ...scenario, revision: 1, hash: createHash('sha256').update(JSON.stringify(scenario)).digest('hex'), createdAt, createdBy };
}

/** Every scenario revision this release ships in code (GY-1708, GY-1800). */
export const shippedScenarioRevisions = (): Scenario[] => [capacityLimitRedispatchRevision(), ...fixtureCases().map(definition => shippedCaseRevision(definition))];

/** The shipped revision for `id`, or undefined when this release does not ship one. */
export const shippedScenario = (id: string): Scenario | undefined => shippedScenarioRevisions().find(entry => entry.id === id);

/**
 * Insert every shipped revision that is not yet a row, appending `scenario.defined` when the insert
 * lands. Listing, create and run-recording call this so a fresh install has a usable registered
 * revision for sync and `recordCaseRun`, not a virtual GET-only entry that leaves the table empty
 * (GY-1708 AC-3).
 */
export async function ensureShippedScenarios(db: ScenarioDb, actor = 'graphyard'): Promise<void> {
  for (const shipped of shippedScenarioRevisions()) {
    const inserted = (await db.query(
      'INSERT INTO scenarios(id,revision,document) VALUES($1,$2,$3) ON CONFLICT (id,revision) DO NOTHING RETURNING document',
      [shipped.id, shipped.revision, JSON.stringify(shipped)],
    )).rows[0];
    if (inserted) await db.query('INSERT INTO events(actor,kind,payload) VALUES($1,$2,$3)', [actor, 'scenario.defined', JSON.stringify({ scenario: shipped })]);
  }
}

/**
 * Latest revision of `id`: the scenarios table when present, else the shipped revision. When
 * `persist` is set and only the shipped revision exists, it is inserted so create pins a real row
 * without a test-only or operator e2e sync.
 */
export async function resolveScenario(db: ScenarioDb, id: string, persist?: { at: Date; by: string }): Promise<Scenario | undefined> {
  const latest = (await db.query('SELECT document FROM scenarios WHERE id=$1 ORDER BY revision DESC LIMIT 1', [id])).rows[0]?.document as Scenario | undefined;
  if (latest) return latest;
  const shipped = shippedScenario(id);
  if (!shipped) return undefined;
  if (!persist) return shipped;
  const document: Scenario = { ...shipped, createdAt: persist.at.toISOString(), createdBy: persist.by };
  const inserted = (await db.query(
    'INSERT INTO scenarios(id,revision,document) VALUES($1,$2,$3) ON CONFLICT (id,revision) DO NOTHING RETURNING document',
    [document.id, document.revision, JSON.stringify(document)],
  )).rows[0];
  if (inserted) await db.query('INSERT INTO events(actor,kind,payload) VALUES($1,$2,$3)', [persist.by, 'scenario.defined', JSON.stringify({ scenario: document })]);
  return (await db.query('SELECT document FROM scenarios WHERE id=$1 ORDER BY revision DESC LIMIT 1', [id])).rows[0]?.document as Scenario | undefined ?? document;
}

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
  /** Whether a release requires the case (GY-1378); an optional case runs and is recorded but never blocks. */
  required: z.boolean().optional(),
  expectedRevision: z.number().int().min(0).default(0),
}).strict();
export type Scenario = Omit<z.infer<typeof scenarioSchema>, 'expectedRevision'> & { revision: number; hash: string; createdAt: string; createdBy: string };
export async function scenarios(store: Store): Promise<Scenario[]> {
  // GY-1708: materialize shipped revisions into the table so GET never advertises a virtual row
  // that e2e sync would treat as unchanged while leaving recordCaseRun with nothing to look up.
  // The revision row and scenario.defined append in one Store.transaction: a failed event write
  // rolls both back so a later listing retries instead of leaving an unaudited durable row.
  await store.transaction(async db => { await ensureShippedScenarios(db); });
  return (await store.pool.query('SELECT document FROM scenarios ORDER BY id,revision DESC')).rows.map(r => r.document as Scenario);
}
/**
 * An operator, or an operator agent holding `e2e:record` (GY-1614): the uat job records a candidate's
 * case runs with that narrow identity, since the candidate's own checkout runs the recording command
 * and must never hold an admin credential. It reaches repository E2E cases only, never a case
 * defined by hand; the route guard (src/server/auth.ts) and authentication already confine it to
 * these routes and its repository.
 */
const caseRecorder = (actor: Principal) => actor.role === 'operator-agent' && !!actor.capabilities?.includes('e2e:record');
type OperatorAuthorizer = (db: pg.PoolClient, now: Date, actor: Principal) => Promise<Principal>;
/** The recorder is read again under the transaction's lock, so one revoked, expired or stripped of e2e:record since it authenticated writes nothing. */
async function revalidateRecorder(db: pg.PoolClient, now: Date, actor: Principal, authorize: OperatorAuthorizer | undefined) {
  demand(authorize, 'Operator-agent authorization is unavailable', 503);
  demand(caseRecorder(await authorize!(db, now, actor)), 'Operator agent no longer holds e2e:record', 403);
}
const repositoryCase = (runner: string | undefined) => demand(runner === caseRunner, `An e2e:record operator agent records repository E2E cases (runner ${caseRunner}) only`, 403);
export async function defineScenario(store: Store, actor: Principal, input: unknown, key: string, authorize?: OperatorAuthorizer) {
  const recorder = caseRecorder(actor);
  if (!recorder) admin(actor);
  demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
  const data = scenarioSchema.parse(input);
  if (recorder) repositoryCase(data.runner);
  const fingerprint = createHash('sha256').update(JSON.stringify({ command: 'scenario.define', data })).digest('hex');
  return store.transaction(async (db, now) => {
    if (recorder) await revalidateRecorder(db, now, actor, authorize);
    const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
    if (receipt) { demand(receipt.fingerprint === fingerprint, 'Idempotency key reused with different input'); return receipt.result as Scenario; }
    const latest = (await db.query('SELECT revision, document FROM scenarios WHERE id=$1 ORDER BY revision DESC LIMIT 1', [data.id])).rows[0];
    // Nor may it turn a case defined by hand into a repository case by revising it.
    if (recorder && latest) repositoryCase(latest.document.runner);
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

/** The detail an E2E case run adds to a scenario run: where it ran, how long it took, the step that failed. */
export interface E2eRunDetail { baseUrl: string; durationMs: number; failingStep: { index: number; name: string; reason: string } | null }
/** A scenario run as the Tests page reads it: a trusted evidence run, or an E2E case run (`run.kind` `e2e`). */
export type CaseRun = Omit<ScenarioRun, 'run'> & { run: Omit<RunIdentity, 'kind'> & { kind: RunIdentity['kind'] | 'e2e' }; e2e?: E2eRunDetail };
/** One case as the Tests page reads it: its summary, its pass rate, and whether it is a repository E2E case. */
export type TrackedCase = Omit<CaseSummary, 'latest' | 'lastFailure' | 'history'> & {
  latest: CaseRun | null; lastFailure: CaseRun | null; history: CaseRun[];
  /** Passed runs over judged runs (neither skipped nor withdrawn) in the history window, or null when none was judged. */
  passRate?: number | null;
  /** A repository E2E case (src/e2e/case.ts): its file's tags, target and whether a release requires it; null for a case defined by hand. */
  e2e?: { tags: string[]; target: string; required: boolean } | null;
};

/**
 * The Tests page's read (GY-1351): every case's bounded summary, each with its pass rate over the
 * history window and, for a repository E2E case, its tags, target and required mark from the latest revision.
 */
export async function trackedCases(db: Store['pool']): Promise<{ window: number; cases: TrackedCase[] }> {
  const summary = await testSummary(db);
  const definitions = new Map<string, Scenario>((await db.query('SELECT DISTINCT ON (id) document FROM scenarios ORDER BY id, revision DESC')).rows.map(row => [row.document.id, row.document]));
  return { window: summary.window, cases: summary.cases.map(entry => {
    const judged = entry.history.filter(run => !run.withdrawn && run.result !== 'skipped');
    const definition = definitions.get(entry.id);
    // A run whose target reported no commit is stored on `unknown`; such runs share no commit, so they never make a case flaky together.
    const unknown = entry.history.some(run => run.sha === 'unknown')
      && (({ flaky, reason }) => ({ flaky, flakyReason: reason }))(flakiness(entry.history.map(run => run.sha === 'unknown' ? { ...run, sha: `unknown-${run.seq}` } : run) as ScenarioRun[]));
    return { ...entry, ...(unknown || {}), passRate: judged.length ? judged.filter(run => run.result === 'pass').length / judged.length : null,
      e2e: definition?.runner === caseRunner ? { tags: definition.tags ?? [], target: definition.environment, required: definition.required ?? false } : null };
  }) };
}

/**
 * Append one E2E case run to its scenario revision's history, an operator's command like defining
 * the case. The run is bound to the revision it measured, the base URL and the commit that URL
 * served; a retried report of the same run is the same row.
 */
export async function recordCaseRun(store: Store, actor: Principal, id: string, input: unknown, authorize?: OperatorAuthorizer): Promise<CaseRun> {
  const recorder = caseRecorder(actor);
  if (!recorder) admin(actor);
  const data = caseRunSchema.parse(input);
  return store.transaction(async (db, now) => {
    if (recorder) await revalidateRecorder(db, now, actor, authorize);
    // GY-1708: a shipped revision must be a real row before lookup, so a fresh install can record
    // a case run without a prior sync (or a create that happened to persist it).
    await ensureShippedScenarios(db);
    const scenario: Scenario | undefined = (await db.query('SELECT document FROM scenarios WHERE id=$1 AND revision=$2', [id, data.revision])).rows[0]?.document;
    if (recorder && scenario) repositoryCase(scenario.runner);
    demand(scenario, `Scenario ${id} has no revision ${data.revision}; run graphyard e2e sync first`, 404);
    const run: Omit<CaseRun, 'seq'> = { scenarioId: id, proof: `e2e:${id}`, result: data.outcome, scenarioRevision: data.revision, environment: data.environment,
      executed: data.executed, skipped: 0, sha: data.sha ?? 'unknown', baseSha: '', policyRevision: 0, workId: '', workKey: '', pr: null,
      run: { kind: 'e2e', id: data.runId, attempt: null, url: null }, evidenceId: '', producer: actor.id, at: now.toISOString(),
      e2e: { baseUrl: data.baseUrl, durationMs: data.durationMs, failingStep: data.failingStep } };
    // The key a trusted run's would be (src/model/test-cases.ts runKey), in the e2e lane: one row per reported run.
    const key = [run.proof, run.sha, run.baseSha, run.run.kind, run.run.id, 0].join(':');
    const inserted = (await db.query('INSERT INTO scenario_runs(scenario,run_key,document) VALUES($1,$2,$3) ON CONFLICT (run_key) DO NOTHING RETURNING seq', [id, key, JSON.stringify(run)])).rows[0];
    if (!inserted) {
      const existing = (await db.query('SELECT seq, document FROM scenario_runs WHERE run_key=$1', [key])).rows[0];
      return { ...existing.document, seq: Number(existing.seq) };
    }
    await db.query('INSERT INTO events(actor,kind,payload) VALUES($1,$2,$3)', [actor.id, 'scenario.run-recorded', JSON.stringify({ scenario: id, revision: data.revision, runId: data.runId, outcome: data.outcome, sha: data.sha, environment: data.environment })]);
    return { ...run, seq: Number(inserted.seq) };
  });
}
