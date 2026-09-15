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
import { ReconciliationRetry, type Principal, type Work, type Observation } from '../src/model.js';
import { defineScenario, scenarios } from '../src/scenarios.js';
import { setTimeout as delay } from 'node:timers/promises';
import { processJob, type GitHub } from '../src/github.js';
// @ts-expect-error The trusted runner intentionally uses dependency-free JavaScript outside the candidate source.
import { exercise } from '../scripts/acceptance-contract.mjs';

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'agent-a', role: 'worker', displayName: 'Atlas', runtime: 'Codex' };
const other: Principal = { id: 'agent-b', role: 'worker' };
const coordinator: Principal = { id: 'master', role: 'coordinator' };
const producer: Principal = { id: 'ci-runner', role: 'producer', proofs: ['integration:claim-safety'] };
const head = 'a'.repeat(40), base = 'b'.repeat(40);
const probeWorkers = Array.from({ length: 32 }, (_, i) => ({ id: `probe-worker-${i}`, role: 'worker' as const, token: `test-probe-${i}-${'x'.repeat(32)}` }));
let database: EmbeddedPostgres; let store: Store; let engine: Engine;
let http: ReturnType<typeof server>; let url: string;
const workInput = { title: 'Claims are exclusive', criteria: [{ id: 'AC-1', text: 'Only one agent claims the work', proofs: ['integration:claim-safety'] }] };
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-test-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init(); engine = new Engine(store);
  http = server(engine, [{ ...operator, token: 'o'.repeat(32) }, { ...worker, token: 'w'.repeat(32) }, { ...coordinator, token: 'm'.repeat(32) }, ...probeWorkers]);
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
test('coordinator can observe but cannot mutate work, claim leases, or submit evidence', async () => {
  const w = await ready();
  await assert.rejects(engine.execute(coordinator, 'claim', w.id, {}, randomUUID()), /Worker permission/);
  await assert.rejects(engine.execute(coordinator, 'ready', w.id, {}, randomUUID()), /Operator permission/);
  await assert.rejects(engine.execute(coordinator, 'evidence', w.id, proof(), randomUUID()), /not permitted/);
});

test('single-use merge execution freezes relevant mutations through observed merge', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID()); assert.ok(w.gates.every(gate => gate.passed));
  const first = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  assert.equal(first.execution.authorizationRevision, w.revision);
  await assert.rejects(engine.execute(producer, 'evidence', w.id, proof(), randomUUID()), /merge execution is active/i);
  await assert.rejects(engine.execute(operator, 'requirements', w.id, { expectedPolicyRevision: w.policyRevision, reason: 'Race the merge', criteria: w.criteria, dependencies: [], plannedFiles: [], exclusiveResources: [] }, randomUUID()), /merge execution is active/i);
  await assert.rejects(engine.acquireMerge(coordinator, w.id, { expectedRevision: first.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID()), /already active/);
  await assert.rejects(engine.observe(w.id, first.revision, observation(w)), /only its matching merged observation/);
  await engine.cancelMerge(coordinator, w.id, { executionId: first.execution.id, reason: 'GitHub refused the merge' }, randomUUID());
  w = (await store.list()).find(item => item.id === w.id)!;
  const second = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  const merged = { ...observation(w), merged: true, mergeSha: 'c'.repeat(40), mergedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z') } as Observation;
  const delivered = await engine.observe(w.id, second.revision, merged);
  assert.equal(delivered.stage, 'done', 'single-use execution proves ordering even with a whole-second provider timestamp'); assert.equal(delivered.mergeExecution, null);
});
test('merge execution cannot outlive a required proof or the fresh observation', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID());
  const expiresAt = new Date(Date.now() + 94_000).toISOString();
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{evidence,0,expiresAt}',to_jsonb($2::text)) WHERE id=$1", [w.id, expiresAt]);
  w = (await store.list()).find(item => item.id === w.id)!;
  assert.ok(w.gates.every(gate => gate.passed));
  await assert.rejects(engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID()), /expire too soon/);
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
  await delay(5);
  w = await engine.observe(w.id, w.revision, { ...observation(w), merged: true, mergedAt: new Date().toISOString(), mergeSha: 'e'.repeat(40) }); assert.equal(w.stage, 'done');
  assert.ok(w.delivery?.authorizationRevision);
  assert.equal((await store.pool.query('SELECT 1 FROM jobs WHERE work_id=$1', [w.id])).rowCount, 0);
  await assert.rejects(engine.execute(worker, 'claim', w.id, {}, randomUUID()), /immutable/);
});
test('bypassed merge is a permanent visible violation, not done', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, { ...observation(w), merged: true });
  assert.notEqual(w.stage, 'done'); assert.ok(w.violations.length);
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID()); assert.notEqual(w.stage, 'done');
});
test('evidence arriving after the actual merge cannot retroactively authorize it', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  const actualMerge = '2000-01-01T00:00:00Z';
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID()); assert.ok(w.mergeAuthorization);
  w = await engine.observe(w.id, w.revision, { ...observation(w), merged: true, mergedAt: actualMerge });
  assert.notEqual(w.stage, 'done'); assert.ok(w.violations.includes('Merge observed without a prior authorization for this candidate'));
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
  const mergeResponse = await fetch(`${url}/api/work/${a.id}/merge-acquire`, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${'m'.repeat(32)}`, 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ expectedRevision: a.revision, sha: head, baseSha: base, policyRevision: a.policyRevision }) });
  assert.equal(mergeResponse.status, 409, 'coordinator merge route exists and refuses an unauthorized candidate');
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

test('workspace aliases, nested paths, and invalid Git branches cannot bypass reservations', async () => {
  const a = await claimed(), b = await claimed();
  const ws = { epoch: 1, host: 'alias-host', path: '/tmp/alias/reserved/', branch: 'graphyard/alias-a' };
  const saved = await engine.execute(worker, 'workspace', a.id, ws, randomUUID());
  assert.equal(saved.workspaces[0].path, '/tmp/alias/reserved');
  for (const path of ['/tmp/alias/other/../reserved', '/tmp/alias/reserved/child', '/tmp/alias']) {
    await assert.rejects(engine.execute(worker, 'workspace', b.id, { ...ws, path, branch: 'graphyard/alias-b' }, randomUUID()), /reserved/);
  }
  for (const branch of ['graphyard/invalid/', 'graphyard//invalid']) {
    await assert.rejects(engine.execute(worker, 'workspace', b.id, { ...ws, path: '/tmp/elsewhere', branch }, randomUUID()), /Invalid Graphyard branch/);
  }
});

test('expired integration owners cannot apply observations or acknowledge jobs', async () => {
  const w = await submitted(), token = randomUUID();
  await store.pool.query("UPDATE jobs SET token=$2,locked_until=now()-interval '1 second' WHERE work_id=$1", [w.id, token]);
  await assert.rejects(engine.observe(w.id, w.revision, observation(w), token), /lease expired/);
  await store.finishJob(w.id, token);
  assert.equal((await store.pool.query('SELECT token FROM jobs WHERE work_id=$1', [w.id])).rows[0].token, token);
  assert.equal((await store.list()).find(x => x.id === w.id)!.revision, w.revision);
});

test('new evidence wakes an in-flight integration job and its acknowledgment preserves the wakeup', async () => {
  let w = await submitted(); const token = randomUUID();
  await store.pool.query("UPDATE jobs SET token=$2,locked_until=now()+interval '90 seconds',claimed_generation=generation WHERE work_id=$1", [w.id, token]);
  w = await engine.execute(worker, 'evidence', w.id, proof(), randomUUID());
  await store.finishJob(w.id, token);
  const row = (await store.pool.query('SELECT token, available_at<=clock_timestamp() AS ready FROM jobs WHERE work_id=$1', [w.id])).rows[0];
  assert.equal(row.token, null); assert.equal(row.ready, true);
  await store.init(); // Re-running startup migration preserves the new queue columns and history.
  assert.equal((await store.events(w.id)).filter(e => e.kind === 'evidence').length, 1);
});

test('a delayed merge uses historical authorization despite an outage and later failing evidence', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID());
  const authorizedRevision = w.revision;
  await delay(5); const mergedAt = new Date().toISOString(); await delay(5);
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{observation,at}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=$1", [w.id]);
  await engine.reconcile();
  w = await engine.execute(producer, 'evidence', w.id, { ...proof(), result: 'fail' }, randomUUID());
  assert.equal(w.mergeAuthorization, null);
  w = await engine.observe(w.id, w.revision, { ...observation(w), merged: true, mergedAt, mergeSha: 'e'.repeat(40) });
  assert.equal(w.stage, 'done'); assert.equal(w.delivery?.authorizationRevision, authorizedRevision);
  assert.ok(w.violations.some(v => v.includes('Post-merge')));
});

test('whole-second merge timestamps do not accept same-second backfilled authorization', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID());
  const mergedAt = w.mergeAuthorization!.at.replace(/\.\d+Z$/, 'Z');
  w = await engine.observe(w.id, w.revision, { ...observation(w), merged: true, mergedAt, mergeSha: 'e'.repeat(40) });
  assert.notEqual(w.stage, 'done');
});

test('integration publication discards a passing snapshot superseded by failed evidence', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID());
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
  await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [w.id]);
  const published: { forced?: string; passing: boolean }[] = []; let calls = 0;
  const adapter = {
    observe: async (work: Work) => observation(work),
    publish: async (work: Work, forced: string | undefined, beforeWrite: () => Promise<void>) => {
      if (++calls === 1) await engine.execute(producer, 'evidence', work.id, { ...proof(), result: 'fail' }, randomUUID());
      await beforeWrite();
      published.push({ forced, passing: work.gates.every(g => g.passed) });
    },
  } as unknown as GitHub;
  await processJob(engine, adapter);
  assert.equal(calls, 2); assert.equal(published.length, 1);
  assert.equal(published[0].passing, false); assert.match(published[0].forced!, /fresh verification/);
  assert.equal((await store.list()).find(x => x.id === w.id)!.stage, 'acceptance');
});

test('protected acceptance harness exercises five contracts against the real HTTP server and Postgres', async () => {
  const result = await exercise(url, [{ ...operator, token: 'o'.repeat(32) }, ...probeWorkers]);
  assert.equal(result.length, 5); assert.ok(result.every((c: any) => c.result === 'pass'));
});


test('assignment identity comes from the authenticated principal and survives release and reclaim in history', async () => {
  const item = await ready();
  const claim = (data: unknown) => fetch(`${url}/api/work/${item.id}/claim`, { method: 'POST', headers: { Authorization: `Bearer ${'w'.repeat(32)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(data) });
  const spoof = await claim({ owner: 'agent-b', displayName: 'Other worker', runtime: 'Claude' });
  assert.equal(spoof.status, 400);
  const response = await claim({}); assert.equal(response.status, 200);
  let w = await response.json() as Work;
  assert.equal(w.lease?.owner, worker.id); assert.equal(w.lastAssignment?.displayName, 'Atlas'); assert.equal(w.lastAssignment?.runtime, 'Codex');
  const first = w.lastAssignment;
  w = await engine.execute(worker, 'release', w.id, { epoch: 1 }, randomUUID());
  assert.equal(w.lease, null); assert.deepEqual(w.lastAssignment, first);
  w = await engine.execute({ ...other, displayName: 'Beacon', runtime: 'Claude' }, 'claim', w.id, {}, randomUUID());
  assert.equal(w.lastAssignment?.owner, other.id); assert.equal(w.lastAssignment?.epoch, 2); assert.equal(w.lastAssignment?.runtime, 'Claude');
  const history = (await store.events(w.id)).filter(e => e.kind === 'claim').sort((a, b) => Number(a.seq) - Number(b.seq));
  assert.equal(history[0].payload.work.lastAssignment.displayName, 'Atlas');
  assert.equal(history[1].payload.work.lastAssignment.displayName, 'Beacon');
  await assert.rejects(engine.execute(worker, 'heartbeat', w.id, { epoch: 1 }, randomUUID()), /superseded/);
});

 test('upgrade preserves legacy ownership before expiry or explicit release, with audited history', async () => {
  for (const operation of ['expiry', 'release']) {
    let w = await claimed();
    delete w.lastAssignment;
    if (operation === 'expiry') w.lease!.expiresAt = '2000-01-01T00:00:00Z';
    await store.pool.query('UPDATE work_items SET document=$2::jsonb WHERE id=$1', [w.id, JSON.stringify(w)]);
    if (operation === 'expiry') { await engine.reconcile(); w = (await store.list()).find(x => x.id === w.id)!; }
    else w = await engine.execute(worker, 'release', w.id, { epoch: 1 }, randomUUID());
    assert.equal(w.lease, null); assert.deepEqual(w.lastAssignment, { owner: worker.id, epoch: 1 });
    const event = (await store.events(w.id)).find(e => e.kind === (operation === 'expiry' ? 'reconciled' : 'release'));
    assert.deepEqual(event.payload.work.lastAssignment, { owner: worker.id, epoch: 1 });
  }
 });

 test('status uses the lease database clock even when the application clock is skewed', async () => {
  const originalDate = globalThis.Date;
  const before = (await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
  try {
    globalThis.Date = new Proxy(originalDate, { construct(target, args, newTarget) { return Reflect.construct(target, args.length ? args : ['2099-01-01T00:00:00Z'], newTarget); } });
    const response = await fetch(`${url}/api/status`, { headers: { Authorization: `Bearer ${'w'.repeat(32)}` } });
    assert.equal(response.status, 200);
    const status = await response.json();
    const after = (await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
    assert.ok(Date.parse(status.now) >= before && Date.parse(status.now) <= after);
  } finally { globalThis.Date = originalDate; }
 });
test('review-provider revisions require operator identity, compare revisions, and invalidate acceptance', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w)); w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID());
  const input = { provider: 'codex', expectedPolicyRevision: 1, reason: 'Operator chooses independent cloud review' };
  await assert.rejects(engine.execute(worker, 'reviewpolicy', w.id, input, randomUUID()), /Operator/);
  w = await engine.execute(operator, 'reviewpolicy', w.id, input, randomUUID());
  assert.equal(w.policyRevision, 2); assert.equal(w.policy.reviewProvider, 'codex'); assert.equal(w.observation, null);
  assert.equal(w.gates.find(g => g.name === 'acceptance')?.passed, false); assert.equal(w.evidence.length, 1);
  await assert.rejects(engine.execute(operator, 'reviewpolicy', w.id, { ...input, provider: 'github' }, randomUUID()), /revision/);
  assert.equal((await store.events(w.id)).find(e => e.kind === 'reviewpolicy').payload.details.reason, input.reason);
  await assert.rejects(engine.execute(producer, 'rereview', w.id, {}, randomUUID()), /Worker or operator/);
  await assert.rejects(engine.bindReviewRequest(w.id, w.revision, { commentId: 1, sha: head, baseSha: base, policyRevision: 2, body: '@codex review', createdAt: new Date().toISOString() }, randomUUID()), /lease/);
});


test('only a leased integration job binds dispatch and current bound Codex approval satisfies review', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(operator, 'reviewpolicy', w.id, { provider: 'codex', expectedPolicyRevision: 1, reason: 'Use independent agent review' }, randomUUID());
  w = await engine.observe(w.id, w.revision, observation(w));
  const token = randomUUID();
  await store.pool.query("UPDATE jobs SET token=$2,locked_until=now()+interval '90 seconds' WHERE work_id=$1", [w.id, token]);
  const request = { commentId: 8123, sha: head, baseSha: base, policyRevision: 2, body: '@codex review', createdAt: new Date().toISOString() };
  w = await engine.bindReviewRequest(w.id, w.revision, request, token);
  const clean = { ...observation(w), reviews: [], agentReview: { provider: 'codex' as const, sha: head, approved: true, requestId: 8123, reason: 'Clean review' } };
  w = await engine.observe(w.id, w.revision, clean);
  assert.equal(w.gates.find(g => g.name === 'review')?.passed, true);
  w = await engine.observe(w.id, w.revision, { ...clean, agentReview: { ...clean.agentReview, requestId: 999 } });
  assert.equal(w.gates.find(g => g.name === 'review')?.passed, false);
  w = await engine.observe(w.id, w.revision, { ...clean, reviews: [{ reviewer: 'human', sha: head, state: 'CHANGES_REQUESTED' }] });
  assert.equal(w.gates.find(g => g.name === 'review')?.passed, false);
  w = await engine.execute(operator, 'rereview', w.id, {}, randomUUID());
  assert.equal(w.reviewRequest, null); assert.equal(w.gates.find(g => g.name === 'review')?.passed, false);
  assert.ok((await store.events(w.id)).some(e => e.kind === 'review.requested'));
});

test('concurrent task changes schedule a prompt retry without an operator error', async () => {
  let w = await submitted();
  w = await engine.observe(w.id, w.revision, observation(w));
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
  await store.pool.query('UPDATE jobs SET available_at=now() WHERE work_id=$1', [w.id]);
  let publications = 0;
  const adapter = {
    async observe() {
      await engine.execute(worker, 'heartbeat', w.id, { epoch: 1 }, randomUUID());
      return observation(w);
    },
    async publish(_work: Work, reason: string, guard: () => Promise<void>) { assert.match(reason, /fresh verification/); await guard(); publications++; },
  } as unknown as GitHub;
  await processJob(engine, adapter);
  const row = (await store.pool.query("SELECT error,token,available_at<=clock_timestamp()+interval '3 seconds' AS soon FROM jobs WHERE work_id=$1", [w.id])).rows[0];
  assert.equal(row.error, null); assert.equal(row.token, null); assert.equal(row.soon, true); assert.equal(publications, 1);
  const current = (await store.list()).find(x => x.id === w.id)!;
  assert.deepEqual(current.observation, w.observation);
  const job = await store.pool.query("UPDATE jobs SET token=$2,locked_until=now()+interval '90 seconds' WHERE work_id=$1", [w.id, '11111111-1111-4111-8111-111111111111']);
  assert.equal(job.rowCount, 1);
  await store.finishJob(w.id, '11111111-1111-4111-8111-111111111111', 'GitHub permission denied');
  assert.equal((await store.pool.query('SELECT error FROM jobs WHERE work_id=$1', [w.id])).rows[0].error, 'GitHub permission denied');
});

 test('a policy change after the actual merge cannot invalidate historical delivery authorization', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID());
  const authorizedRevision = w.revision;
  await delay(5); const mergedAt = new Date().toISOString(); await delay(5);
  w = await engine.execute(operator, 'reviewpolicy', w.id, { provider: 'codex', expectedPolicyRevision: 1, reason: 'Merge not observed yet' }, randomUUID());
  assert.equal(w.policyRevision, 2); assert.equal(w.mergeAuthorization, null);
  w = await engine.observe(w.id, w.revision, { ...observation(w), merged: true, mergedAt, mergeSha: 'e'.repeat(40) });
  assert.equal(w.stage, 'done'); assert.equal(w.delivery?.authorizationRevision, authorizedRevision);
  assert.ok(!w.violations.some(v => v.includes('without a prior authorization')));
  assert.ok(w.violations.some(v => v.includes('Post-merge')));
 });

 test('review request persistence classifies an expired dispatch lease as a safe retry', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  const token = randomUUID();
  await store.pool.query("UPDATE jobs SET token=$2,locked_until=clock_timestamp()-interval '1 second' WHERE work_id=$1", [w.id, token]);
  await assert.rejects(engine.bindReviewRequest(w.id, w.revision, { commentId: 999, sha: head, baseSha: base, policyRevision: 1, body: '@codex review', createdAt: new Date().toISOString() }, token), ReconciliationRetry);
  const current = (await store.list()).find(x => x.id === w.id)!;
  assert.equal(current.reviewRequest, undefined); assert.equal(current.revision, w.revision);
 });

 test('whole-second delivery never searches past a same-second policy revocation', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID());
  await delay(1100 - Date.now() % 1000);
  w = await engine.execute(operator, 'reviewpolicy', w.id, { provider: 'codex', expectedPolicyRevision: 1, reason: 'Revoke the prior review policy' }, randomUUID());
  const mergedAt = w.updatedAt.replace(/\.\d+Z$/, 'Z');
  w = await engine.observe(w.id, w.revision, { ...observation(w), merged: true, mergedAt, mergeSha: 'e'.repeat(40) });
  assert.notEqual(w.stage, 'done'); assert.ok(w.violations.some(v => v.includes('without a prior authorization')));
 });

test('draft and closed submissions wait normally and dispatch after becoming ready', async () => {
  for (const initial of [{prState:'open' as const,draft:true},{prState:'closed' as const,draft:false}]) {
    let w = await submitted();
    w = await engine.execute(operator,'reviewpolicy',w.id,{provider:'codex',expectedPolicyRevision:1,reason:'Use agent review'},randomUUID());
    let state = initial, requests = 0;
    const adapter = {
      observe: async (work: Work) => ({...observation(work),...state,mergeable:state.prState==='open'&&!state.draft}),
      requestCodex: async (work: Work, guard:()=>Promise<void>) => {await guard();requests++;return {commentId:900,sha:head,baseSha:base,policyRevision:work.policyRevision,body:'@codex review',createdAt:new Date().toISOString()};},
      publish: async (_work:Work, forced:unknown, guard:()=>Promise<void>) => {assert.equal(forced,undefined);await guard();},
    } as unknown as GitHub;
    async function run() {await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");await store.pool.query('UPDATE jobs SET available_at=now() WHERE work_id=$1',[w.id]);await processJob(engine,adapter);}
    await run(); assert.equal(requests,0);
    assert.equal((await store.pool.query('SELECT error FROM jobs WHERE work_id=$1',[w.id])).rows[0].error,null);
    state={prState:'open',draft:false}; await run(); assert.equal(requests,1);
    assert.equal((await store.list()).find(x=>x.id===w.id)!.reviewRequest?.commentId,900);
  }
});

 test('work snapshot pairs database time with immutable work data in one read', async () => {
  let w=await ready();w=await engine.execute(worker,'claim',w.id,{},randomUUID());
  const before=(await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
  const response=await fetch(`${url}/api/work-snapshot`,{headers:{Authorization:`Bearer ${'w'.repeat(32)}`}});assert.equal(response.status,200);const snapshot=await response.json();
  const after=(await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
  assert.ok(Date.parse(snapshot.now)>=before&&Date.parse(snapshot.now)<=after);
  const captured=snapshot.work.find((item:Work)=>item.id===w.id);assert.equal(captured.revision,w.revision);assert.ok(Date.parse(captured.lease.expiresAt)>Date.parse(snapshot.now));
  w=await engine.execute(worker,'heartbeat',w.id,{epoch:1},randomUUID());assert.ok(captured.revision<w.revision);
  const denied=await fetch(`${url}/api/work-snapshot`);assert.equal(denied.status,401);
 });

test('requirement revisions require stopped ownership, preserve history, and invalidate prior proof', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID());
  const revision = { expectedPolicyRevision: 1, reason: 'Clarify the independent acceptance obligation', criteria: [{ id: 'AC-1', text: 'Revised outcome', proofs: ['integration:claim-safety'] }], dependencies: [], plannedFiles: ['src/'], exclusiveResources: ['staging:account'] };
  await assert.rejects(engine.execute(worker, 'requirements', w.id, revision, randomUUID()), /Operator/);
  await assert.rejects(engine.execute(operator, 'requirements', w.id, revision, randomUUID()), /release/);
  await engine.execute(worker, 'release', w.id, { epoch: 1 }, randomUUID());
  const key = randomUUID(); w = await engine.execute(operator, 'requirements', w.id, revision, key);
  assert.equal(w.policyRevision, 2); assert.equal(w.reworkRequested, true); assert.equal(w.observation, null); assert.equal(w.mergeAuthorization, null); assert.equal(w.reviewRequest, null);
  assert.equal(w.evidence.length, 1); assert.equal(w.evidence[0].policyRevision, 1); assert.equal(w.gates.find(g => g.name === 'acceptance')!.passed, false);
  assert.equal((await engine.execute(operator, 'requirements', w.id, revision, key)).policyRevision, 2);
  await assert.rejects(engine.execute(operator, 'requirements', w.id, revision, randomUUID()), /revision changed/);
  const event = (await store.events(w.id)).find(e => e.kind === 'requirements'); assert.equal(event.payload.details.reason, revision.reason);
  assert.ok((await store.events(w.id)).some(e => e.payload.work.criteria[0].text === workInput.criteria[0].text));
  w = await engine.execute(other, 'claim', w.id, {}, randomUUID()); assert.equal(w.epoch, 2);
  await assert.rejects(engine.execute(worker, 'heartbeat', w.id, { epoch: 1 }, randomUUID()), /superseded/);
});

test('requirement changes reject dependency cycles and reused retired criterion IDs', async () => {
  let a = await create(); const b = await create([a.id]);
  const input = { expectedPolicyRevision: 1, reason: 'Discovered prerequisite', criteria: a.criteria, dependencies: [b.id], plannedFiles: [], exclusiveResources: [] };
  await assert.rejects(engine.execute(operator, 'requirements', a.id, input, randomUUID()), /cycle/);
  await assert.rejects(engine.execute(operator, 'requirements', a.id, { ...input, dependencies: [a.id] }, randomUUID()), /cycle/);
  a = await engine.execute(operator, 'requirements', a.id, { ...input, dependencies: [], criteria: [{ ...a.criteria[0], id: 'AC-2' }] }, randomUUID());
  assert.deepEqual(a.retiredCriterionIds, ['AC-1']);
  await assert.rejects(engine.execute(operator, 'requirements', a.id, { ...input, expectedPolicyRevision: 2, dependencies: [] }, randomUUID()), /Retired/);
});

test('requirement revisions preserve existing scenario pins and require known new scenarios', async () => {
  const id = `revision-${randomUUID()}`;
  const definition = { id, title: 'Pinned scenario', purpose: 'Target attribution', steps: ['Run'], expected: ['Pass'], environment: 'staging', runner: 'external', testPath: 'test.ts' };
  await defineScenario(store, operator, definition, randomUUID());
  let w = await engine.execute(operator, 'create', null, { ...workInput, criteria: [{ id: 'AC-1', text: 'Pinned behavior', proofs: [`e2e:${id}`] }] }, randomUUID());
  await defineScenario(store, operator, { ...definition, expectedRevision: 1, expected: ['Different result'] }, randomUUID());
  const revision = { expectedPolicyRevision: 1, reason: 'Clarify outcome without silently updating scenario', criteria: w.criteria, dependencies: [], plannedFiles: [], exclusiveResources: [] };
  w = await engine.execute(operator, 'requirements', w.id, revision, randomUUID());
  assert.equal(w.scenarioRequirements[0].revision, 1);
  await assert.rejects(engine.execute(operator, 'requirements', w.id, { ...revision, expectedPolicyRevision: 2, criteria: [{ id: 'AC-1', text: 'Missing', proofs: ['e2e:not-registered'] }] }, randomUUID()), /Register E2E/);
});

test('exclusive resource claims serialize across replicas and expired epochs cannot regain them', async () => {
  const resource = `staging:${randomUUID()}`;
  const tasks = await Promise.all(Array.from({ length: 2 }, () => engine.execute(operator, 'create', null, { ...workInput, exclusiveResources: [resource] }, randomUUID())));
  for (const w of tasks) await engine.execute(operator, 'ready', w.id, {}, randomUUID());
  const second = new Store(store.pool.options.connectionString!); const replica = new Engine(second);
  try {
    const results = await Promise.allSettled(tasks.map((w, i) => (i ? replica : engine).execute(i ? other : worker, 'claim', w.id, {}, randomUUID())));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const winner = (results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<Work>).value;
    const loser = tasks.find(w => w.id !== winner.id)!;
    // Completion can precede the implementation worker's last lease expiry.
    await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{stage}',to_jsonb('done'::text)) WHERE id=$1", [winner.id]);
    await assert.rejects(engine.execute(other, 'claim', loser.id, {}, randomUUID()), /Exclusive resources held/);
    await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{stage}',to_jsonb('build'::text)) WHERE id=$1", [winner.id]);
    await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{lease,expiresAt}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=$1", [winner.id]);
    await engine.execute(other, 'claim', loser.id, {}, randomUUID());
    await assert.rejects(engine.execute({ id: winner.lease!.owner, role: 'worker' }, 'heartbeat', winner.id, { epoch: winner.epoch }, randomUUID()), /expired/);
    await assert.rejects(engine.execute(worker, 'claim', winner.id, {}, randomUUID()), /Exclusive resources held/);
  } finally { await second.close(); }
});

test('formal review identities stay excluded after revisions regardless of clock skew', async () => {
  let w = await submitted();
  const existing = { id: 100, reviewer: 'reviewer', sha: head, state: 'APPROVED', submittedAt: new Date(Date.now() + 60000).toISOString() };
  w = await engine.observe(w.id, w.revision, { ...observation(w), reviewIds: [100], reviews: [existing] });
  await engine.execute(worker, 'release', w.id, { epoch: 1 }, randomUUID());
  w = await engine.execute(operator, 'requirements', w.id, { expectedPolicyRevision: 1, reason: 'Change intent without changing code', criteria: [{ ...w.criteria[0], text: 'Revised intent' }], dependencies: [], plannedFiles: [], exclusiveResources: [] }, randomUUID());
  assert.equal(w.formalReviewResetRequired, true); assert.equal(w.formalReviewBaseline, undefined);
  w = await engine.observe(w.id, w.revision, { ...observation(w), reviews: [existing] });
  assert.equal(w.gates.find(g => g.name === 'review')!.passed, false); assert.equal(w.formalReviewBaseline, undefined);
  w = await engine.observe(w.id, w.revision, { ...observation(w), reviewIds: [100, 101], reviews: [existing] });
  assert.deepEqual(w.formalReviewBaseline!.reviewIds, [100, 101]);
  assert.equal(w.gates.find(g => g.name === 'review')!.passed, false);
  // A later database evaluation cannot make the same immutable identity fresh.
  const { evaluate } = await import('../src/model.js');
  assert.equal(evaluate(w, [w], new Date(Date.now() + 120000), [15368]).gates.find(g => g.name === 'review')!.passed, false);
  for (const id of [undefined, 100, 101]) {
    w = await engine.observe(w.id, w.revision, { ...observation(w), reviewIds: [100, 101], reviews: [{ ...existing, id }] });
    assert.equal(w.gates.find(g => g.name === 'review')!.passed, false);
  }
  w = await engine.observe(w.id, w.revision, { ...observation(w), reviewIds: [100, 101, 102], reviews: [{ ...existing, id: 102 }] });
  assert.equal(w.gates.find(g => g.name === 'review')!.passed, true);
  w = await engine.execute(operator, 'reviewpolicy', w.id, { provider: 'codex', expectedPolicyRevision: 2, reason: 'Cloud review' }, randomUUID());
  w = await engine.execute(operator, 'reviewpolicy', w.id, { provider: 'github', expectedPolicyRevision: 3, reason: 'Formal review again' }, randomUUID());
  assert.equal(w.formalReviewBaseline, undefined);
  w = await engine.observe(w.id, w.revision, { ...observation(w), reviewIds: [100, 101, 102], reviews: [{ ...existing, id: 102 }] });
  assert.equal(w.gates.find(g => g.name === 'review')!.passed, false);
});
