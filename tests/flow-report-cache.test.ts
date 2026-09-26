import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { flowReportFreshMs, flowReportKey, pooledFlowReport, type FlowWindow } from '../src/flow-analytics.js';
import type { Principal } from '../src/model.js';

// GY-705: GET /api/analytics/flow answers from the report pool — the computed report per window
// and filter set, for up to a minute — and a new step event recomputes it at once.

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'worker-a', role: 'worker' };
const producer: Principal = { id: 'deployer', role: 'producer' };
const tokens = { operator: 'o'.repeat(32), producer: 'p'.repeat(32) };

let database: EmbeddedPostgres; let store: Store; let engine: Engine;
let http: ReturnType<typeof server>; let url: string;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 711;
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-flow-cache-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_flow_cache');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_flow_cache`);
  await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  http = server(engine, [{ ...operator, token: tokens.operator }, { ...producer, token: tokens.producer }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => {
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
  if (database) await database.stop();
});

async function item(index: number, claimed: boolean) {
  let work = await engine.execute(operator, 'create', null, {
    title: `Cached flow item ${index}`, plannedFiles: [`slice-${index % 3}/`],
    criteria: [{ id: 'AC-1', text: 'Observable delivery behavior', proofs: ['integration:flow'] }],
  }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  if (claimed) work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  return work;
}
async function flow(query = 'window=7') {
  const started = performance.now();
  const response = await fetch(`${url}/api/analytics/flow?${query}`, { headers: { Authorization: `Bearer ${tokens.operator}` } });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return { body, ms: performance.now() - started };
}

test('unit:flow-report-cached — a second read of the same window is served from the report pool in under 100 ms, and a new step event invalidates it', async () => {
  for (let index = 0; index < 30; index++) await item(index, index % 2 === 0);
  const first = await flow();
  assert.equal(first.body.coverage.workItems, 30);
  const second = await flow();
  assert.ok(second.ms < 100, `the cached read took ${second.ms.toFixed(1)} ms`);
  assert.equal(second.body.bottleneck.observedAt, first.body.bottleneck.observedAt, 'the second read is the pooled report');
  assert.deepEqual(second.body, first.body);

  // Each window and filter set has its own report.
  const wider = await flow('window=30');
  assert.notEqual(wider.body.bottleneck.observedAt, first.body.bottleneck.observedAt);
  const filtered = await flow('window=7&stage=build');
  assert.notEqual(filtered.body.bottleneck.observedAt, first.body.bottleneck.observedAt);
  assert.equal((await flow()).body.bottleneck.observedAt, first.body.bottleneck.observedAt, 'other windows leave the pooled 7-day report in place');

  // A new step event — an item released and claimed — is in the very next read.
  await item(30, true);
  const moved = await flow();
  assert.notEqual(moved.body.bottleneck.observedAt, first.body.bottleneck.observedAt, 'the step event recomputed the report');
  assert.equal(moved.body.coverage.workItems, 31);
  // A claim moves no step of its own but is a flow fact too; any new fact recomputes.
  const claimable = await item(31, false);
  const released = await flow();
  await engine.execute(worker, 'claim', claimable.id, {}, randomUUID());
  assert.notEqual((await flow()).body.bottleneck.observedAt, released.body.bottleneck.observedAt);

  // A recorded deployment moves merged items to Live without a flow fact, so it invalidates the pool too.
  const before = (await flow()).body.bottleneck.observedAt;
  const sha = 'd'.repeat(40);
  const deployed = await fetch(`${url}/api/deployments`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.producer}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ provider: 'railway', externalId: 'cache-deploy-1', environment: 'production', sha, containedMergeShas: [sha], state: 'succeeded', startedAt: new Date().toISOString() }) });
  assert.equal(deployed.status, 200);
  assert.notEqual((await flow()).body.bottleneck.observedAt, before);
});

test('unit:flow-report-cached — a pooled report is served for at most its freshness, and the pool keys every filter and the production hold', async () => {
  const query = { days: 7 as FlowWindow };
  const first = await pooledFlowReport(store, query);
  assert.equal((await pooledFlowReport(store, query)).report.bottleneck.observedAt, first.report.bottleneck.observedAt);
  const now = Date.now;
  Date.now = () => now() + flowReportFreshMs + 1;
  try { assert.notEqual((await pooledFlowReport(store, query)).report.bottleneck.observedAt, first.report.bottleneck.observedAt, 'a report older than a minute is recomputed'); }
  finally { Date.now = now; }
  assert.equal(flowReportFreshMs, 60_000);
  const key = flowReportKey(query);
  for (const other of [{ days: 30 as FlowWindow }, { ...query, type: 'bug' }, { ...query, stage: 'review' }, { ...query, slice: 'slice-1' }, { ...query, asOf: new Date().toISOString() }, { ...query, productionEnvironment: 'staging' },
    { ...query, production: { observedAt: new Date().toISOString(), serving: 'e'.repeat(40), pending: ['GY-1'], incidents: [], error: null } }])
    assert.notEqual(flowReportKey(other), key, JSON.stringify(other));
  // The drill-down and export parameters read the same report.
  assert.equal(flowReportKey({ ...query, metric: 'steps', key: 'x' } as any), key);
});
