import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import { Store, storeConnectionTimeoutMs, storeStatementTimeoutMs } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { evidenceIndependenceRefusals, type Evidence, type Work } from '../src/model.js';
import { reconcileAutoDispatch, type DispatchRequest } from '../src/model/dispatch.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, missingProofs, runDaemon, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { dispatchSummary, emptyDispatchCursor, runAutoDispatch, tickRetryDelay, type DispatchCursor, type DispatchEffects } from '../src/auto-dispatch.js';
import { proofOutcome } from '../src/producer.js';
import { coordinationHistoryLimit, coordinationViewHeader } from '../src/server/work-view.js';
import { cycleBudget } from '../src/cli/master.js';
import { assertTiming, minimumSamples, steadyState } from './helpers/timing.js';

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
    queueHistory: Array.from({ length: 40 }, (_, n) => ({ at: now.toISOString(), event: 'placed', sequence: n })),
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
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-snapshot-test-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
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
  directory = await mkdtemp(join(tmpdir(), 'graphyard-snapshot-master-'));
  const credentialFile = join(directory, 'coordinator.token'); await writeFile(credentialFile, coordinatorToken, { mode: 0o600 });
  config = masterConfigSchema.parse({ version: 1, url: origin, credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
});
after(async () => {
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
  const full = await read('work-snapshot');
  const view = compact!.body;
  assert.equal(view.view, 'coordination'); assert.equal(view.work.length, ITEMS); assert.equal(view.jobs.length, ITEMS);
  // Bounded: history no longer grows with the ledger's age, and no event payload or per-file scope rides along.
  assert.ok(compact!.bytes * 3 < full.bytes, `coordination view ${compact!.bytes} bytes against the full ${full.bytes}`);
  assert.ok(view.omitted.evidence > 0 && view.omitted.dispatchHistory > 0 && view.omitted.queueHistory > 0);
  for (const item of view.work as Work[]) {
    assert.ok(item.autoDispatch!.history.length <= coordinationHistoryLimit);
    assert.ok((item.queueHistory ?? []).length <= coordinationHistoryLimit);
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
    for (const field of ['stage', 'gates', 'violations', 'lease', 'candidate', 'submission', 'criteria', 'policyRevision', 'epoch', 'mergeAuthorization', 'queue', 'delivery'] as const) assert.deepEqual(item[field], whole[field], `${item.key} ${field}`);
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
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{actionQueue}',$2::jsonb) WHERE id=$1", [first.id, JSON.stringify({ actions: [], history })]);
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
      }
    }
    const trimmed = (view.work as Work[]).find(item => item.id === first.id)!;
    assert.deepEqual(trimmed.actionQueue!.history.map(row => row.id), history.slice(-coordinationHistoryLimit).map(row => row.id), 'the most recent rows are the ones kept, in order');
    assert.ok(view.omitted.actionHistory >= history.length - coordinationHistoryLimit, 'and the view still says how many it left out');
    // The full view is untouched: it still carries every row.
    assert.equal(((await read('work-snapshot')).body.work as Work[]).find(item => item.id === first.id)!.actionQueue!.history.length, history.length);
  } finally {
    await store.pool.query("UPDATE work_items SET document=document-'actionQueue' WHERE id=$1", [first.id]);
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
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({ result: 'merge requested' }),
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
  assert.equal(budget.withinInterval, true); assert.equal(budget.overruns, 0); assert.equal(budget.measured, 1); assert.equal(budget.intervalMs, intervalMs);
  // A regression is visible: an overrunning cycle is counted and named.
  const slow = { ...cycle, cycle: cycle.cycle + 1, durationMs: intervalMs * 3 };
  const regressed = cycleBudget({ metrics: [...state.metrics, slow] }, intervalMs);
  assert.equal(regressed.withinInterval, false); assert.equal(regressed.overruns, 1); assert.deepEqual(regressed.lastOverrun, { cycle: slow.cycle, at: slow.at, durationMs: slow.durationMs, childWaitMs: slow.childWaitMs, workMs: slow.workMs });
  assert.equal(regressed.p95Ms, slow.durationMs);
  assert.deepEqual(cycleBudget({ metrics: [] }, intervalMs), { intervalMs, measured: 0, lastCycle: null, withinInterval: null, p95Ms: null, overruns: 0, lastOverrun: null });
});
