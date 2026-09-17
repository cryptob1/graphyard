import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { OperatorAgents } from '../src/operator-agent.js';
import { ReconciliationRetry, type Principal, type Work, type Observation } from '../src/model.js';
import { defineScenario, scenarios } from '../src/scenarios.js';
import { setTimeout as delay } from 'node:timers/promises';
import { processJob, type GitHub } from '../src/github.js';
import { acknowledgeContainment, isConfirmedCoordinationRefusal } from '../src/quarantine.js';
import { supervise } from '../src/supervisor.js';
// @ts-expect-error The trusted runner intentionally uses dependency-free JavaScript outside the candidate source.
import { exercise } from '../scripts/acceptance-contract.mjs';

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'agent-a', role: 'worker', displayName: 'Atlas', runtime: 'Codex' };
const other: Principal = { id: 'agent-b', role: 'worker' };
const coordinator: Principal = { id: 'master', role: 'coordinator' };
const otherCoordinator: Principal = { id: 'other-master', role: 'coordinator' };
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
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init(); engine = new Engine(store, [15368], 120, 'owner/project');
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
  return { clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr: w.submission!.pr, branch: w.workspaces[0].branch, author: 'implementer' },
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
test('real HTTP coordination refusal envelope is classified as definitive', async () => {
  const response = await fetch(`${url}/api/work/missing/claim`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${'w'.repeat(32)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: '{}',
  });
  const envelope = await response.json();
  assert.equal(response.status, 404);
  assert.deepEqual(envelope, { error: 'Work item not found' });
  assert.equal(isConfirmedCoordinationRefusal(response.status, envelope), true);
});
test('expired lease is recoverable and all stale-owner commands are fenced', async () => {
  let w = await claimed();
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{lease,expiresAt}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=$1", [w.id]);
  await engine.reconcile();
  w = await engine.execute(other, 'claim', w.id, {}, randomUUID()); assert.equal(w.epoch, 2);
  for (const command of ['heartbeat', 'release'] as const) await assert.rejects(engine.execute(worker, command, w.id, { epoch: 1 }, randomUUID()), /superseded/);
  await assert.rejects(engine.execute(worker, 'submit', w.id, { epoch: 1, pr: 33 }, randomUUID()), /superseded/);
});
test('containment quarantine survives lease expiry and blocks overlap until verified settlement', async () => {
  let w = await claimed();
  const settlementToken = 'a'.repeat(64), settlementHash = 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb';
  w = await engine.execute(worker, 'quarantine', w.id, { epoch: 1, settlementHash }, randomUUID());
  assert.deepEqual(w.containmentQuarantine && { owner: w.containmentQuarantine.owner, epoch: w.containmentQuarantine.epoch }, { owner: worker.id, epoch: 1 });
  await assert.rejects(engine.execute(worker, 'quarantine', w.id, { epoch: 1, settlementHash: 'b'.repeat(64) }, randomUUID()), /cannot be replaced/);
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{lease,expiresAt}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=$1", [w.id]);
  await engine.reconcile();
  await assert.rejects(engine.execute(other, 'claim', w.id, {}, randomUUID()), /quarantined.*epoch 1/);
  await assert.rejects(engine.execute(other, 'settle', w.id, { epoch: 1, settlementToken }, randomUUID()), /another worker/);
  await assert.rejects(engine.execute(worker, 'settle', w.id, { epoch: 1, settlementToken: 'b'.repeat(64) }, randomUUID()), /capability is invalid/);
  w = await engine.execute(worker, 'settle', w.id, { epoch: 1, settlementToken }, randomUUID());
  assert.equal(w.containmentQuarantine, null);
  assert.deepEqual((await store.events(w.id)).find(event => event.kind === 'settle').payload.details, { epoch: 1 }, 'settlement capability is not retained in history');
  w = await engine.execute(other, 'claim', w.id, {}, randomUUID()); assert.equal(w.epoch, 2);
});
test('transactional launch acknowledgement races rework without a stale start or replacement overlap', async () => {
  let w = await claimed();
  const settlementToken = 'd'.repeat(64), settlementHash = createHash('sha256').update(settlementToken).digest('hex');
  w = await engine.execute(worker, 'quarantine', w.id, { epoch: 1, settlementHash }, randomUUID());
  const dir = await mkdtemp(join(tmpdir(), 'graphyard-launch-race-')), marker = join(dir, 'started');
  let releaseResponse!: () => void, acknowledgementCommitted!: () => void, monotonic = 0;
  const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
  const committed = new Promise<void>(resolve => { acknowledgementCommitted = resolve; });
  const containment = { command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`], signal: () => {}, empty: () => true };
  try {
    const running = supervise('ignored', [], 1,
      () => engine.execute(worker, 'heartbeat', w.id, { epoch: 1 }, randomUUID()),
      { containment, detached: false, graceMs: 1, quarantine: {
        establish: async () => {}, revalidate: async () => {},
        acknowledge: () => acknowledgeContainment(async () => {
          await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{lease,expiresAt}',to_jsonb((clock_timestamp() + interval '1 second')::text)) WHERE id=$1", [w.id]);
          const result = await engine.execute(worker, 'launch', w.id, { epoch: 1, settlementHash }, randomUUID());
          acknowledgementCommitted(); await responseGate;
          return result; // committed response held beyond both server deadlines
        }, { principal: worker.id, epoch: 1, settlementHash, exclusiveResources: [], requestId: randomUUID() }, { attempts: 1, monotonicNow: () => monotonic }),
        settle: () => engine.execute(worker, 'settle', w.id, { epoch: 1, settlementToken }, randomUUID()),
      } });
    await committed;
    await assert.rejects(stat(marker), { code: 'ENOENT' }, 'ack response in flight must not have spawned the worker');
    await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{lease,expiresAt}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=$1", [w.id]);
    await assert.rejects(engine.execute(operator, 'rework', w.id, { reason: 'lease expired but ACK response remains in flight', previousWorkerStopped: true }, randomUUID()), /both lease and launch authority expiry/);
    await assert.rejects(engine.execute(other, 'claim', w.id, {}, randomUUID()), /quarantined/);
    await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{containmentQuarantine,launchExpiresAt}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=$1", [w.id]);
    w = await engine.execute(operator, 'rework', w.id, { reason: 'bounded fence expired and supervisor is stopped', previousWorkerStopped: true }, randomUUID());
    assert.equal((await engine.execute(other, 'claim', w.id, {}, randomUUID())).epoch, 2);
    monotonic = 1_001; releaseResponse();
    await assert.rejects(running, /worker lease expired/);
    await assert.rejects(stat(marker), { code: 'ENOENT' }, 'stale ACK response must never spawn after recovery');
  } finally { releaseResponse(); await rm(dir, { recursive: true, force: true }); }
});
test('expired quarantines reserve shared resources until settlement or operator recovery', async () => {
  const resource = `staging:${randomUUID()}`, unrelatedResource = `staging:${randomUUID()}`;
  const makeReady = async (exclusiveResources: string[]) => {
    const item = await engine.execute(operator, 'create', null, { ...workInput, exclusiveResources }, randomUUID());
    return engine.execute(operator, 'ready', item.id, {}, randomUUID());
  };
  const owner = await makeReady([resource]);
  const shared = await makeReady([resource]);
  const unrelated = await makeReady([unrelatedResource]);
  let quarantined = await engine.execute(worker, 'claim', owner.id, {}, randomUUID());
  const settlementToken = 'c'.repeat(64);
  const settlementHash = createHash('sha256').update(settlementToken).digest('hex');
  quarantined = await engine.execute(worker, 'quarantine', quarantined.id, { epoch: 1, settlementHash }, randomUUID());
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{lease,expiresAt}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=$1", [quarantined.id]);
  await engine.reconcile();
  await assert.rejects(engine.execute(operator, 'requirements', quarantined.id, {
    expectedPolicyRevision: quarantined.policyRevision, reason: 'Attempt to remove the held reservation', criteria: quarantined.criteria,
    dependencies: [], plannedFiles: [], exclusiveResources: [],
  }, randomUUID()), /quarantined.*requirements remain immutable/);
  await assert.rejects(engine.execute(other, 'claim', shared.id, {}, randomUUID()), /Exclusive resources held.*staging:/);
  assert.equal((await engine.execute(other, 'claim', unrelated.id, {}, randomUUID())).epoch, 1);
  await engine.execute(worker, 'settle', quarantined.id, { epoch: 1, settlementToken }, randomUUID());
  assert.equal((await engine.execute(other, 'claim', shared.id, {}, randomUUID())).epoch, 1);

  const recoveryResource = `staging:${randomUUID()}`;
  let recoveryOwner = await makeReady([recoveryResource]);
  const recoveryPeer = await makeReady([recoveryResource]);
  recoveryOwner = await engine.execute(worker, 'claim', recoveryOwner.id, {}, randomUUID());
  recoveryOwner = await engine.execute(worker, 'quarantine', recoveryOwner.id, { epoch: 1, settlementHash }, randomUUID());
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{lease,expiresAt}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=$1", [recoveryOwner.id]);
  await assert.rejects(engine.execute(other, 'claim', recoveryPeer.id, {}, randomUUID()), /Exclusive resources held/);
  await engine.execute(operator, 'rework', recoveryOwner.id, { reason: 'Expired supervisor was stopped', previousWorkerStopped: true }, randomUUID());
  assert.equal((await engine.execute(other, 'claim', recoveryPeer.id, {}, randomUUID())).epoch, 1);
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
test('final merge verification re-evaluates mutable GitHub gates under the active execution', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID());
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  const current = { ...observation(w), prState: 'open' as const, draft: false };
  const verifyKey = randomUUID(); const verifyInput = { executionId: granted.execution.id };
  await assert.rejects(engine.verifyMerge(coordinator, w.id, verifyInput, { ...current, checks: current.checks.map(check => ({ ...check, result: 'failure' })) }, randomUUID()), /GitHub gates changed/);
  const verified = await engine.verifyMerge(coordinator, w.id, verifyInput, current, verifyKey);
  assert.equal(verified.executionId, granted.execution.id); assert.equal(verified.sha, head);
  assert.deepEqual(await engine.replayMergeVerification(coordinator, w.id, verifyInput, verifyKey), verified);
  assert.deepEqual(await engine.verifyMerge(coordinator, w.id, verifyInput, { ...current, checks: [] }, verifyKey), verified, 'an identical retry replays the committed verification');
  assert.equal((await store.events(w.id)).filter(event => event.kind === 'merge.execution.verified').length, 1);
  await assert.rejects(engine.verifyMerge(coordinator, w.id, verifyInput, current, randomUUID()), /already verified/);
  await assert.rejects(engine.verifyMerge(worker, w.id, verifyInput, current, randomUUID()), /Coordinator permission/);
});

test('single-use merge execution freezes relevant mutations through observed merge', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID()); assert.ok(w.gates.every(gate => gate.passed));
  const acquireKey = randomUUID();
  const first = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, acquireKey);
  assert.equal(first.execution.authorizationRevision, w.revision); assert.equal(first.execution.owner, coordinator.id);
  assert.deepEqual(await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, acquireKey), first);
  await assert.rejects(engine.execute(producer, 'evidence', w.id, proof(), randomUUID()), /merge execution is active/i);
  await assert.rejects(engine.execute(operator, 'requirements', w.id, { expectedPolicyRevision: w.policyRevision, reason: 'Race the merge', criteria: w.criteria, dependencies: [], plannedFiles: [], exclusiveResources: [] }, randomUUID()), /merge execution is active/i);
  await assert.rejects(engine.acquireMerge(coordinator, w.id, { expectedRevision: first.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID()), /already active/);
  await assert.rejects(engine.observe(w.id, first.revision, observation(w)), /reconciliation is deferred/);
  await assert.rejects(engine.cancelMerge(otherCoordinator, w.id, { executionId: first.execution.id, reason: 'Interfere with another coordinator' }, randomUUID()), /another coordinator/);
  await engine.cancelMerge(coordinator, w.id, { executionId: first.execution.id, reason: 'GitHub refused the merge' }, randomUUID());
  await assert.rejects(engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, acquireKey), /expired, cancelled, or superseded/);
  w = (await store.list()).find(item => item.id === w.id)!;
  const secondKey = randomUUID(); const secondInput = { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision };
  const second = await engine.acquireMerge(coordinator, w.id, secondInput, secondKey);
  const verified = await engine.verifyMerge(coordinator, w.id, { executionId: second.execution.id }, { ...observation(w), prState: 'open', draft: false }, randomUUID());
  const renewed = await engine.execute(worker, 'heartbeat', w.id, { epoch: w.epoch }, randomUUID());
  assert.equal(renewed.mergeExecution?.id, second.execution.id, 'lease renewal cannot replace or cancel merge authority');
  assert.deepEqual(await engine.acquireMerge(coordinator, w.id, secondInput, secondKey), second, 'the coordinator can recover a lost acquire response after a heartbeat');
  const mergedAt = new Date(Math.ceil((Date.parse(verified.verifiedAt) + 1) / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  const merged = { ...observation(w), merged: true, mergeSha: 'c'.repeat(40), mergedAt } as Observation;
  const delivered = await engine.observe(w.id, renewed.revision, merged);
  assert.equal(delivered.stage, 'done', 'a whole-second provider timestamp proves ordering once its lower bound postdates the grant'); assert.equal(delivered.mergeExecution, null);
  assert.equal(delivered.delivery?.authorizationRevision, second.execution.authorizationRevision, 'delivery cites the authorized snapshot rather than the later heartbeat');
  // The instant the authorization judged evidence applicability, on the repository clock.
  // A reader re-checking expiry at the raw provider timestamp would use a different clock.
  const asOf = Date.parse(delivered.delivery!.evidenceAsOf!);
  assert.ok(Number.isFinite(asOf), 'delivery records the authorization-time clock bound');
  assert.ok(asOf < Date.parse(second.execution.expiresAt), 'the recorded bound precedes the execution expiry that capped required-evidence validity');
});
test('a delivery carries the merge instant onto the repository clock with the measured offset', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID());
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  // The repository clock trails GitHub's by a measured five seconds. Nothing recorded after
  // this observation can recover that, so the delivery has to carry the instant itself:
  // every later repository-clock comparison - which reporting window a delivery falls in,
  // and how long it took from its append-only intent event - is otherwise off by the offset.
  const clockOffset = { min: -5000, max: -4000 };
  const verified = await engine.verifyMerge(coordinator, w.id, { executionId: granted.execution.id }, { ...observation(w), prState: 'open', draft: false, clockOffset }, randomUUID());
  const mergedAt = new Date(Math.ceil((Date.parse(verified.verifiedAt) + 5001) / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  const delivered = await engine.observe(w.id, verified.revision, { ...observation(w), merged: true, mergeSha: 'c'.repeat(40), mergedAt } as Observation);
  assert.equal(delivered.stage, 'done');
  assert.equal(delivered.delivery?.mergedAt, mergedAt, 'the provider timestamp is kept exactly as GitHub reported it');
  assert.equal(delivered.delivery?.repositoryClockOffsetMs, clockOffset.min);
  // The lower bound of the measured offset: the earliest repository instant the merge can
  // have happened at, so a duration derived from it is never inflated by clock skew.
  assert.equal(delivered.delivery?.mergedAtRepository, new Date(Date.parse(mergedAt) + clockOffset.min).toISOString());
});
test('a matching merge from before the execution grant remains an unauthorized violation', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID());
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  const merged = { ...observation(w), merged: true, mergeSha: 'c'.repeat(40), mergedAt: new Date(Date.parse(granted.execution.issuedAt) - 1000).toISOString() } as Observation;
  const refused = await engine.observe(w.id, granted.revision, merged);
  assert.notEqual(refused.stage, 'done'); assert.equal(refused.mergeExecution, null); assert.match(refused.violations.join(' '), /without a prior authorization/);
});
test('a matching merge after the bounded execution deadline remains an unauthorized violation', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID());
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  const merged = { ...observation(w), merged: true, mergeSha: 'c'.repeat(40), mergedAt: new Date(Date.parse(granted.execution.expiresAt) + 1).toISOString() } as Observation;
  const refused = await engine.observe(w.id, granted.revision, merged);
  assert.notEqual(refused.stage, 'done'); assert.equal(refused.mergeExecution, null); assert.match(refused.violations.join(' '), /without a prior authorization/);
});
test('database clock ahead of GitHub cannot authorize a merge after the database deadline', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID());
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  const verified = await engine.verifyMerge(coordinator, w.id, { executionId: granted.execution.id }, { ...observation(w), prState: 'open', draft: false, clockOffset: { min: 5000, max: 6000 } }, randomUUID());
  const merged = { ...observation(w), merged: true, mergeSha: 'c'.repeat(40), mergedAt: new Date(Date.parse(granted.execution.expiresAt) - 4000).toISOString() };
  const refused = await engine.observe(w.id, verified.revision, merged);
  assert.notEqual(refused.stage, 'done'); assert.match(refused.violations.join(' '), /without a prior authorization/);
});
test('whole-second merge timestamps require authority through the entire reported interval', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID());
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  const lowerBound = Math.floor(Date.now() / 1000) * 1000 + 60_000; const expiresAt = new Date(lowerBound + 500).toISOString();
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{mergeExecution,expiresAt}',to_jsonb($2::text)) WHERE id=$1", [w.id, expiresAt]);
  const merged = { ...observation(w), merged: true, mergeSha: 'c'.repeat(40), mergedAt: new Date(lowerBound).toISOString().replace('.000Z', 'Z') } as Observation;
  const refused = await engine.observe(w.id, granted.revision, merged);
  assert.notEqual(refused.stage, 'done'); assert.match(refused.violations.join(' '), /without a prior authorization/);
});
test('a cancelled merge execution cannot authorize a later matching merge', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID());
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  await engine.cancelMerge(coordinator, w.id, { executionId: granted.execution.id, reason: 'GitHub refused this attempt' }, randomUUID());
  w = (await store.list()).find(item => item.id === w.id)!;
  const merged = { ...observation(w), merged: true, mergeSha: 'c'.repeat(40), mergedAt: new Date(Date.now() + 1000).toISOString() } as Observation;
  const refused = await engine.observe(w.id, w.revision, merged);
  assert.notEqual(refused.stage, 'done'); assert.match(refused.violations.join(' '), /without a prior authorization/);
});
test('periodic reconciliation defers without publishing failure during active merge execution', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID());
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
  await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [w.id]);
  let publications = 0;
  const adapter = { observe: async (current: Work) => observation(current), publish: async () => { publications++; } } as unknown as GitHub;
  await processJob(engine, adapter);
  const row = (await store.pool.query('SELECT error,token,available_at FROM jobs WHERE work_id=$1', [w.id])).rows[0];
  assert.equal(publications, 0); assert.equal(row.error, null); assert.equal(row.token, null);
  assert.ok(Math.abs(row.available_at.getTime() - Date.parse(granted.execution.expiresAt)) < 1000);
});
test('reconciliation that became stale during merge acquisition defers without replacing the passing check', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID());
  await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [w.id]);
  let observed!: () => void, resume!: () => void; const started = new Promise<void>(resolve => { observed = resolve; }); const paused = new Promise<void>(resolve => { resume = resolve; });
  let publications = 0;
  const adapter = { observe: async (current: Work) => { observed(); await paused; return observation(current); }, publish: async () => { publications++; } } as unknown as GitHub;
  const processing = processJob(engine, adapter); await started;
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  resume(); await processing;
  const row = (await store.pool.query('SELECT error,token,available_at FROM jobs WHERE work_id=$1', [w.id])).rows[0];
  assert.equal(publications, 0); assert.equal(row.error, null); assert.equal(row.token, null);
  assert.ok(Math.abs(row.available_at.getTime() - Date.parse(granted.execution.expiresAt)) < 1000);
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
test('only an independently observed merge with a verified execution completes work', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID()); assert.equal(w.stage, 'merge');
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  const verified = await engine.verifyMerge(coordinator, w.id, { executionId: granted.execution.id }, { ...observation(w), prState: 'open', draft: false }, randomUUID());
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  w = await engine.observe(w.id, verified.revision, { ...observation(w), merged: true, mergedAt, mergeSha: 'e'.repeat(40) }); assert.equal(w.stage, 'done');
  assert.ok(w.delivery?.authorizationRevision);
  assert.equal((await store.pool.query('SELECT 1 FROM jobs WHERE work_id=$1', [w.id])).rowCount, 0);
  await assert.rejects(engine.execute(worker, 'claim', w.id, {}, randomUUID()), /immutable/);
});
test('capability settlement preserves active and expired merge executions while refusing forged authority', async () => {
  const prepare = async (suffix: string) => {
    let item = await engine.execute(operator, 'create', null, { ...workInput, exclusiveResources: [`merge-settlement:${suffix}:${randomUUID()}`] }, randomUUID());
    item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
    item = await engine.execute(worker, 'claim', item.id, {}, randomUUID());
    const settlementToken = suffix.repeat(64), settlementHash = createHash('sha256').update(settlementToken).digest('hex');
    item = await engine.execute(worker, 'quarantine', item.id, { epoch: 1, settlementHash }, randomUUID());
    item = await engine.execute(worker, 'workspace', item.id, { epoch: 1, host: `merge-settlement-${suffix}`, path: `/tmp/${item.id}-${suffix}`, branch: `graphyard/${item.id}-${suffix}` }, randomUUID());
    item = await engine.execute(worker, 'submit', item.id, { epoch: 1, pr: Number(item.key.slice(3)) }, randomUUID());
    item = await engine.observe(item.id, item.revision, observation(item));
    item = await engine.execute(producer, 'evidence', item.id, proof(), randomUUID());
    await engine.acquireMerge(coordinator, item.id, { expectedRevision: item.revision, sha: head, baseSha: base, policyRevision: item.policyRevision }, randomUUID());
    return { item, settlementToken };
  };

  for (const [suffix, expire] of [['a', false], ['b', true]] as const) {
    const prepared = await prepare(suffix);
    if (expire) await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{mergeExecution,expiresAt}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=$1", [prepared.item.id]);
    const before = (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [prepared.item.id])).rows[0].document as Work; const gates = structuredClone(before.gates);
    const mergeHistory = (await store.events(prepared.item.id)).filter(event => event.kind.startsWith('merge.'));
    await assert.rejects(engine.execute(other, 'settle', prepared.item.id, { epoch: 1, settlementToken: prepared.settlementToken }, randomUUID()), /another worker/);
    await assert.rejects(engine.execute(worker, 'settle', prepared.item.id, { epoch: 1, settlementToken: 'f'.repeat(64) }, randomUUID()), /capability is invalid/);
    const settled = await engine.execute(worker, 'settle', prepared.item.id, { epoch: 1, settlementToken: prepared.settlementToken }, randomUUID());
    assert.deepEqual(settled.mergeExecution, before.mergeExecution, `${expire ? 'expired' : 'active'} merge execution must be preserved`);
    assert.deepEqual(settled.gates, gates); assert.deepEqual((await store.events(prepared.item.id)).filter(event => event.kind.startsWith('merge.')), mergeHistory);
    assert.equal(settled.containmentQuarantine, null);
  }
});
test('non-delivered capability settlement still re-evaluates stale gates', async () => {
  let w = await claimed();
  const settlementToken = 'c'.repeat(64), settlementHash = createHash('sha256').update(settlementToken).digest('hex');
  w = await engine.execute(worker, 'quarantine', w.id, { epoch: 1, settlementHash }, randomUUID());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: `stale-settlement-${w.id}`, path: `/tmp/${w.id}-stale-settlement`, branch: `graphyard/${w.id}-stale-settlement` }, randomUUID());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: Number(w.key.slice(3)) }, randomUUID());
  w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID());
  assert.equal(w.stage, 'merge'); assert.ok(w.mergeAuthorization);
  w = { ...w, observation: { ...w.observation!, at: '2000-01-01T00:00:00Z' },
    evidence: w.evidence.map(item => ({ ...item, expiresAt: '2000-01-01T00:00:00Z' })) };
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [w.id, JSON.stringify(w)]);
  const settled = await engine.execute(worker, 'settle', w.id, { epoch: 1, settlementToken }, randomUUID());
  assert.equal(settled.stage, 'acceptance'); assert.equal(settled.mergeAuthorization, null);
  assert.equal(settled.gates.find(gate => gate.name === 'acceptance')?.passed, false);
  assert.equal(settled.gates.find(gate => gate.name === 'merge')?.passed, false);
});
test('capability settlement survives the merge-to-done race without weakening delivered immutability', async () => {
  const resource = `delivery-race:${randomUUID()}`;
  let w = await engine.execute(operator, 'create', null, { ...workInput, exclusiveResources: [resource] }, randomUUID());
  w = await engine.execute(operator, 'ready', w.id, {}, randomUUID());
  w = await engine.execute(worker, 'claim', w.id, {}, randomUUID());
  let contender = await engine.execute(operator, 'create', null, { ...workInput, exclusiveResources: [resource] }, randomUUID());
  contender = await engine.execute(operator, 'ready', contender.id, {}, randomUUID());
  const settlementToken = 'd'.repeat(64), settlementHash = createHash('sha256').update(settlementToken).digest('hex');
  w = await engine.execute(worker, 'quarantine', w.id, { epoch: 1, settlementHash }, randomUUID());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'race-host', path: `/tmp/${w.id}-race`, branch: `graphyard/${w.id}-race` }, randomUUID());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: Number(w.key.slice(3)) }, randomUUID());
  w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID());
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  const verified = await engine.verifyMerge(coordinator, w.id, { executionId: granted.execution.id }, { ...observation(w), prState: 'open', draft: false }, randomUUID());
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  const merged = { ...observation(w), merged: true, mergedAt, mergeSha: 'f'.repeat(40) } as Observation;
  let current = await engine.observe(w.id, verified.revision, merged);
  assert.equal(current.stage, 'done'); assert.ok(current.containmentQuarantine, 'delivery can win the race before supervisor settlement');
  current = { ...current, observation: { ...current.observation!, at: '2000-01-01T00:00:00Z' },
    evidence: current.evidence.map(item => ({ ...item, expiresAt: '2000-01-01T00:00:00Z' })),
    lease: { ...current.lease!, expiresAt: '2000-01-01T00:00:00Z' } };
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [current.id, JSON.stringify(current)]);
  const preserved = { stage: current.stage, gates: current.gates, candidate: current.candidate, evidence: current.evidence,
    observation: current.observation, mergeAuthorization: current.mergeAuthorization, delivery: current.delivery };
  assert.ok(current.mergeAuthorization, 'delivered fixture must retain its merge authorization');
  await assert.rejects(engine.execute(other, 'claim', contender.id, {}, randomUUID()), /Exclusive resources held/);
  await assert.rejects(engine.execute(worker, 'settle', current.id, { epoch: 1, settlementToken: 'e'.repeat(64) }, randomUUID()), /capability is invalid/);
  await assert.rejects(engine.execute(other, 'settle', current.id, { epoch: 1, settlementToken }, randomUUID()), /another worker/);
  current = await engine.execute(worker, 'settle', current.id, { epoch: 1, settlementToken }, randomUUID());
  assert.equal(current.stage, 'done'); assert.equal(current.containmentQuarantine, null);
  assert.deepEqual({ stage: current.stage, gates: current.gates, candidate: current.candidate, evidence: current.evidence,
    observation: current.observation, mergeAuthorization: current.mergeAuthorization, delivery: current.delivery }, preserved);
  contender = await engine.execute(other, 'claim', contender.id, {}, randomUUID()); assert.equal(contender.epoch, 1);
  await assert.rejects(engine.execute(worker, 'release', current.id, { epoch: 1 }, randomUUID()), /immutable/);
  assert.deepEqual((await store.events(current.id)).find(event => event.kind === 'settle')?.payload.details, { epoch: 1 });
});
test('operator stopped-worker recovery clears only a delivered containment quarantine', async () => {
  const resource = `delivered-recovery:${randomUUID()}`;
  let w = await engine.execute(operator, 'create', null, { ...workInput, exclusiveResources: [resource] }, randomUUID());
  w = await engine.execute(operator, 'ready', w.id, {}, randomUUID());
  w = await engine.execute(worker, 'claim', w.id, {}, randomUUID());
  const settlementHash = createHash('sha256').update('f'.repeat(64)).digest('hex');
  w = await engine.execute(worker, 'quarantine', w.id, { epoch: 1, settlementHash }, randomUUID());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'recovery-host', path: `/tmp/${w.id}-recovery`, branch: `graphyard/${w.id}-recovery` }, randomUUID());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: Number(w.key.slice(3)) }, randomUUID());
  w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID());
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  const verified = await engine.verifyMerge(coordinator, w.id, { executionId: granted.execution.id }, { ...observation(w), prState: 'open', draft: false }, randomUUID());
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  w = await engine.observe(w.id, verified.revision, { ...observation(w), merged: true, mergedAt, mergeSha: '9'.repeat(40) });
  w = { ...w, mergeExecution: verified.mergeExecution, observation: { ...w.observation!, at: '2000-01-01T00:00:00Z' },
    evidence: w.evidence.map(item => ({ ...item, expiresAt: '2000-01-01T00:00:00Z' })),
    lease: { ...w.lease!, expiresAt: '2000-01-01T00:00:00Z' } };
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [w.id, JSON.stringify(w)]);
  w = (await store.list()).find(item => item.id === w.id)!;
  const preserved = { stage: w.stage, gates: w.gates, candidate: w.candidate, mergeExecution: w.mergeExecution, mergeAuthorization: w.mergeAuthorization,
    evidence: w.evidence, criteria: w.criteria, delivery: w.delivery, observation: w.observation, submission: w.submission, reworkRequested: w.reworkRequested };
  assert.ok(w.mergeAuthorization, 'delivered fixture must retain its merge authorization');
  let contender = await engine.execute(operator, 'create', null, { ...workInput, exclusiveResources: [resource] }, randomUUID());
  contender = await engine.execute(operator, 'ready', contender.id, {}, randomUUID());
  await assert.rejects(engine.execute(worker, 'recover', w.id, { reason: 'Worker stopped', previousWorkerStopped: true }, randomUUID()), /permission/);
  await assert.rejects(engine.execute(operator, 'recover', w.id, { reason: 'Missing attestation' }, randomUUID()));
  await assert.rejects(engine.execute(other, 'claim', contender.id, {}, randomUUID()), /Exclusive resources held/);
  const recoveryKey = randomUUID();
  const recoveries = await Promise.allSettled([
    engine.execute(operator, 'recover', w.id, { reason: 'Verified worker scope stopped', previousWorkerStopped: true }, recoveryKey),
    engine.execute(operator, 'recover', w.id, { reason: 'Verified worker scope stopped', previousWorkerStopped: true }, recoveryKey),
  ]);
  assert.equal(recoveries.filter(result => result.status === 'fulfilled').length, 2);
  const recovered = recoveries.find(result => result.status === 'fulfilled')!.value;
  assert.equal(recovered.containmentQuarantine, null); assert.deepEqual({ stage: recovered.stage, gates: recovered.gates, candidate: recovered.candidate, mergeExecution: recovered.mergeExecution, mergeAuthorization: recovered.mergeAuthorization,
    evidence: recovered.evidence, criteria: recovered.criteria, delivery: recovered.delivery, observation: recovered.observation, submission: recovered.submission, reworkRequested: recovered.reworkRequested }, preserved);
  await assert.rejects(engine.execute(operator, 'recover', w.id, { reason: 'Already clear', previousWorkerStopped: true }, randomUUID()), /no containment quarantine/);
  contender = await engine.execute(other, 'claim', contender.id, {}, randomUUID()); assert.equal(contender.epoch, 1);
  const recoveryEvents = (await store.events(w.id)).filter(item => item.kind === 'recover'); assert.equal(recoveryEvents.length, 1);
  const event = recoveryEvents[0];
  assert.deepEqual(event?.payload.details, { reason: 'Verified worker scope stopped', previousWorkerStopped: true });
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
test('server rejects a GitHub adapter outside the canonical engine repository', () => {
  const boundEngine = new Engine(store, [15368], 120, 'owner/selected');
  assert.throws(
    () => server(boundEngine, [{ ...operator, token: 'o'.repeat(32) }], { config: { repository: 'owner/adapter' } } as GitHub),
    /repositories must match/,
  );
});
test('scoped operator-agent credentials are deny-by-default, auditable, rotation-safe, and cannot weaken policy', async () => {
  const adminHeaders = { Authorization: `Bearer ${'o'.repeat(32)}`, 'Content-Type': 'application/json' };
  const post = (path: string, value: unknown, token = 'o'.repeat(32), key = randomUUID()) => fetch(`${url}/api/${path}`, { method: 'POST', headers: { ...adminHeaders, Authorization: `Bearer ${token}`, 'Idempotency-Key': key }, body: JSON.stringify(value) });
  const firstToken = `operator-first-${'x'.repeat(32)}`, secondToken = `operator-second-${'y'.repeat(32)}`;
  const setup = { id: `planner-${randomUUID()}`, displayName: 'Planning agent', capabilities: ['intent:create', 'intent:ready', 'intent:unblock', 'policy:requirements'], scope: { repositories: ['owner/project'], workItems: ['*'] }, token: firstToken, reason: 'Human enabled bounded planning automation' };
  const setupKey = randomUUID();
  const status: any = await (await fetch(`${url}/api/status`, { headers: adminHeaders })).json();
  assert.equal(status.repository, 'owner/project', 'the explicitly bound repository wins over ambient CI metadata');
  assert.equal((await post('operator-agents', { ...setup, id: operator.id }, 'o'.repeat(32))).status, 409, 'dynamic identity cannot collide with a configured principal');
  assert.equal((await post('operator-agents', { ...setup, id: `collision-${randomUUID()}`, token: 'w'.repeat(32) }, 'o'.repeat(32))).status, 409, 'dynamic credential cannot inherit a configured principal role');
  const configured: any = await (await post('operator-agents', setup, 'o'.repeat(32), setupKey)).json();
  assert.equal(configured.role, 'operator-agent'); assert.deepEqual(configured.fingerprints, [createHash('sha256').update(firstToken).digest('hex').slice(0, 16)]); assert.equal(JSON.stringify(configured).includes(firstToken), false);
  const inferredEngine = new Engine(store, [15368], 120, '');
  server(inferredEngine, [{ ...operator, token: 'o'.repeat(32) }], { config: { repository: 'owner/project' } } as GitHub);
  assert.equal(inferredEngine.repository, 'owner/project', 'the GitHub-inferred repository also binds engine mutation authorization');
  const persistedCollision = new OperatorAgents(store, 'owner/project', [{ id: setup.id, tokenHash: createHash('sha256').update('different-static-token').digest('hex') }]);
  await assert.rejects(persistedCollision.authenticate(firstToken), /collides with a configured principal/, 'persisted identities are rechecked against deployment principals');
  await assert.rejects(new OperatorAgents(store, 'owner/project').assertConfiguredPrincipalSafe({ id: 'static-new', tokenHash: createHash('sha256').update(firstToken).digest('hex') }), /collides with a persisted operator agent/, 'persisted tokens cannot acquire a newly configured role');
  assert.deepEqual(await (await post('operator-agents', setup, 'o'.repeat(32), setupKey)).json(), configured, 'setup retry is idempotent');
  assert.equal((await fetch(`${url}/api/operator-agents`, { headers: { Authorization: `Bearer ${firstToken}` } })).status, 403, 'agent cannot administer identities');
  assert.equal((await post('work', workInput, firstToken)).status, 400, 'operator-agent intent requires an audit reason');
  const unsafeCreate = await post('work', { ...workInput, policy: { checks: ['test'], review: false }, reason: 'Skip independent review' }, firstToken);
  assert.equal(unsafeCreate.status, 409, 'operator-agent cannot create review-free work');
  const providerCreate = await post('work', { ...workInput, policy: { checks: ['test'], review: true, reviewProvider: 'codex' }, reason: 'Select a review provider' }, firstToken);
  assert.equal(providerCreate.status, 403, 'intent:create does not grant review-provider selection authority');
  const createKey = randomUUID();
  const createIntent = { ...workInput, reason: 'Create bounded implementation intent' };
  const createdResponse = await post('work', createIntent, firstToken, createKey); const created: any = await createdResponse.json(); assert.equal(createdResponse.status, 200, JSON.stringify(created));
  assert.equal(created.policy.review, true);
  const priorAgentDocument = (await store.pool.query('SELECT document FROM operator_agents WHERE id=$1', [setup.id])).rows[0].document;
  await store.pool.query(`UPDATE operator_agents SET document=jsonb_set(document,'{capabilities}', '["intent:ready"]'::jsonb) WHERE id=$1`, [setup.id]);
  const workCountBeforeReplay = (await store.list()).length;
  assert.equal((await post('work', createIntent, firstToken, createKey)).status, 403, 'an exact replay is reauthorized against current capabilities');
  assert.equal((await store.list()).length, workCountBeforeReplay, 'a refused replay does not duplicate or mutate work');
  await store.pool.query('UPDATE operator_agents SET document=$2 WHERE id=$1', [setup.id, JSON.stringify(priorAgentDocument)]);
  assert.equal((await post(`work/${created.id}/ready`, { expectedRevision: created.revision }, firstToken)).status, 400, 'operator-agent release requires an audit reason');
  assert.equal((await post(`work/${created.id}/ready`, { reason: 'Release using stale state' }, firstToken)).status, 409, 'operator-agent mutations require a current revision');
  const releasedResponse = await post(`work/${created.id}/ready`, { expectedRevision: created.revision, reason: 'Requirements are ready for implementation' }, firstToken); assert.equal(releasedResponse.status, 200);
  const released: any = await releasedResponse.json();
  await store.pool.query(`UPDATE work_items SET document=jsonb_set(document,'{blocker}', '"Waiting for dependency"'::jsonb) WHERE id=$1`, [created.id]);
  assert.equal((await post(`work/${created.id}/unblock`, { expectedRevision: released.revision, reason: '   ' }, firstToken)).status, 400, 'operator-agent unblock rejects a blank audit reason');
  assert.equal((await store.list()).find(w => w.id === created.id)?.blocker, 'Waiting for dependency', 'a rejected blank reason does not mutate the blocker');
  assert.equal((await post(`work/${created.id}/ready`, { expectedRevision: released.revision, reason: 'Release again' }, firstToken)).status, 409, 'operator agents cannot churn revisions by re-releasing work');
  const unblockedResponse = await post(`work/${created.id}/unblock`, { expectedRevision: released.revision, reason: 'Dependency was verified complete' }, firstToken);
  assert.equal(unblockedResponse.status, 200); const unblocked: any = await unblockedResponse.json();
  assert.equal(unblocked.blocker, null); assert.equal(unblocked.revision, released.revision + 1);
  assert.equal((await post(`work/${created.id}/unblock`, { expectedRevision: unblocked.revision, reason: 'Clear nothing' }, firstToken)).status, 409, 'operator agents cannot churn revisions by clearing no blocker');
  const priorDocument = (await store.pool.query('SELECT document FROM operator_agents WHERE id=$1', [setup.id])).rows[0].document;
  await store.pool.query(`UPDATE operator_agents SET document=jsonb_set(document,'{scope,repositories}', '["other/project"]'::jsonb) WHERE id=$1`, [setup.id]);
  assert.equal((await fetch(`${url}/api/work`, { headers: { Authorization: `Bearer ${firstToken}` } })).status, 403, 'operator-agent reads require the current repository scope');
  await store.pool.query('UPDATE operator_agents SET document=$2 WHERE id=$1', [setup.id, JSON.stringify(priorDocument)]);
  assert.equal((await post(`work/${created.id}/claim`, {}, firstToken)).status, 403);
  assert.equal((await post(`work/${created.id}/evidence`, proof(), firstToken)).status, 403);
  assert.equal((await post(`work/${created.id}/merge-acquire`, {}, firstToken)).status, 403);
  assert.equal((await post(`validation/request`, {}, firstToken)).status, 403);
  const weakened = { expectedPolicyRevision: created.policyRevision, reason: 'Remove the requirement', criteria: [{ id: 'AC-2', text: 'Less', proofs: ['unit:less'] }], dependencies: [], plannedFiles: [], exclusiveResources: [] };
  assert.equal((await post(`work/${created.id}/requirements`, weakened, firstToken)).status, 409);
  const unchanged = (await store.list()).find(w => w.id === created.id)!; assert.deepEqual(unchanged.criteria, created.criteria); assert.equal(unchanged.policyRevision, created.policyRevision);
  const rotated: any = await (await post(`operator-agents/${setup.id}/rotate`, { token: secondToken, transitionSeconds: 0, reason: 'Scheduled rotation' })).json();
  assert.equal(rotated.lastMutation.kind, 'rotate'); assert.equal((await fetch(`${url}/api/status`, { headers: { Authorization: `Bearer ${firstToken}` } })).status, 401); assert.equal((await fetch(`${url}/api/status`, { headers: { Authorization: `Bearer ${secondToken}` } })).status, 200);
  const capturedActor = await new OperatorAgents(store, 'owner/project').authenticate(secondToken); assert.ok(capturedActor);
  assert.equal((await post(`operator-agents/${setup.id}/revoke`, { reason: 'Automation disabled by human' })).status, 200);
  assert.equal((await fetch(`${url}/api/status`, { headers: { Authorization: `Bearer ${secondToken}` } })).status, 401);
  await assert.rejects(engine.execute(capturedActor, 'ready', created.id, { expectedRevision: created.revision + 1, reason: 'Delayed request' }, randomUUID()), /revoked or expired/, 'credential is revalidated inside the mutation transaction');
  const history = await store.events(); assert.ok(history.some(event => event.kind === 'operator-agent.setup' && event.actor === operator.id)); assert.ok(history.some(event => event.kind === 'operator-agent.revoke'));
  const createEvent = history.find(event => event.kind === 'create' && event.actor === setup.id);
  assert.equal(createEvent.payload.details.reason, 'Create bounded implementation intent'); assert.equal(createEvent.payload.work.policy.review, true);
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
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  const verified = await engine.verifyMerge(coordinator, w.id, { executionId: granted.execution.id }, { ...observation(w), prState: 'open', draft: false }, randomUUID());
  const authorizedRevision = granted.execution.authorizationRevision;
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{mergeExecution,expiresAt}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=$1", [w.id]);
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{observation,at}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=$1", [w.id]);
  await engine.reconcile();
  w = (await store.list()).find(item => item.id === w.id)!;
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
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  const verified = await engine.verifyMerge(coordinator, w.id, { executionId: granted.execution.id }, { ...observation(w), prState: 'open', draft: false }, randomUUID());
  const authorizedRevision = granted.execution.authorizationRevision;
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{mergeExecution,expiresAt}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=$1", [w.id]);
  await engine.reconcile();
  w = (await store.list()).find(item => item.id === w.id)!;
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
