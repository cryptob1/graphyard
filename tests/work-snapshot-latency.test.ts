import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import { Store, storeConnectionTimeoutMs, storeStatementTimeoutMs } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { processJob } from '../src/github.js';
import { invalidateFlowReports } from '../src/flow-analytics.js';
import { evidenceIndependenceRefusals, type Evidence, type Work } from '../src/model.js';
import { reconcileAutoDispatch, type DispatchRequest } from '../src/model/dispatch.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, missingProofs, runDaemon, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { dispatchSummary, emptyDispatchCursor, runAutoDispatch, tickRetryDelay, type DispatchCursor, type DispatchEffects } from '../src/auto-dispatch.js';
import { proofOutcome } from '../src/producer.js';
import { coordinationHistoryLimit, coordinationViewHeader, coordinationSnapshot as trimInProcess, coordinationWork } from '../src/server/work-view.js';
import { cycleBudget } from '../src/cli/master.js';
import { assertTiming, minimumSamples, steadyState } from './helpers/timing.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// A ledger the size production reached and beyond: 100 items, each carrying the history a long-lived
// item accumulates (evidence for every head it ever had, the per-file scope comparison of its last
// observation, dozens of resolved dispatch requests) and thousands of github.observed events whose
// payloads are whole documents.
const ITEMS = 100, OBSERVATIONS_PER_ITEM = 40, HEADS_PER_ITEM = 12;
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'c'.repeat(40);

let database: EmbeddedPostgres; let store: Store; let http: ReturnType<typeof server>; let origin: string; let directory: string;
let config: MasterConfig;

const sha = (item: number, head: number) => `${item.toString(16).padStart(4, '0')}${head.toString(16).padStart(4, '0')}`.padEnd(40, 'a');
const base = 'b'.repeat(40);

function ledgerItem(index: number, now: Date): Work {
  const id = randomUUID(), key = `GY-${index + 1}`;
  const proofs = ['integration:alpha', 'integration:beta', 'e2e:gamma'];
  const head = sha(index, HEADS_PER_ITEM);
  const stage = (['build', 'review', 'test', 'acceptance', 'merge', 'done'] as const)[index % 6];
  const evidence: Evidence[] = [];
  for (let h = 1; h <= HEADS_PER_ITEM; h++) for (const proof of proofs) evidence.push({
    id: randomUUID(), proof, sha: sha(index, h), baseSha: base, policyRevision: 1, producer: 'proof-runner', trusted: true, result: h === HEADS_PER_ITEM && proof === 'e2e:gamma' && index % 2 ? 'fail' : 'pass',
    executed: 12, skipped: 0, at: new Date(now.getTime() - (HEADS_PER_ITEM - h) * 60_000).toISOString(), environment: 'node 24 on the proof runner',
    url: `https://ci.example/runs/${index}-${h}`, scopeFiles: Array.from({ length: 30 }, (_, file) => `src/module-${file}/component-${index}.ts`),
    artifacts: Array.from({ length: 4 }, (_, n) => ({ kind: 'report', label: `report ${n}`, mediaType: 'application/json', size: 20_000, digest: `sha256:${'d'.repeat(64)}`, availability: 'available', reference: { requestId: randomUUID(), artifactId: randomUUID() } })) as Evidence['artifacts'],
  });
  const work = {
    id, key, title: `Ledger item ${key}`, description: 'An item with the history a long-lived ledger accumulates. '.repeat(20), type: 'feature', priority: index % 3,
    dependencies: [], criteria: proofs.map((proof, n) => ({ id: `AC-${n + 1}`, text: `Criterion ${n + 1} of ${key}`, proofs: [proof] })),
    policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: ['src/server/', 'tests/'], stage, revision: 400, policyRevision: 1,
    createdAt: new Date(now.getTime() - 86_400_000).toISOString(), updatedAt: now.toISOString(), stageEnteredAt: now.toISOString(), ready: true, epoch: 2,
    lease: null, workspaces: [], implementers: ['worker-a'], submission: { epoch: 2, pr: index + 1 },
    candidate: { sha: head, baseSha: base, pr: index + 1, branch: `graphyard/gy-${index + 1}-2`, author: 'worker-a' },
    reworkRequested: false, scenarioRequirements: [], evidence, blocker: null,
    observation: { at: now.toISOString(), candidate: { sha: head, baseSha: base, pr: index + 1 }, files: ['src/server/index.ts', 'tests/example.test.ts'], checks: [{ name: 'test', conclusion: 'success' }], reviews: [], draft: false, prState: 'open', mergeable: true, baseTip: base, baseTipContained: true,
      scopeFiles: Array.from({ length: 200 }, (_, file) => ({ path: `src/generated/file-${file}.ts`, sha: 'e'.repeat(40), base: 'f'.repeat(40), status: 'unchanged' })) },
    gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: stage !== 'review', reasons: stage === 'review' ? ['Independent approval of the current commit is required'] : [] }],
    violations: [],
  } as unknown as Work;
  if (stage !== 'done') reconcileAutoDispatch(work, [work], now);
  // Every head before the current one left its resolved requests behind.
  const resolved: DispatchRequest[] = [];
  for (let h = 1; h < HEADS_PER_ITEM; h++) for (const kind of ['review', 'producer'] as const) resolved.push({
    id: randomUUID(), kind, sha: sha(index, h), baseSha: base, policyRevision: 1, pr: index + 1, requestedAt: now.toISOString(), reason: 'submitted head',
    state: 'cancelled', resolvedAt: now.toISOString(), resolution: 'head changed', ...(kind === 'producer' ? { group: 'integration', proofs: ['integration:alpha'] } : { provider: 'github' }),
  } as DispatchRequest);
  work.autoDispatch = { review: work.autoDispatch?.review ?? null, producers: work.autoDispatch?.producers ?? [], history: [...resolved, ...resolved, ...(work.autoDispatch?.history ?? [])] };
  return work;
}

before(async () => {
  const port = Number(process.env.GRAPHYARD_SNAPSHOT_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 23);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('snapshot-test'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_snapshot_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_snapshot_test`); await store.init();
  const now = new Date();
  for (let index = 0; index < ITEMS; index++) {
    const item = ledgerItem(index, now);
    await store.pool.query('INSERT INTO work_items(id,document) VALUES($1,$2)', [item.id, JSON.stringify(item)]);
    await store.pool.query('INSERT INTO jobs(work_id) VALUES($1)', [item.id]);
  }
  // Thousands of observations, each appending the whole document as save() does and rewriting
  // the row, so the tables carry the churn a live ledger does.
  await store.pool.query(`INSERT INTO events(work_id,actor,kind,payload) SELECT id,'github','github.observed',jsonb_build_object('work',document,'details',jsonb_build_object('observation',n)) FROM work_items, generate_series(1,$1::int) AS n`, [OBSERVATIONS_PER_ITEM]);
  for (let round = 0; round < 5; round++) await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{revision}',to_jsonb((document->>'revision')::int+1))");
  http = server(new Engine(store, [15368], 120, 'owner/project'), [{ id: 'coordinator', role: 'coordinator', token: coordinatorToken }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  directory = await temporaryDirectory('snapshot-master');
  const credentialFile = join(directory, 'coordinator.token'); await writeFile(credentialFile, coordinatorToken, { mode: 0o600 });
  config = masterConfigSchema.parse({ version: 1, url: origin, credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
});
after(async () => {
  if (hotHttp) await new Promise<void>(resolve => hotHttp.close(() => resolve()));
  if (hotStore) await hotStore.close();
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close(); if (database) await database.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function read(path: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${origin}/api/${path}`, { headers: { ...headers, Authorization: `Bearer ${coordinatorToken}` }, signal: AbortSignal.timeout(30_000) });
  const text = await response.text(); assert.equal(response.status, 200, text.slice(0, 500));
  return { body: JSON.parse(text), bytes: text.length };
}
// As the master loop asks for it: by header, so a server without the view still answers.
const snapshot = () => read('work-snapshot', { [coordinationViewHeader]: 'coordination' }).then(result => result.body as { work: Work[]; now: string });
// Steady state, not the runner: the first reads carry connection setup, JIT warmup and cold query
// plans, so they are taken and discarded; and the sample is large enough that five reads sit above
// the p95, so it is the percentile it names rather than the second-worst of twenty.
const WARMUP_READS = 5, LATENCY_SAMPLES = minimumSamples(0.95, 5), SNAPSHOT_BUDGET_MS = 2_000;

test('integration:work-snapshot-latency — the coordination snapshot of a 100-item ledger with thousands of github.observed events answers under 2 s p95, bounded, with every decision input intact', async () => {
  const events = Number((await store.pool.query("SELECT count(*) FROM events WHERE kind='github.observed'")).rows[0].count);
  assert.ok(events >= 4000, `the ledger carries ${events} github.observed events`);
  let compact: { body: any; bytes: number } | undefined;
  const { warmup, samples } = await steadyState(async () => { compact = await read('work-snapshot?view=coordination'); }, { warmup: WARMUP_READS, samples: LATENCY_SAMPLES });
  assert.equal(samples.length, 100);
  assertTiming({ name: 'work-snapshot-latency.p95', test: 'integration:work-snapshot-latency', statistic: 'p95', fraction: 0.95, budgetMs: SNAPSHOT_BUDGET_MS, samples, warmup });
  const full = await read('work-snapshot?view=full');
  const view = compact!.body;
  assert.equal(view.view, 'coordination'); assert.equal(view.work.length, ITEMS); assert.equal(view.jobs.length, ITEMS);
  // Bounded: history no longer grows with the ledger's age, and no event payload or per-file scope rides along.
  assert.ok(compact!.bytes * 3 < full.bytes, `coordination view ${compact!.bytes} bytes against the full ${full.bytes}`);
  assert.ok(view.omitted.evidence > 0 && view.omitted.dispatchHistory > 0);
  for (const item of view.work as Work[]) {
    assert.ok(item.autoDispatch!.history.length <= coordinationHistoryLimit);
    assert.equal((item.observation as any).scopeFiles, undefined); assert.deepEqual(item.observation!.files, ['src/server/index.ts', 'tests/example.test.ts']);
    for (const entry of item.evidence) { assert.equal(entry.artifacts, undefined); assert.equal(entry.scopeFiles, undefined); }
    assert.ok(item.evidence.length < HEADS_PER_ITEM * 3);
    assert.equal(JSON.stringify(item).includes('"payload"'), false);
  }
  // Nothing the master loop or the dispatcher decides on differs from the full documents.
  const now = new Date(view.now);
  for (const [index, item] of (view.work as Work[]).entries()) {
    const whole = full.body.work[index] as Work;
    assert.equal(item.id, whole.id);
    for (const field of ['stage', 'gates', 'violations', 'lease', 'candidate', 'submission', 'criteria', 'policyRevision', 'epoch', 'mergeAuthorization', 'delivery'] as const) assert.deepEqual(item[field], whole[field], `${item.key} ${field}`);
    assert.deepEqual({ review: item.autoDispatch!.review, producers: item.autoDispatch!.producers }, { review: whole.autoDispatch!.review, producers: whole.autoDispatch!.producers });
    assert.deepEqual(missingProofs(item, now), missingProofs(whole, now));
    assert.deepEqual(evidenceIndependenceRefusals(item, now), evidenceIndependenceRefusals(whole, now));
    for (const request of item.autoDispatch!.producers) for (const proof of request.proofs ?? [])
      assert.equal(proofOutcome(item, request, proof), proofOutcome(whole, request, proof));
  }
  // The header the CLI sends selects the same view.
  const byHeader = await read('work-snapshot', { [coordinationViewHeader]: 'coordination' });
  assert.equal(byHeader.body.view, 'coordination'); assert.equal(byHeader.bytes, compact!.bytes);
  // The full view stays available and unchanged for readers that want whole documents.
  assert.equal(full.body.view, undefined); assert.ok((full.body.work[0] as Work).evidence.length === HEADS_PER_ITEM * 3);
  const refused = await fetch(`${origin}/api/work-snapshot?view=everything`, { headers: { Authorization: `Bearer ${coordinatorToken}` } });
  assert.equal(refused.status, 400);
});

/** Every statement the store's pool runs while `run` does, with the rows each returned. */
async function spyQueries<T>(target: Store, run: () => Promise<T>) {
  const seen: { text: string; rows: any[] }[] = [];
  const record = (original: (...args: any[]) => any) => async (...args: any[]) => {
    const result = await original(...args);
    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
    seen.push({ text, rows: result?.rows ?? [] });
    return result;
  };
  const pool = target.pool as any;
  const query = pool.query, connect = pool.connect;
  pool.query = record(query.bind(pool));
  // The pool's own query() checks a client out through connect() with a callback; those
  // statements are already seen through the pool's query, so only checked-out clients are wrapped.
  const clients: [any, any][] = [];
  pool.connect = (...args: any[]) => {
    if (typeof args[0] === 'function') return connect.apply(pool, args);
    return connect.apply(pool, args).then((client: any) => { clients.push([client, client.query]); client.query = record(client.query.bind(client)); return client; });
  };
  try { return { result: await run(), seen }; }
  finally { pool.query = query; pool.connect = connect; for (const [client, own] of clients) client.query = own; }
}

test('integration:store-bounded-waits — the store pool bounds the wait for a connection and every statement, and the coordination snapshot is trimmed in SQL, never selecting a full action-queue history', async () => {
  // Both timeouts are set on the pool itself, so every client it hands out carries them — the
  // coordination lock wait included, since taking it is a statement.
  const options = (store.pool as any).options;
  assert.equal(options.connectionTimeoutMillis, storeConnectionTimeoutMs);
  assert.ok(storeConnectionTimeoutMs > 0 && storeConnectionTimeoutMs <= 30_000, 'a caller learns within its own timeout that no connection was free');
  assert.equal(options.statement_timeout, storeStatementTimeoutMs);
  assert.ok(storeStatementTimeoutMs > 0);
  const client = await store.pool.connect();
  try { assert.equal((await client.query('SHOW statement_timeout')).rows[0].statement_timeout, `${storeStatementTimeoutMs / 60_000}min`, 'the server enforces it on a pooled connection'); }
  finally { client.release(); }
  // A connection the pool cannot hand out fails with a reason instead of queueing forever.
  const tight = new Store(options.connectionString);
  (tight.pool as any).options.max = 1; (tight.pool as any).options.connectionTimeoutMillis = 200;
  const held = await tight.pool.connect();
  try { await assert.rejects(tight.pool.connect(), /timeout/i); } finally { held.release(); await tight.close(); }
  const statement = await store.pool.connect();
  try { await statement.query("SET statement_timeout = '100ms'"); await assert.rejects(statement.query('SELECT pg_sleep(1)'), /statement timeout/); }
  finally { await statement.query('RESET statement_timeout'); statement.release(); }

  // A long-lived item's action queue: far more resolved rows than the view keeps.
  const [first] = (await store.list());
  const history = Array.from({ length: 60 }, (_, n) => ({ id: `resolved-${n}`, kind: 'dispatch', work: first.id, key: first.key, state: 'done', history: Array.from({ length: 20 }, () => ({ at: new Date().toISOString(), event: 'failed', requester: 'graphyard', executor: 'executor-a', result: 'failed', reason: 'x'.repeat(400) })) }));
  // And evidence for heads it no longer has, which no open or recent request names: a coordinator
  // decision can never consult it, so it must not leave the database either.
  const superseded = 'dead'.padEnd(40, '0');
  const stale = Array.from({ length: 40 }, (_, n) => ({ ...first.evidence[0], id: randomUUID(), sha: superseded, url: `https://ci.example/superseded/${n}` }));
  await store.pool.query("UPDATE work_items SET document=jsonb_set(jsonb_set(document,'{actionQueue}',$2::jsonb),'{evidence}',(document->'evidence')||$3::jsonb) WHERE id=$1", [first.id, JSON.stringify({ actions: [], history }), JSON.stringify(stale)]);
  try {
    const { result, seen } = await spyQueries(store, () => read('work-snapshot', { [coordinationViewHeader]: 'coordination' }));
    const view = result.body;
    // What left the database: no statement selected whole documents, and no row it returned
    // carried an action-queue history longer than the view keeps.
    assert.ok(seen.length > 0, 'the read went through the store');
    for (const { text, rows } of seen) {
      assert.doesNotMatch(text, /jsonb_agg\(document\b|SELECT\s+document\s+FROM/i, `the coordination read selects no whole document: ${text.slice(0, 120)}`);
      for (const row of rows) for (const document of [row.document, ...(Array.isArray(row.work) ? row.work : [])]) {
        if (!document || typeof document !== 'object') continue;
        assert.ok((document.actionQueue?.history?.length ?? 0) <= coordinationHistoryLimit, 'the SQL trimmed the action-queue history before it left the database');
        assert.equal(document.pipeline, undefined);
        assert.equal(document.observation?.scopeFiles, undefined);
        assert.ok(!(document.evidence ?? []).some((entry: Evidence) => entry.sha === superseded), 'the SQL filtered superseded-head evidence before it left the database');
      }
    }
    const trimmed = (view.work as Work[]).find(item => item.id === first.id)!;
    assert.deepEqual(trimmed.actionQueue!.history.map(row => row.id), history.slice(-coordinationHistoryLimit).map(row => row.id), 'the most recent rows are the ones kept, in order');
    assert.ok(view.omitted.actionHistory >= history.length - coordinationHistoryLimit, 'and the view still says how many it left out');
    // The evidence kept is exactly what the view's own rule keeps from the whole document, and the
    // records the SQL dropped are still counted as left out.
    const full = (await read('work-snapshot?view=full')).body as { work: Work[] };
    const whole = full.work.find(item => item.id === first.id)!;
    assert.deepEqual(trimmed.evidence.map(entry => entry.id), coordinationWork(whole, { evidence: 0, dispatchHistory: 0, queueHistory: 0, actionHistory: 0, sessions: 0 }).evidence.map(entry => entry.id));
    assert.ok(trimmed.evidence.length > 0, 'the candidate\'s own evidence is kept');
    assert.equal(view.omitted.evidence, trimInProcess(full).omitted.evidence, 'the records the SQL dropped are counted as the in-process trim would count them');
    // The full view is untouched: it still carries every row.
    assert.equal(((await read('work-snapshot?view=full')).body.work as Work[]).find(item => item.id === first.id)!.actionQueue!.history.length, history.length);
  } finally {
    await store.pool.query("UPDATE work_items SET document=jsonb_set(document-'actionQueue','{evidence}',$2::jsonb) WHERE id=$1", [first.id, JSON.stringify(first.evidence)]);
  }
});

test('integration:dispatch-read-resilience — a dispatcher tick whose read times out or fails retries promptly with backoff, and master status reports the last successful tick and consecutive failures', async () => {
  const intervalMs = 60_000, stopping = new AbortController();
  const cursor: DispatchCursor = emptyDispatchCursor(config);
  const persisted: DispatchCursor[] = []; const log: string[] = [];
  let reads = 0;
  const effects: DispatchEffects = {
    snapshot: async () => {
      reads++;
      if (reads === 1) return new Promise<never>(() => {}); // a read that never answers
      if (reads === 2) throw new Error('fetch failed: connection reset');
      return snapshot();
    },
    agents: () => [],
    credentials: async () => ({}),
    reconcileReviews: async () => ({ reviews: [] }),
    reconcileProducers: async () => ({ producers: [] }),
    launchReview: async () => {}, launchProducer: async () => {},
    persist: async state => { persisted.push(structuredClone(state)); if (state.lastSuccessAt) stopping.abort(); },
  };
  // Generous above the two-second p95 the latency test bounds a real read at: a slow but
  // correct read must count as success, not as a failure that spins extra retries.
  const readTimeoutMs = 2_500, retryMinMs = 100;
  const started = performance.now();
  const run = await runAutoDispatch(config, cursor, effects, { intervalMs, signal: stopping.signal, log: line => log.push(line), readTimeoutMs, retryMinMs });
  const elapsed = performance.now() - started;
  // Two failures and a success, well inside one interval: nothing waited a whole interval to retry.
  assert.equal(reads, 3); assert.equal(run.ticks.length, 1);
  assertTiming({ name: 'dispatch-read-resilience.recovery', test: 'integration:dispatch-read-resilience', statistic: 'elapsed', budgetMs: Math.min(10_000, intervalMs), samples: [elapsed] });
  assert.match(log[0], new RegExp(`tick failed \\(1 in a row, retrying in 100ms\\): work snapshot read timed out after ${readTimeoutMs}ms`));
  assert.match(log[1], /tick failed \(2 in a row, retrying in 200ms\): fetch failed/);
  const failing = persisted.find(state => state.consecutiveFailures === 2)!;
  assert.ok(failing, 'the failure streak is persisted before the retry');
  const blind = dispatchSummary(failing, Date.now(), intervalMs);
  assert.equal(blind.lastSuccessAt, null); assert.equal(blind.consecutiveFailures, 2); assert.match(blind.lastFailure!.reason, /connection reset/); assert.equal(blind.running, false);
  const recovered = dispatchSummary(cursor, Date.now(), intervalMs);
  assert.equal(recovered.consecutiveFailures, 0); assert.ok(recovered.lastSuccessAt); assert.equal(recovered.running, true);
  assert.equal(recovered.lastFailure!.reason, failing.lastFailure!.reason, 'the last failure stays visible after recovery');
  // Backoff widens but never waits longer than the interval it replaces.
  assert.deepEqual([1, 2, 3, 4].map(failures => tickRetryDelay(failures, 10_000)), [1_000, 2_000, 4_000, 8_000]);
  assert.equal(tickRetryDelay(9, 10_000), 10_000);
});

test('integration:cycle-within-interval — a coordination cycle over the 100-item ledger completes within its configured interval, and master status records the measurement', async () => {
  const intervalMs = config.run.intervalSeconds * 1000;
  const state: DaemonState = emptyDaemonState(config);
  const effects: DaemonEffects = {
    agents: () => [],
    credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    snapshot,
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    persist: async () => {},
  };
  const result = await runDaemon(config, state, effects, { once: true, intervalMs, identity: { pid: process.pid, host: 'machine-a' }, signals: [], log: () => {} });
  assert.equal(result.cycles.length, 1);
  const [cycle] = state.metrics;
  assert.equal(cycle.open, (await snapshot()).work.filter(item => item.stage !== 'done').length, 'the cycle measured the whole ledger');
  assertTiming({ name: 'cycle-within-interval.duration', test: 'integration:cycle-within-interval', statistic: 'duration', comparison: '<=', budgetMs: intervalMs, samples: [cycle.durationMs] });
  const budget = cycleBudget(state, intervalMs);
  assert.deepEqual(budget.lastCycle, { cycle: cycle.cycle, at: cycle.at, durationMs: cycle.durationMs, childWaitMs: cycle.childWaitMs, workMs: cycle.workMs });
  assert.equal(cycle.childWaitMs, 0, 'a cycle that ran no child process waited on none'); assert.equal(cycle.workMs, cycle.durationMs);
  // The bound itself is the assertTiming above, which a loaded CI runner may pass inside its slack
  // (GY-1040); the report must then still say the cycle overran its interval, not that it fit.
  const overran = cycle.durationMs > intervalMs;
  assert.equal(budget.withinInterval, !overran); assert.equal(budget.overruns, overran ? 1 : 0); assert.equal(budget.measured, 1); assert.equal(budget.intervalMs, intervalMs);
  // A regression is visible: an overrunning cycle is counted and named.
  const slow = { ...cycle, cycle: cycle.cycle + 1, durationMs: intervalMs * 3 };
  const regressed = cycleBudget({ metrics: [...state.metrics, slow] }, intervalMs);
  assert.equal(regressed.withinInterval, false); assert.equal(regressed.overruns, (overran ? 1 : 0) + 1); assert.deepEqual(regressed.lastOverrun, { cycle: slow.cycle, at: slow.at, durationMs: slow.durationMs, childWaitMs: slow.childWaitMs, workMs: slow.workMs });
  assert.equal(regressed.p95Ms, slow.durationMs);
  assert.deepEqual(cycleBudget({ metrics: [] }, intervalMs), { intervalMs, measured: 0, lastCycle: null, withinInterval: null, p95Ms: null, overruns: 0, lastOverrun: null });
});

// GY-1376: the hot paths on a ledger whose settled deliveries dwarf its open work, as production's
// did (1,375 items, 20.7 MB): 1,000 settled deliveries, each carrying the histories a finished item
// keeps (every attempt, every finished session, superseded evidence and dispatch requests), and
// 10 open items. Every finished history entry carries `settled-history:<key>`, which only a settled
// item's whole document holds: the work index's summary of it drops those histories.
const HOT_SETTLED = 1_000, HOT_OPEN = 10, SETTLED_HISTORY = 80;
const settledMarker = /settled-history:(GY-S\d+)/g;
let hotStore: Store; let hotHttp: ReturnType<typeof server>; let hotOrigin: string;

function settledItem(index: number, now: Date): Work {
  const work = ledgerItem(index, now) as any, key = `GY-S${index + 1}`, at = new Date(now.getTime() - 3_600_000).toISOString();
  const history = (n: number) => `settled-history:${key} entry ${n}`;
  Object.assign(work, {
    key, stage: 'done', gates: work.gates.map((gate: any) => ({ ...gate, passed: true, reasons: [] })),
    delivery: { mergedAt: at, mergeSha: sha(index, 99), authorizationRevision: 400 },
    evidence: work.evidence.map((entry: any) => ({ ...entry, artifacts: [], scopeFiles: entry.scopeFiles.slice(0, 2) })),
    observation: { ...work.observation, merged: true, prState: 'closed', scopeFiles: work.observation.scopeFiles.slice(0, 10) },
    pipeline: { submittedAt: at, reworkRounds: 1, attempts: Array.from({ length: SETTLED_HISTORY }, (_, n) => ({ epoch: n + 1, owner: 'worker-a', claimedAt: at, endedAt: at, end: 'expired', note: history(n) })) },
    sessions: Array.from({ length: SETTLED_HISTORY }, (_, n) => ({ id: `worker-a:${n}`, kind: 'implementation', state: 'finished', startedAt: at, endedAt: at, updatedAt: at, outcome: history(n) })),
  });
  return work;
}
function openItem(index: number, now: Date): Work {
  const work = ledgerItem(index, now) as any;
  work.key = `GY-O${index + 1}`; work.stage = (['build', 'review', 'test', 'merge'] as const)[index % 4];
  return work;
}

// Seeded on the first hot-path test's demand, so the snapshot tests above never wait on it.
let seeded: Promise<void> | null = null;
const hotPaths = () => seeded ??= (async () => {
  await database.createDatabase('graphyard_hot_paths');
  watchResults((store.pool as any).Client);
  hotStore = new Store((store.pool as any).options.connectionString.replace(/graphyard_snapshot_test$/, 'graphyard_hot_paths')); await hotStore.init();
  const now = new Date();
  for (let index = 0; index < HOT_SETTLED; index++) { const item = settledItem(index, now); await hotStore.pool.query('INSERT INTO work_items(id,document) VALUES($1,$2)', [item.id, JSON.stringify(item)]); }
  for (let index = 0; index < HOT_OPEN; index++) {
    const item = openItem(index, now);
    await hotStore.pool.query('INSERT INTO work_items(id,document) VALUES($1,$2)', [item.id, JSON.stringify(item)]);
    await hotStore.pool.query('INSERT INTO jobs(work_id) VALUES($1)', [item.id]);
  }
  hotHttp = server(new Engine(hotStore, [15368], 120, 'owner/project'), [{ id: 'coordinator', role: 'coordinator', token: coordinatorToken }]);
  await new Promise<void>(resolve => hotHttp.listen(0, '127.0.0.1', resolve));
  hotOrigin = `http://127.0.0.1:${(hotHttp.address() as AddressInfo).port}`;
})();

async function hotRead(path: string) {
  const response = await fetch(`${hotOrigin}/api/${path}`, { headers: { Authorization: `Bearer ${coordinatorToken}` }, signal: AbortSignal.timeout(60_000) });
  const text = await response.text(); assert.equal(response.status, 200, text.slice(0, 500));
  return JSON.parse(text);
}
/** Where results go while `settledDocumentsRead` watches; null otherwise. */
let resultSink: ((result: any) => void) | null = null;
/**
 * Every result a pg client returns passes `resultSink`. Installed before the hot-path store opens
 * a connection: each connection binds `query` when the pool opens it (statements.ts), so a patch
 * made later would never see that connection's statements.
 */
function watchResults(Client: { prototype: any }) {
  const original = Client.prototype.query as (...args: any[]) => any;
  Client.prototype.query = function (this: unknown, ...args: any[]) {
    if (typeof args[0]?.submit === 'function') return original.apply(this, args);
    const callback = typeof args.at(-1) === 'function' ? args.pop() : null;
    const promise = original.apply(this, args).then((result: any) => { resultSink?.(result); return result; });
    if (!callback) return promise;
    promise.then((result: any) => callback(null, result), (error: unknown) => callback(error));
  };
}
/**
 * The settled documents `run` read, by key, and the bytes of the rows that carried them: every
 * result any pool's client returned while it ran is scanned for the marker only a settled item's
 * whole document holds, so a read of one shows up whichever path, pool or statement made it.
 */
async function settledDocumentsRead<T>(run: () => Promise<T>) {
  const keys = new Set<string>(); let bytes = 0;
  resultSink = result => {
    for (const each of [result].flat()) for (const row of each?.rows ?? []) {
      const text = JSON.stringify(row), found = [...text.matchAll(settledMarker)];
      for (const match of found) keys.add(match[1]);
      if (found.length) bytes += text.length;
    }
  };
  try { return { value: await run(), keys, bytes }; } finally { resultSink = null; }
}
/** One observation job run as the server's workers run it, against the real store: the claim order, the claim, and the landability publication with its peers. */
function observationWorker() {
  const peers: Work[][] = [];
  const engine = Object.assign(Object.create(new Engine(hotStore, [], 120, 'owner/project')), { observe: async (id: string) => (await hotStore.workItem(id))!, reconcileLanded: async () => {} });
  const github = {
    observe: async (work: Work) => work.observation!, publish: async () => {},
    publishLandable: async (_target: Work, fleet: Work[]) => { peers.push(fleet); return { skipped: true }; },
  };
  return { peers, run: () => processJob(engine, github as any) };
}
const flowDrilldownRead = () => { invalidateFlowReports(hotStore); return hotRead('analytics/flow/drilldown?window=30&metric=throughput'); };

test('integration:hot-paths-read-no-settled-documents — the observation claim, landability peers, /api/status, /api/board and lookups by id or key read no settled delivery\'s document; GET /api/work still answers whole documents', async () => {
  await hotPaths();
  assert.equal(Number((await hotStore.pool.query('SELECT count(*) FROM work_index WHERE settled')).rows[0].count), HOT_SETTLED, 'every seeded delivery is settled');
  // The control: the full list reads every settled document, and the scan sees each one.
  const full = await settledDocumentsRead(() => hotRead('work'));
  assert.equal(full.value.length, HOT_SETTLED + HOT_OPEN); assert.equal(full.keys.size, HOT_SETTLED, 'GET /api/work keeps its full-document contract');
  assert.ok(full.value.filter((item: Work) => item.stage === 'done').every((item: any) => item.pipeline.attempts.length === SETTLED_HISTORY));
  // The observation job: its claim order and the landability peers it publishes against.
  const worker = observationWorker();
  const job = await settledDocumentsRead(worker.run);
  assert.equal(job.value, true, 'an open item\'s job was claimed and run');
  assert.equal(worker.peers.length, 1, 'the landability verdict was published');
  assert.equal(worker.peers[0].length, HOT_SETTLED + HOT_OPEN, 'against the whole fleet, settled deliveries as their summaries');
  assert.deepEqual([...job.keys], [], `the observation job read settled documents: ${[...job.keys].slice(0, 5).join(', ')}`);
  for (const [name, path] of [['/api/status', 'status'], ['/api/board', 'board']] as const) {
    const read = await settledDocumentsRead(() => hotRead(path));
    assert.deepEqual([...read.keys], [], `${name} read ${read.keys.size} settled documents (${read.bytes} bytes)`);
  }
  // A lookup by key or id reads that one row: an open item's reads none of the settled documents,
  // a settled item's reads its own and no other.
  const open = full.value.find((item: Work) => item.stage !== 'done') as Work, settled = full.value.find((item: Work) => item.stage === 'done') as Work;
  for (const ref of [open.key, open.id]) assert.deepEqual([...(await settledDocumentsRead(() => hotStore.workDocument(ref))).keys], []);
  const one = await settledDocumentsRead(() => hotStore.workDocument(settled.key));
  assert.deepEqual([...one.keys], [settled.key]); assert.equal(one.value!.id, settled.id);
  assert.equal(await hotStore.workDocument('GY-404'), undefined);
});

// The bound: a fraction of what reading every document takes on the same store. Each path still
// reads every open document and the index's summary of each settled one, so it is not free; it
// must not grow with the settled items' histories.
const HOT_PATH_FRACTION = 0.5, HOT_PATH_SAMPLES = 9;
async function fullListMs() {
  const { samples } = await steadyState(() => hotStore.list(), { warmup: 1, samples: 3 });
  return [...samples].sort((a, b) => a - b)[1];
}

test('integration:drilldown-reads-no-settled-documents — a flow drill-down reads the window\'s items from the work index, never a settled delivery\'s document, and answers within a fraction of the full list\'s time', async () => {
  await hotPaths();
  for (const metric of ['throughput', 'lead-time', 'steps', 'wip']) {
    invalidateFlowReports(hotStore);
    const read = await settledDocumentsRead(() => hotRead(`analytics/flow/drilldown?window=30&metric=${metric}`));
    assert.equal(read.value.metric, metric);
    assert.deepEqual([...read.keys], [], `the ${metric} drill-down read ${read.keys.size} settled documents (${read.bytes} bytes)`);
  }
  // The report the drill-downs share a dataset with reads the same way.
  invalidateFlowReports(hotStore);
  assert.deepEqual([...(await settledDocumentsRead(() => hotRead('analytics/flow?window=30'))).keys], []);
  // And it answers within a fraction of the full list's time on the same store, each sample a fresh read.
  const listMs = await fullListMs();
  const { warmup, samples } = await steadyState(flowDrilldownRead, { warmup: 2, samples: HOT_PATH_SAMPLES });
  assertTiming({ name: 'drilldown-reads-no-settled-documents.latency', test: 'integration:drilldown-reads-no-settled-documents', statistic: 'median', fraction: 0.5, budgetMs: Math.round(listMs * HOT_PATH_FRACTION), samples, warmup });
});

test('integration:hot-path-latency-bounded — an observation job claim, GET /api/status and GET /api/board each answer within a fraction of the full list\'s time on the same store', async () => {
  await hotPaths();
  const listMs = await fullListMs(), budgetMs = Math.round(listMs * HOT_PATH_FRACTION);
  // The claim alone: the fleet read its order is computed from, and the claim it orders. No job is
  // due, so each sample is the claim every observation worker makes, not what one job then does.
  await hotStore.pool.query("UPDATE jobs SET available_at = clock_timestamp() + interval '1 hour'");
  const claim = async () => assert.equal(await observationWorker().run(), false, 'no job was due to claim');
  for (const [name, read] of [['observation-claim', claim], ['status', () => hotRead('status')], ['board', () => hotRead('board')]] as const) {
    const { warmup, samples } = await steadyState(read, { warmup: 2, samples: HOT_PATH_SAMPLES });
    assertTiming({ name: `hot-path-latency-bounded.${name}`, test: 'integration:hot-path-latency-bounded', statistic: 'median', fraction: 0.5, budgetMs, samples, warmup });
  }
  await hotStore.pool.query('UPDATE jobs SET available_at = clock_timestamp()');
});
