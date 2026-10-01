import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { flowReportCoalesceMs, invalidateFlowReports, flowReportFreshMs, flowReportKey, pooledFlowReport, type FlowWindow } from '../src/flow-analytics.js';
import type { Principal } from '../src/model.js';

// GY-705: GET /api/analytics/flow answers from the report pool — the computed report per window
// and filter set, for up to a minute — with fact changes coalesced for ten seconds; deployments invalidate immediately.

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'worker-a', role: 'worker' };
const producer: Principal = { id: 'deployer', role: 'producer' };
const tokens = { operator: 'o'.repeat(32), producer: 'p'.repeat(32) };

let database: EmbeddedPostgres; let store: Store; let engine: Engine;
let http: ReturnType<typeof server>; let url: string;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 711;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('flow-cache'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
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

test('unit:flow-report-cached — a second read of the same window is served from the report pool in under 100 ms, and new step events coalesce', async t => {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  t.after(() => { Date.now = realNow; invalidateFlowReports(store); });
  for (let index = 0; index < 30; index++) await item(index, index % 2 === 0);
  const first = await flow();
  assert.equal(first.body.coverage.workItems, 30);
  const second = await flow();
  assert.ok(second.ms < 200, `the cached read took ${second.ms.toFixed(1)} ms`);
  assert.equal(second.body.bottleneck.observedAt, first.body.bottleneck.observedAt, 'the second read is the pooled report');
  assert.deepEqual(second.body, first.body);

  // Each window and filter set has its own report.
  const wider = await flow('window=30');
  assert.notEqual(wider.body.bottleneck.observedAt, first.body.bottleneck.observedAt);
  const filtered = await flow('window=7&stage=build');
  assert.notEqual(filtered.body.bottleneck.observedAt, first.body.bottleneck.observedAt);
  assert.equal((await flow()).body.bottleneck.observedAt, first.body.bottleneck.observedAt, 'other windows leave the pooled 7-day report in place');

  // A new step event shares the existing report until the coalescing boundary.
  await item(30, true);
  assert.deepEqual((await flow()).body, first.body);
  clock += flowReportCoalesceMs;
  const moved = await flow();
  assert.notEqual(moved.body.bottleneck.observedAt, first.body.bottleneck.observedAt, 'the step event recomputed the report');
  assert.equal(moved.body.coverage.workItems, 31);
  // Claims are flow facts too, and obey the same bounded coalescing interval.
  const claimable = await item(31, false);
  clock += flowReportCoalesceMs;
  const released = await flow();
  await engine.execute(worker, 'claim', claimable.id, {}, randomUUID());
  assert.deepEqual((await flow()).body, released.body);
  clock += flowReportCoalesceMs;
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
  finally { Date.now = now; invalidateFlowReports(store); }
  assert.equal(flowReportFreshMs, 60_000);
  const key = flowReportKey(query);
  for (const other of [{ days: 30 as FlowWindow }, { ...query, type: 'bug' }, { ...query, stage: 'review' }, { ...query, slice: 'slice-1' }, { ...query, asOf: new Date().toISOString() }, { ...query, productionEnvironment: 'staging' },
    { ...query, production: { observedAt: new Date().toISOString(), serving: 'e'.repeat(40), pending: ['GY-1'], incidents: [], error: null } }])
    assert.notEqual(flowReportKey(other), key, JSON.stringify(other));
  // The drill-down and export parameters read the same report.
  assert.equal(flowReportKey({ ...query, metric: 'steps', key: 'x' } as any), key);
});

test('busy 250-item flow coalesces continuing facts into fast reads and refreshes at the boundary', async t => {
  const existing = Number((await store.pool.query('SELECT count(*) AS count FROM work_items')).rows[0].count);
  for (let index = existing; index < 250; index++) await item(index, false);
  invalidateFlowReports(store);
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  t.after(() => { Date.now = realNow; invalidateFlowReports(store); });
  const cold = await flow();
  assert.equal(cold.body.coverage.workItems, 250);
  t.diagnostic(`250-item cold read: ${cold.ms.toFixed(1)} ms`);
  for (let index = 0; index < 4; index++) {
    clock += 2_000;
    await item(250 + index, false);
    const warm = await flow();
    assert.deepEqual(warm.body, cold.body, 'continuing facts reuse the bounded snapshot');
    assert.ok(warm.ms < 1_500, `busy cached read took ${warm.ms.toFixed(1)} ms`);
  }
  clock += 2_000;
  const refreshed = await flow();
  assert.equal(refreshed.body.coverage.workItems, 254, 'all coalesced changes appear at ten seconds');
  assert.notEqual(refreshed.body.bottleneck.observedAt, cold.body.bottleneck.observedAt);
});
