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

/**
 * The GitHub repository this code ships from (GY-2964): the scenario revisions shipped in this
 * module are its own `e2e/cases/` cases, so they are materialized only for an install that manages
 * this repository itself. An install managing another repository registers only the cases synced
 * from that repository's `e2e/cases/`, and its Tests page shows no cases until it has some.
 */
export const graphyardRepository = 'cryptob1/graphyard';

/** Query surface used to resolve a scenario revision (pool or a transaction client). */
type ScenarioDb = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/**
 * GY-1708: revision 1 of `capacity-limit-redispatch`, shipped with the release so master create
 * accepts `e2e:capacity-limit-redispatch` before any e2e sync. Fields match
 * `scenarioDefinition` of `e2e/cases/capacity-limit-redispatch.json`.
 */
export function capacityLimitRedispatchRevision(createdAt = new Date().toISOString(), createdBy = 'graphyard'): Scenario {
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

/**
 * GY-2992: the spec-check-shown dashboard case. Its created feature item cites
 * `e2e:spec-check-shown` (a user-facing feature carries an e2e proof), so — for GY-1800's reason —
 * revision 1 ships here: on a fresh registry no e2e sync has run yet, and create would refuse the
 * proof naming a scenario the registry lacks. It is defined in code, exactly as its file under
 * `e2e/cases/` defines it, because the released image carries no `e2e/`; the file stays the source
 * e2e sync revises later.
 */
export const specCheckShownScenario = 'spec-check-shown';
export const specCheckShownCase = (): E2eCase => caseSchema.parse({
  id: "spec-check-shown", title: "A feature item shows its spec check: the paraphrase, the gaps and the verdict",
  description: "A released feature item is checked before a worker starts (GY-2992): a fresh-context reviewer restates the item and names its gaps. The case records a spec check — a gaps verdict with its paraphrase and gaps, bound to the policy revision it judged — on a feature item through the same route an operator or the loop uses, reads it back on the API, and opens the item in the dashboard, where the Spec check panel shows the paraphrase, the gaps and the verdict.",
  tags: ["api", "dashboard", "spec-check"], target: "uat", required: true,
  steps: [
    {"kind": "http", "name": "create the feature item", "method": "POST", "path": "/api/work", "body": {"title": "E2E case {{case}} run {{run}}", "description": "The export flow moves behind the settings screen, added by the spec-check-shown E2E case so a feature item can carry a recorded spec check.", "type": "feature", "priority": 3, "criteria": [{"id": "AC-1", "text": "A signed-up user can export their data from the settings screen", "proofs": ["e2e:spec-check-shown"]}], "policy": {"checks": ["test"], "review": true}}, "status": 200, "save": {"id": "id", "key": "key"}},
    {"kind": "http", "name": "record the spec check: a gaps verdict with its paraphrase and gaps, on the revision it judged", "method": "POST", "path": "/api/work/{{id}}/spec-check", "body": {"reviewer": "spec-checker", "verdict": "gaps", "paraphrase": "The change moves the export flow behind the settings screen; AC-1 is proven by the e2e case that signs up and exports.", "gaps": ["AC-1 does not say which of the two export buttons the flow starts from"]}, "status": 200},
    {"kind": "http", "name": "the item answers its spec check bound to the revision", "method": "GET", "path": "/api/work/{{id}}", "status": 200, "expect": [{"path": "specCheck.verdict", "equals": "gaps"}, {"path": "specCheck.reviewer", "equals": "spec-checker"}, {"path": "specCheck.paraphrase", "type": "string"}, {"path": "specCheck.gaps.0", "equals": "AC-1 does not say which of the two export buttons the flow starts from"}, {"path": "specCheck.policyRevision", "equals": 1}]},
    {"kind": "browser", "name": "sign in to the dashboard", "action": "open", "path": "/"},
    {"kind": "browser", "action": "fill", "label": "Access token", "value": "{{token}}"},
    {"kind": "browser", "action": "click", "role": "button", "text": "Open control plane", "exact": false},
    {"kind": "browser", "name": "unfold the backlog group and open the item", "action": "click", "text": "Backlog", "exact": false},
    {"kind": "browser", "action": "click", "text": "E2E case {{case}} run {{run}}", "exact": false},
    {"kind": "browser", "name": "the spec check panel shows the verdict", "action": "expectText", "text": "Spec check", "exact": false, "role": "heading"},
    {"kind": "browser", "name": "the verdict reads as gaps", "action": "expectText", "text": "Gaps"},
    {"kind": "browser", "name": "the paraphrase the reviewer gave is shown", "action": "expectText", "text": "The change moves the export flow behind the settings screen", "exact": false},
    {"kind": "browser", "name": "the gap the reviewer named is shown", "action": "expectText", "text": "AC-1 does not say which of the two export buttons the flow starts from", "exact": false},
    {"kind": "browser", "name": "the panel says what a gaps verdict holds", "action": "expectText", "text": "held at ready until master requirements revises the item", "exact": false},
  ],
});
export const specCheckShownRevision = (createdAt = new Date().toISOString(), createdBy = 'graphyard'): Scenario =>
  shippedCaseRevision(specCheckShownCase(), createdAt, createdBy);

/** Revision 1 of a case shipped in code: exactly the revision `e2e sync` registers from its file under `e2e/cases/`. The timestamp is real (GY-2964): a seeded revision never reads as the epoch. */
export function shippedCaseRevision(definition: E2eCase, createdAt = new Date().toISOString(), createdBy = 'graphyard'): Scenario {
  const scenario = scenarioDefinition({ file: `${caseDirectory}/${definition.id}.json`, definition });
  return { ...scenario, revision: 1, hash: createHash('sha256').update(JSON.stringify(scenario)).digest('hex'), createdAt, createdBy };
}

/**
 * Every scenario revision this release ships in code (GY-1708, GY-1800), for an install managing
 * Graphyard's own repository. Another managed repository ships none (GY-2964): its cases come from
 * its own `e2e/cases/`, and Graphyard's internal cases never stand in for them.
 */
export const shippedScenarioRevisions = (repository: string | null | undefined = graphyardRepository): Scenario[] =>
  repository?.toLowerCase() === graphyardRepository ? [capacityLimitRedispatchRevision(), specCheckShownRevision(), ...fixtureCases().map(definition => shippedCaseRevision(definition))] : [];

/** The shipped revision for `id`, or undefined when this release does not ship one to `repository`. */
export const shippedScenario = (id: string, repository?: string | null): Scenario | undefined => shippedScenarioRevisions(repository).find(entry => entry.id === id);

/**
 * Insert every shipped revision that is not yet a row, appending `scenario.defined` when the insert
 * lands. Listing, create and run-recording call this so a fresh install has a usable registered
 * revision for sync and `recordCaseRun`, not a virtual GET-only entry that leaves the table empty
 * (GY-1708 AC-3).
 */
export async function ensureShippedScenarios(db: ScenarioDb, repository: string | null | undefined = graphyardRepository, actor = 'graphyard'): Promise<void> {
  for (const shipped of shippedScenarioRevisions(repository)) {
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
export async function resolveScenario(db: ScenarioDb, id: string, persist?: { at: Date; by: string }, repository?: string | null): Promise<Scenario | undefined> {
  const latest = (await db.query('SELECT document FROM scenarios WHERE id=$1 ORDER BY revision DESC LIMIT 1', [id])).rows[0]?.document as Scenario | undefined;
  if (latest) return latest;
  const shipped = shippedScenario(id, repository);
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
export async function scenarios(store: Store, repository: string | null | undefined = graphyardRepository): Promise<Scenario[]> {
  // GY-1708: materialize shipped revisions into the table so GET never advertises a virtual row
  // that e2e sync would treat as unchanged while leaving recordCaseRun with nothing to look up.
  // Only Graphyard's own repository install ships them (GY-2964); another managed repository
  // lists exactly the cases its own e2e sync registered. The revision row and scenario.defined
  // append in one Store.transaction: a failed event write rolls both back so a later listing
  // retries instead of leaving an unaudited durable row.
  await store.transaction(async db => { await ensureShippedScenarios(db, repository); });
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
 * history window and, for a repository E2E case, its tags, target and required mark from the latest
 * revision. An install managing a repository other than Graphyard's own never lists that release's
 * seeded built-in scenarios (GY-2964): rows an older release seeded there (by `graphyard`, with no
 * runs of their own) stay in the registry but are not the repository's cases, so they are left out.
 */
export async function trackedCases(db: Store['pool'], repository?: string | null): Promise<{ window: number; cases: TrackedCase[] }> {
  const summary = await testSummary(db);
  const definitions = new Map<string, Scenario>((await db.query('SELECT DISTINCT ON (id) document FROM scenarios ORDER BY id, revision DESC')).rows.map(row => [row.document.id, row.document]));
  const seededElsewhere = repository?.toLowerCase() !== graphyardRepository;
  return { window: summary.window, cases: summary.cases.filter(entry => !(seededElsewhere && !entry.runs && entry.changed?.by === 'graphyard')).map(entry => {
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
export async function recordCaseRun(store: Store, actor: Principal, id: string, input: unknown, authorize?: OperatorAuthorizer, repository: string | null | undefined = graphyardRepository): Promise<CaseRun> {
  const recorder = caseRecorder(actor);
  if (!recorder) admin(actor);
  const data = caseRunSchema.parse(input);
  return store.transaction(async (db, now) => {
    if (recorder) await revalidateRecorder(db, now, actor, authorize);
    // GY-1708: a shipped revision must be a real row before lookup, so a fresh install can record
    // a case run without a prior sync (or a create that happened to persist it). Only Graphyard's
    // own repository install ships them (GY-2964).
    await ensureShippedScenarios(db, repository);
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
