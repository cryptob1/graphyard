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
import type { Principal, Work, Observation } from '../src/model.js';
import { defineScenario, scenarios } from '../src/scenarios.js';

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'agent-a', role: 'worker' };
const other: Principal = { id: 'agent-b', role: 'worker' };
const producer: Principal = { id: 'ci-runner', role: 'producer', proofs: ['integration:claim-safety'] };
const head = 'a'.repeat(40), base = 'b'.repeat(40);
let database: EmbeddedPostgres; let store: Store; let engine: Engine;
let http: ReturnType<typeof server>; let url: string;
const workInput = { title: 'Claims are exclusive', criteria: [{ id: 'AC-1', text: 'Only one agent claims the work', proofs: ['integration:claim-safety'] }] };
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-test-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init(); engine = new Engine(store);
  http = server(engine, [{ ...operator, token: 'o'.repeat(32) }, { ...worker, token: 'w'.repeat(32) }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); });
async function create(dependencies: string[] = []) { return engine.execute(operator, 'create', null, { ...workInput, dependencies }, randomUUID()); }
async function ready() { const w = await create(); return engine.execute(operator, 'ready', w.id, {}, randomUUID()); }
async function claimed() { const w = await ready(); return engine.execute(worker, 'claim', w.id, {}, randomUUID()); }
async function submitted() {
  let w = await claimed();
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'machine-a', path: `/tmp/${w.id}`, branch: `graphyard/${w.id}` }, randomUUID());
  return engine.execute(worker, 'submit', w.id, { epoch: 1, pr: Number(w.key.slice(3)) }, randomUUID());
}
function observation(w: Work): Observation {
  return { candidate: { sha: head, baseSha: base, pr: w.submission!.pr, branch: w.workspaces[0].branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews: [{ reviewer: 'reviewer', sha: head, state: 'APPROVED' }], protected: true, mergeable: true,
    merged: false, mergeSha: null, files: ['src/claims.ts'], at: new Date().toISOString() };
}
function proof() { return { proof: 'integration:claim-safety', sha: head, baseSha: base, policyRevision: 1, result: 'pass', executed: 12, skipped: 0 }; }

test('32 racing agents across independent connection pools acquire exactly one lease', async () => {
  const work = await ready(); const second = new Store(store.pool.options.connectionString!); const replica = new Engine(second);
  try {
    const attempts = await Promise.allSettled(Array.from({ length: 32 }, (_, i) => (i % 2 ? replica : engine).execute({ id: `agent-${i}`, role: 'worker' }, 'claim', work.id, {}, randomUUID())));
    assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await store.events(work.id)).filter(e => e.kind === 'claim').length, 1);
  } finally { await second.close(); }
});
test('idempotent retries have one event, and key reuse with different input fails', async () => {
  const work = await ready(); const key = randomUUID();
  const results = await Promise.all(Array.from({ length: 6 }, () => engine.execute(worker, 'claim', work.id, {}, key)));
  assert.ok(results.every(w => w.epoch === 1));
  assert.equal((await store.events(work.id)).filter(e => e.kind === 'claim').length, 1);
  await assert.rejects(engine.execute(worker, 'release', work.id, { epoch: 1 }, key), /reused/);
});
test('expired lease is recoverable and all stale-owner commands are fenced', async () => {
  let w = await claimed();
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{lease,expiresAt}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=$1", [w.id]);
  await engine.reconcile();
  w = await engine.execute(other, 'claim', w.id, {}, randomUUID()); assert.equal(w.epoch, 2);
  for (const command of ['heartbeat', 'release'] as const) await assert.rejects(engine.execute(worker, command, w.id, { epoch: 1 }, randomUUID()), /superseded/);
  await assert.rejects(engine.execute(worker, 'submit', w.id, { epoch: 1, pr: 33 }, randomUUID()), /superseded/);
});
test('dependencies and explicit blockers refuse claims', async () => {
  const parent = await create(); let child = await create([parent.id]); child = await engine.execute(operator, 'ready', child.id, {}, randomUUID());
  await assert.rejects(engine.execute(worker, 'claim', child.id, {}, randomUUID()), /dependencies/);
  const w = await claimed(); await engine.execute(worker, 'blocked', w.id, { epoch: 1, reason: 'Need API contract' }, randomUUID());
  await engine.execute(worker, 'release', w.id, { epoch: 1 }, randomUUID());
  await assert.rejects(engine.execute(other, 'claim', w.id, {}, randomUUID()), /blocker/);
});
test('workspace reservations are exclusive across tasks and machines', async () => {
  const a = await claimed(), b = await claimed();
  const ws = { epoch: 1, host: 'host-unique', path: '/tmp/shared', branch: 'graphyard/shared' };
  await engine.execute(worker, 'workspace', a.id, ws, randomUUID());
  await assert.rejects(engine.execute(worker, 'workspace', b.id, { ...ws, host: 'other-host' }, randomUUID()), /reserved/);
  await assert.rejects(engine.execute(worker, 'workspace', b.id, { ...ws, branch: 'graphyard/other' }, randomUUID()), /reserved/);
  await engine.execute(worker, 'workspace', b.id, { ...ws, host: 'other-host', branch: 'graphyard/other' }, randomUUID());
});
test('operator can unblock abandoned work with an auditable reason', async () => {
  const w = await claimed();
  await engine.execute(worker, 'blocked', w.id, { epoch: 1, reason: 'Contract missing' }, randomUUID());
  await engine.execute(worker, 'release', w.id, { epoch: 1 }, randomUUID());
  await assert.rejects(engine.execute(other, 'unblock', w.id, { reason: 'Ignore it' }, randomUUID()), /permission/);
  await engine.execute(operator, 'unblock', w.id, { reason: 'Contract independently confirmed' }, randomUUID());
  const result = await engine.execute(other, 'claim', w.id, {}, randomUUID()); assert.equal(result.epoch, 2);
  assert.equal((await store.events(w.id)).find(e => e.kind === 'unblock').payload.details.reason, 'Contract independently confirmed');
});
test('operator-mediated rework fences old ownership, closes build gate, and preserves PR attribution', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID()); assert.ok(w.gates.every(g => g.passed));
  await assert.rejects(engine.execute(worker, 'rework', w.id, { reason: 'Retry', previousWorkerStopped: true }, randomUUID()), /permission/);
  w = await engine.execute(operator, 'rework', w.id, { reason: 'Old process stopped; reproduce new failure', previousWorkerStopped: true }, randomUUID());
  assert.equal(w.stage, 'build'); assert.equal(w.lease, null);
  await assert.rejects(engine.execute(worker, 'heartbeat', w.id, { epoch: 1 }, randomUUID()), /superseded/);
  w = await engine.execute(other, 'claim', w.id, {}, randomUUID()); assert.equal(w.epoch, 2);
  w = await engine.execute(other, 'workspace', w.id, { epoch: 2, host: 'replacement-host', path: `/tmp/${w.id}-rework`, branch: w.workspaces[0].branch }, randomUUID());
  w = await engine.execute(other, 'submit', w.id, { epoch: 2, pr: w.submission!.pr }, randomUUID());
  assert.equal(w.reworkRequested, false); assert.equal(w.submission!.epoch, 2); assert.equal(w.workspaces.length, 2);
});
test('worker cannot self-certify CI, change policy, or mark done', async () => {
  const w = await ready(); await assert.rejects(engine.execute(worker, 'create', null, workInput, randomUUID()), /permission/);
  await assert.rejects(engine.execute(worker, 'evidence', w.id, { ...proof(), trusted: true }, randomUUID()));
  await assert.rejects(engine.execute(worker, 'done' as any, w.id, {}, randomUUID()), /Unknown/);
  await assert.rejects(engine.execute(worker, 'ready', w.id, {}, randomUUID()), /permission/);
});
test('assertions, skipped suites, zero executed, stale base, stale head, and stale policy never satisfy acceptance', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w)); assert.equal(w.stage, 'acceptance');
  w = await engine.execute(worker, 'evidence', w.id, proof(), randomUUID()); assert.equal(w.stage, 'acceptance');
  for (const override of [{ skipped: 1 }, { executed: 0 }, { sha: 'c'.repeat(40) }, { baseSha: 'd'.repeat(40) }, { policyRevision: 2 }, { result: 'fail' }]) {
    w = await engine.execute(producer, 'evidence', w.id, { ...proof(), ...override }, randomUUID()); assert.equal(w.stage, 'acceptance');
  }
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID()); assert.equal(w.stage, 'merge');
  const obs = observation(w); obs.candidate.sha = 'f'.repeat(40); obs.reviews[0].sha = obs.candidate.sha;
  w = await engine.observe(w.id, w.revision, obs); assert.equal(w.stage, 'acceptance');
});
test('latest failed evidence supersedes previous passing evidence', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID()); assert.equal(w.stage, 'merge');
  w = await engine.execute(producer, 'evidence', w.id, { ...proof(), result: 'fail' }, randomUUID()); assert.equal(w.stage, 'acceptance');
});
test('wrong CI producer, self review, and missing protection fail closed', async () => {
  let w = await submitted(); let obs = observation(w); obs.reviews[0].reviewer = obs.candidate.author;
  w = await engine.observe(w.id, w.revision, obs); assert.equal(w.stage, 'review');
  obs = observation(w); obs.checks[0].appId = 999; w = await engine.observe(w.id, w.revision, obs); assert.equal(w.stage, 'test');
  obs = observation(w); obs.protected = false; w = await engine.observe(w.id, w.revision, obs);
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID()); assert.equal(w.stage, 'merge'); assert.equal(w.gates.find(g => g.name === 'merge')!.passed, false);
});
test('only an independently observed merge with all gates satisfied completes work', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID()); assert.equal(w.stage, 'merge');
  w = await engine.observe(w.id, w.revision, { ...observation(w), merged: true, mergeSha: 'e'.repeat(40) }); assert.equal(w.stage, 'done');
  await assert.rejects(engine.execute(worker, 'claim', w.id, {}, randomUUID()), /immutable/);
});
test('bypassed merge is a permanent visible violation, not done', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, { ...observation(w), merged: true });
  assert.notEqual(w.stage, 'done'); assert.ok(w.violations.length);
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID()); assert.notEqual(w.stage, 'done');
});
test('delayed external observations cannot overwrite concurrent decisions', async () => {
  const w = await submitted(); await engine.execute(worker, 'evidence', w.id, proof(), randomUUID());
  await assert.rejects(engine.observe(w.id, w.revision, observation(w)), /changed/);
});
test('outbox job leases prevent duplicate ownership and stale acknowledgments', async () => {
  const jobs = await Promise.all([store.takeJob(), store.takeJob()]); assert.notEqual(jobs[0]?.work_id, jobs[1]?.work_id);
  const job = jobs[0]!; await store.finishJob(job.work_id, randomUUID());
  const row = (await store.pool.query('SELECT token FROM jobs WHERE work_id=$1', [job.work_id])).rows[0]; assert.equal(row.token, job.token);
  await store.finishJob(job.work_id, job.token);
});
test('event history survives reconnection and rejects update/delete', async () => {
  const w = await create(); const second = new Store(store.pool.options.connectionString!);
  try { assert.equal((await second.events(w.id)).length, 1); } finally { await second.close(); }
  await assert.rejects(store.pool.query('DELETE FROM events WHERE work_id=$1', [w.id]), /append-only/);
  await assert.rejects(store.pool.query("UPDATE events SET kind='forged' WHERE work_id=$1", [w.id]), /append-only/);
});
test('HTTP API authenticates, validates, and preserves command idempotency', async () => {
  assert.equal((await fetch(`${url}/api/work`)).status, 401);
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
  const headers = { Authorization: `Bearer ${'o'.repeat(32)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() };
  const send = () => fetch(`${url}/api/work`, { method: 'POST', headers, body: JSON.stringify(workInput) });
  const a: any = await (await send()).json(), b: any = await (await send()).json(); assert.equal(a.id, b.id);
  assert.equal((await fetch(`${url}/api/work`, { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(`${url}/api/events?work=invalid`, { headers })).status, 400);
});
test('E2E definitions are versioned, immutable, operator-owned, and pinned by work', async () => {
  const definition = { id: 'booking-sms', title: 'One booking SMS', purpose: 'Prevent duplicate confirmations', steps: ['Confirm booking twice'], expected: ['One SMS'], environment: 'staging', runner: 'Playwright', testPath: 'tests/booking.spec.ts', expectedRevision: 0 };
  await assert.rejects(defineScenario(store, worker, definition, randomUUID()), /permission/);
  const definitionKey = randomUUID();
  const first = await defineScenario(store, operator, definition, definitionKey);
  assert.equal((await defineScenario(store, operator, definition, definitionKey)).revision, 1);
  let w = await engine.execute(operator, 'create', null, { title: 'Booking SMS', criteria: [{ id: 'AC-1', text: 'One SMS', proofs: ['e2e:booking-sms'] }] }, randomUUID());
  assert.equal(w.scenarioRequirements[0].revision, 1);
  const second = await defineScenario(store, operator, { ...definition, expectedRevision: 1, expected: ['One SMS with correct time'] }, randomUUID());
  assert.equal(second.revision, 2); assert.notEqual(first.hash, second.hash);
  assert.equal((await scenarios(store)).filter(s => s.id === definition.id).length, 2);
  assert.equal((await store.list()).find(x => x.id === w.id)!.scenarioRequirements[0].revision, 1);
  await assert.rejects(defineScenario(store, operator, { ...definition, expectedRevision: 1 }, randomUUID()), /changed/);
  await assert.rejects(store.pool.query('DELETE FROM scenarios WHERE id=$1', [definition.id]), /append-only/);
  w = await engine.execute(operator, 'ready', w.id, {}, randomUUID());
  w = await engine.execute(worker, 'claim', w.id, {}, randomUUID());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'e2e-host', path: `/tmp/${w.id}`, branch: `graphyard/${w.id}` }, randomUUID());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: Number(w.key.slice(3)) }, randomUUID());
  w = await engine.observe(w.id, w.revision, observation(w));
  const reporter: Principal = { id: 'e2e-reporter', role: 'producer', proofs: ['e2e:booking-sms'] };
  for (const binding of [{}, { scenarioRevision: 2, environment: 'staging' }, { scenarioRevision: 1, environment: 'production' }]) {
    w = await engine.execute(reporter, 'evidence', w.id, { ...proof(), proof: 'e2e:booking-sms', ...binding }, randomUUID()); assert.equal(w.stage, 'acceptance');
  }
  w = await engine.execute(reporter, 'evidence', w.id, { ...proof(), proof: 'e2e:booking-sms', scenarioRevision: 1, environment: 'staging' }, randomUUID()); assert.equal(w.stage, 'merge');
});
test('unknown E2E scenarios are refused rather than silently accepting undefined proof', async () => {
  await assert.rejects(engine.execute(operator, 'create', null, { title: 'Undefined test', criteria: [{ id: 'AC-1', text: 'Must work', proofs: ['e2e:undefined-case'] }] }, randomUUID()), /Register E2E scenario/);
});
