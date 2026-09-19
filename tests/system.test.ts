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
import { ReconciliationRetry, SpeculativeConflict, deliveryState, rollbackGuidance, type Principal, type Work, type Observation, type ScopeFile } from '../src/model.js';
import { diagnose } from '../src/coordination.js';
import { stageMetrics } from '../src/master-daemon.js';
import { predictQueue, queueRef, type QueuePlacement, type QueueSpeculation } from '../src/merge-queue.js';
import { defineScenario, scenarios } from '../src/scenarios.js';
import { proofPreview } from '../src/coordination.js';
import { setTimeout as delay } from 'node:timers/promises';
import { GitHubPermissionRefusal, installationFingerprint, permissionHoldMs, permissionRefusalLimit, processJob, type AppPermissionReport, type GitHub } from '../src/github.js';
import { acknowledgeContainment, containmentGraceMs, isConfirmedCoordinationRefusal } from '../src/quarantine.js';
import { probeSupervisorAbsence, supervise } from '../src/supervisor.js';
import { assertDispatchable, assessContainment, buildMasterStatus, snapshotWithClock } from '../src/master.js';
// @ts-expect-error The trusted runner intentionally uses dependency-free JavaScript outside the candidate source.
import { exercise, judgeMergeAuthorization, mergeAuthorizationCases } from '../scripts/acceptance-contract.mjs';
// @ts-expect-error The trusted runner intentionally uses dependency-free JavaScript outside the candidate source.
import { mergeAuthorizationPrincipals, probeMergeAuthorization } from '../scripts/merge-authorization-probe.mjs';

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'agent-a', role: 'worker', displayName: 'Atlas', runtime: 'Codex' };
const other: Principal = { id: 'agent-b', role: 'worker' };
const coordinator: Principal = { id: 'master', role: 'coordinator' };
const otherCoordinator: Principal = { id: 'other-master', role: 'coordinator' };
const producer: Principal = { id: 'ci-runner', role: 'producer', proofs: ['integration:claim-safety'] };
const otherProducer: Principal = { id: 'other-ci-runner', role: 'producer', proofs: ['integration:unrelated'] };
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
  engine.reviewerApps = reviewerApps; engine.controlPlaneAppId = GRAPHYARD_APP;
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
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: Number(w.key.slice(3)) }, randomUUID());
  // Every candidate lands on the same managed branch, so the merge queue is global. Tests that
  // assert single-candidate behaviour start from an empty queue; queue behaviour has its own tests.
  await clearQueue(w.id);
  return w;
}
async function clearQueue(keep?: string) {
  await store.pool.query("UPDATE work_items SET document=document-'queue' WHERE ($1::uuid IS NULL OR id<>$1) AND document->>'stage'<>'done'", [keep ?? null]);
}
function observation(w: Work): Observation {
  return { clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr: w.submission!.pr, branch: w.workspaces[0].branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews: [{ reviewer: 'reviewer', sha: head, state: 'APPROVED' }], protected: true, mergeable: true,
    merged: false, mergeSha: null, files: ['src/claims.ts'], scopeFiles: [], at: new Date().toISOString() };
}
function proof() { return { proof: 'integration:claim-safety', sha: head, baseSha: base, policyRevision: 1, result: 'pass', executed: 12, skipped: 0 }; }
/**
 * A proven candidate with Graphyard's queue tip published for it: the state a merge authorization
 * now requires, since only a published tip proves the validated commit contains its base. Its
 * branch already sits on that base, so the tip is its own head. Publication itself is exercised by
 * the merge-queue scenarios below; these tests are about the authority that follows it.
 */
async function proven(w: Work, observed?: Observation) {
  const evidenced = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID());
  const speculation: QueueSpeculation = { ref: queueRef(evidenced.key), tip: evidenced.candidate!.sha, base: evidenced.candidate!.baseSha,
    baseTree: sha40('7e'), predecessors: [], policyRevision: evidenced.policyRevision, publishedAt: new Date().toISOString() };
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{queue,speculation}',$2::jsonb) WHERE id=$1", [evidenced.id, JSON.stringify(speculation)]);
  return engine.observe(evidenced.id, (await reload(evidenced)).revision, observed ?? observation(evidenced));
}

const GRAPHYARD_APP = 1234;
const reviewerApps = [
  { id: 'claude-reviewer', runtime: 'claude', appId: 55_001, botUserId: 55_002 },
  { id: 'cursor-reviewer', runtime: 'cursor', appId: 66_001, botUserId: 66_002 },
];
const agentProfiles = [
  { name: 'claude-reviewer', runtime: 'claude', reviewerApp: 'claude-reviewer' },
  { name: 'cursor-reviewer', runtime: 'cursor', reviewerApp: 'cursor-reviewer', timeoutSeconds: 900 },
];
async function leasedJob(id: string) {
  const token = randomUUID();
  await store.pool.query("INSERT INTO jobs(work_id) VALUES($1) ON CONFLICT(work_id) DO NOTHING", [id]);
  await store.pool.query("UPDATE jobs SET token=$2,locked_until=now()+interval '90 seconds' WHERE work_id=$1", [id, token]);
  return token;
}
function agentRequest(w: Work, profile = 'claude-reviewer', commentId = 700) {
  return { commentId, sha: head, baseSha: base, policyRevision: w.policyRevision, body: `review ${profile}`, createdAt: new Date().toISOString(),
    provider: 'agent' as const, profile, reviewerApp: profile, marker: '44444444-4444-4444-8444-444444444444' };
}
function agentVerdict(w: Work, request: ReturnType<typeof agentRequest>, overrides: Record<string, unknown> = {}): Observation {
  return { ...observation(w), reviews: [], prState: 'open', draft: false,
    agentReview: { provider: 'agent', sha: head, approved: true, reason: 'Registered reviewer approved this commit',
      requestId: request.commentId, profile: request.profile, reviewerApp: request.reviewerApp, ...overrides } };
}
async function agentReviewed() {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  return engine.execute(operator, 'reviewpolicy', w.id, { provider: 'agent', reviewerProfiles: agentProfiles, expectedPolicyRevision: 1, reason: 'Adopt identity-bound agent review' }, randomUUID());
}

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
async function quarantinedByDeadSupervisor(hostId = 'coordinator-host') {
  const settlementToken = randomUUID().replaceAll('-', '').padEnd(64, '9').slice(0, 64);
  const settlementHash = createHash('sha256').update(settlementToken).digest('hex');
  let w = await claimed();
  const path = `/srv/graphyard/worktrees/${w.key}-1`;
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: hostId, path, branch: `graphyard/${w.id}` }, randomUUID());
  w = await engine.execute(worker, 'quarantine', w.id, { epoch: 1, settlementHash }, randomUUID());
  w = await engine.execute(worker, 'launch', w.id, { epoch: 1, settlementHash }, randomUUID());
  // The supervisor dies without settling: every authority lapses beyond the grace window.
  // The lease deadline lapses on the quarantine too, exactly as an unrenewed lease does:
  // reconciliation then clears the lease record without shortening the window.
  const lapsed = new Date(Date.now() - containmentGraceMs - 600_000).toISOString();
  await store.pool.query(`UPDATE work_items SET document=jsonb_set(jsonb_set(jsonb_set(document,'{lease,expiresAt}',to_jsonb($2::text)),
    '{containmentQuarantine,launchExpiresAt}',to_jsonb($2::text)),'{containmentQuarantine,leaseExpiresAt}',to_jsonb($2::text)) WHERE id=$1`, [w.id, lapsed]);
  await engine.reconcile();
  assert.equal((await store.list()).find(item => item.id === w.id)!.lease, null, 'reconciliation clears the expired lease record');
  return { work: (await store.list()).find(item => item.id === w.id)!, settlementHash, settlementToken, path, hostId };
}
const deadProbe = (workspacePath: string, overrides: Partial<ReturnType<typeof probeSupervisorAbsence>> = {}) => () =>
  ({ method: 'linux-proc-systemd' as const, platform: 'linux', uid: 1000, workspacePath, processes: [], scopes: [], inaccessible: 0, unverifiable: [], ...overrides });

test('master status verifies supervisor death on the registered host and the coordinator settles it with recorded evidence', async () => {
  const { work, settlementHash, path, hostId } = await quarantinedByDeadSupervisor();
  const headers = { Authorization: `Bearer ${'m'.repeat(32)}`, 'Content-Type': 'application/json' };
  const { snapshot, clockOffset } = await snapshotWithClock(async () => (await (await fetch(`${url}/api/work-snapshot`, { headers })).json()) as { work: Work[]; now: string });
  // A live containment scope on the host belongs to another assignment only because every
  // member it holds was attributed to one; it does not fence this quarantine.
  const containment = assessContainment(snapshot.work, { hostId, observedAt: snapshot.now, clockOffset,
    probe: deadProbe(path, { scopes: [{ unit: 'graphyard-watch-9-x.scope', activeState: 'active', processes: [], attributed: [4242] }] }) });
  const status = buildMasterStatus(snapshot, [], [], {}, containment);
  const row = status.work.find(entry => entry.key === work.key)!;
  assert.deepEqual({ settleable: row.containment?.settleable, refusals: row.containment?.refusals, host: row.containment?.host, epoch: row.containment?.epoch },
    { settleable: true, refusals: [], host: hostId, epoch: 1 });
  assert.equal(status.counts.settleableQuarantines >= 1, true);
  assert.match(row.attention!, new RegExp(`verified settleable; run master settle-containment ${work.key}`));

  const verification = containment[work.id].verification!;
  const settled: any = await (await fetch(`${url}/api/work/${work.id}/autosettle`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ epoch: 1, settlementHash, reason: 'Supervisor verified dead on the registered host', verification }) })).json();
  assert.equal(settled.containmentQuarantine, null);
  const event = (await store.events(work.id)).find(entry => entry.kind === 'autosettle')!;
  assert.equal(event.actor, coordinator.id);
  assert.deepEqual(event.payload.details.verification, verification, 'the verification that authorized settlement is appended to history');
  assert.equal(event.payload.details.reason, 'Supervisor verified dead on the registered host');
  // The fence is gone, so the item is dispatchable again without an operator attestation.
  const fresh = (await store.list()).find(item => item.id === work.id)!;
  assert.doesNotThrow(() => assertDispatchable(fresh, [fresh], new Date().toISOString()));
  assert.equal((await engine.execute(other, 'claim', work.id, {}, randomUUID())).epoch, 2);
});

test('every unverifiable containment signal refuses automatic settlement and keeps the attestation path', async () => {
  const { work, settlementHash, settlementToken, path, hostId } = await quarantinedByDeadSupervisor();
  const now = () => new Date().toISOString();
  const evidence = (overrides: Record<string, unknown> = {}) => ({ method: 'linux-proc-systemd', host: hostId, uid: 1000, platform: 'linux', workspacePath: path,
    observedAt: now(), clockOffset: { min: -20, max: 20 }, processes: [], scopes: [], inaccessible: 0, unverifiable: [], ...overrides });
  const settle = (verification: unknown, actor = coordinator, body: Record<string, unknown> = {}) =>
    engine.execute(actor, 'autosettle', work.id, { epoch: 1, settlementHash, reason: 'Automatic settlement attempt', verification, ...body }, randomUUID());

  await assert.rejects(settle(evidence(), worker), /Coordinator permission required/);
  await assert.rejects(settle(evidence(), coordinator, { settlementHash: 'f'.repeat(64) }), /does not match this verification/);
  await assert.rejects(settle(evidence(), coordinator, { epoch: 2 }), /missing, superseded, or does not match/);
  await assert.rejects(settle(evidence({ processes: [{ pid: 4242, evidence: 'command' }] })), /Process 4242 of the contained worker is still present/);
  await assert.rejects(settle(evidence({ unverifiable: ['systemd user manager is unavailable'] })), /Host verification was incomplete/);
  await assert.rejects(settle(evidence({ scopes: [{ unit: 'graphyard-watch-3-x.scope', activeState: 'active', processes: [9], attributed: [] }] })),
    /still holds 1 process\(es\) that are not attributed to another assignment/);
  await assert.rejects(settle(evidence({ scopes: [{ unit: 'graphyard-watch-3-x.scope', activeState: 'active', processes: [9], attributed: [10] }] })), /still holds 1 process/);
  await assert.rejects(settle(evidence({ host: 'another-host' })), /registered on coordinator-host/);
  await assert.rejects(settle(evidence({ workspacePath: '/srv/elsewhere' })), /is registered at/);
  await assert.rejects(settle(evidence({ platform: 'darwin' })), /Linux process and scope inspection/);
  await assert.rejects(settle(evidence({ observedAt: new Date(Date.now() - 600_000).toISOString() })), /older than 120s/);
  await assert.rejects(settle(evidence({ clockOffset: { min: 30_000, max: 30_100 } })), /clocks disagree/);
  for (const refusal of [settle(evidence({ processes: [{ pid: 1, evidence: 'workspace' }] }))])
    await assert.rejects(refusal, /rework .* --previous-worker-stopped REASON/, 'every refusal names the operator attestation path');

  // Reconciliation has already cleared the lease record, so the grace window is only as
  // long as the deadline the quarantine retained: a fresh one fences with no lease at all.
  const retainLease = (expiresAt: string | null) => store.pool.query(
    expiresAt === null ? `UPDATE work_items SET document=document #- '{containmentQuarantine,leaseExpiresAt}' WHERE id=$1`
      : `UPDATE work_items SET document=jsonb_set(document,'{containmentQuarantine,leaseExpiresAt}',to_jsonb($2::text)) WHERE id=$1`,
    expiresAt === null ? [work.id] : [work.id, expiresAt]);
  assert.equal((await store.list()).find(item => item.id === work.id)!.lease, null);
  await retainLease(new Date(Date.now() - 1_000).toISOString());
  await assert.rejects(settle(evidence()), /Worker lease for epoch 1 has not been expired for the required 120s grace window/);
  await retainLease(null);
  await assert.rejects(settle(evidence()), /records no worker-lease deadline/);
  await retainLease(new Date(Date.now() - containmentGraceMs - 600_000).toISOString());

  // A live supervisor is fenced even when the host reports nothing: the deadlines rule.
  await store.pool.query(`UPDATE work_items SET document=jsonb_set(document,'{lease}',$2::jsonb) WHERE id=$1`,
    [work.id, JSON.stringify({ owner: worker.id, epoch: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() })]);
  await assert.rejects(settle(evidence()), /Worker lease for epoch 1 has not been expired/);
  await store.pool.query(`UPDATE work_items SET document=jsonb_set(document,'{containmentQuarantine,launchExpiresAt}',to_jsonb($2::text)) WHERE id=$1`,
    [work.id, new Date(Date.now() - 1_000).toISOString()]);
  await store.pool.query(`UPDATE work_items SET document=jsonb_set(document,'{lease,expiresAt}',to_jsonb($2::text)) WHERE id=$1`,
    [work.id, new Date(Date.now() - 1_000).toISOString()]);
  await assert.rejects(settle(evidence()), /Launch authority for epoch 1 has not been expired/);

  // Nothing above lowered the fence, and both existing settlement paths still work.
  const fenced = (await store.list()).find(item => item.id === work.id)!;
  assert.equal(fenced.containmentQuarantine?.epoch, 1);
  await assert.rejects(engine.execute(other, 'claim', work.id, {}, randomUUID()), /quarantined.*epoch 1/);
  assert.equal((await engine.execute(worker, 'settle', work.id, { epoch: 1, settlementToken }, randomUUID())).containmentQuarantine, null);

  const stranded = await quarantinedByDeadSupervisor('another-machine');
  const localHost = assessContainment([stranded.work], { hostId, observedAt: new Date().toISOString(), clockOffset: { min: 0, max: 5 }, probe: deadProbe(stranded.path) });
  assert.deepEqual(localHost, {}, 'a quarantine registered on another host is not this coordinator to verify');
  assert.equal((await engine.execute(operator, 'rework', stranded.work.id, { reason: 'Operator attested the stopped worker', previousWorkerStopped: true }, randomUUID())).containmentQuarantine, null);
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
  w = await proven(w); assert.ok(w.gates.every(g => g.passed));
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
  w = await proven(w);
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
  w = await proven(w); assert.ok(w.gates.every(gate => gate.passed));
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
  await assert.rejects(engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, acquireKey), /expired, cancelled, fenced, or superseded/);
  w = (await store.list()).find(item => item.id === w.id)!;
  const secondKey = randomUUID(); const secondInput = { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision };
  const second = await engine.acquireMerge(coordinator, w.id, secondInput, secondKey);
  const verified = await engine.verifyMerge(coordinator, w.id, { executionId: second.execution.id }, { ...observation(w), prState: 'open', draft: false }, randomUUID());
  const committed = await engine.commitMerge(coordinator, w.id, { executionId: second.execution.id }, randomUUID());
  const renewed = await engine.execute(worker, 'heartbeat', w.id, { epoch: w.epoch }, randomUUID());
  assert.equal(renewed.mergeExecution?.id, second.execution.id, 'lease renewal cannot replace or cancel merge authority');
  assert.deepEqual(await engine.acquireMerge(coordinator, w.id, secondInput, secondKey), second, 'the coordinator can recover a lost acquire response after a heartbeat');
  const mergedAt = new Date(Math.ceil((Date.parse(committed.committingAt) + 1) / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
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
  w = await proven(w);
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  // The repository clock trails GitHub's by a measured five seconds. Nothing recorded after
  // this observation can recover that, so the delivery has to carry the instant itself:
  // every later repository-clock comparison - which reporting window a delivery falls in,
  // and how long it took from its append-only intent event - is otherwise off by the offset.
  const clockOffset = { min: -5000, max: -4000 };
  const verified = await engine.verifyMerge(coordinator, w.id, { executionId: granted.execution.id }, { ...observation(w), prState: 'open', draft: false, clockOffset }, randomUUID());
  const committed = await engine.commitMerge(coordinator, w.id, { executionId: granted.execution.id }, randomUUID());
  const mergedAt = new Date(Math.ceil((Date.parse(verified.verifiedAt) + 5001) / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  const delivered = await engine.observe(w.id, committed.revision, { ...observation(w), merged: true, mergeSha: 'c'.repeat(40), mergedAt } as Observation);
  assert.equal(delivered.stage, 'done');
  assert.equal(delivered.delivery?.mergedAt, mergedAt, 'the provider timestamp is kept exactly as GitHub reported it');
  assert.equal(delivered.delivery?.repositoryClockOffsetMs, clockOffset.min);
  // The lower bound of the measured offset: the earliest repository instant the merge can
  // have happened at, so a duration derived from it is never inflated by clock skew.
  assert.equal(delivered.delivery?.mergedAtRepository, new Date(Date.parse(mergedAt) + clockOffset.min).toISOString());
});
test('a matching merge from before the execution grant remains an unauthorized violation', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await proven(w);
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  const merged = { ...observation(w), merged: true, mergeSha: 'c'.repeat(40), mergedAt: new Date(Date.parse(granted.execution.issuedAt) - 1000).toISOString() } as Observation;
  const refused = await engine.observe(w.id, granted.revision, merged);
  assert.notEqual(refused.stage, 'done'); assert.equal(refused.mergeExecution, null); assert.match(refused.violations.join(' '), /without a prior authorization/);
});
test('a matching merge after the bounded execution deadline remains an unauthorized violation', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await proven(w);
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  const merged = { ...observation(w), merged: true, mergeSha: 'c'.repeat(40), mergedAt: new Date(Date.parse(granted.execution.expiresAt) + 1).toISOString() } as Observation;
  const refused = await engine.observe(w.id, granted.revision, merged);
  assert.notEqual(refused.stage, 'done'); assert.equal(refused.mergeExecution, null); assert.match(refused.violations.join(' '), /without a prior authorization/);
});
test('database clock ahead of GitHub cannot authorize a merge after the database deadline', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await proven(w);
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  const verified = await engine.verifyMerge(coordinator, w.id, { executionId: granted.execution.id }, { ...observation(w), prState: 'open', draft: false, clockOffset: { min: 5000, max: 6000 } }, randomUUID());
  const merged = { ...observation(w), merged: true, mergeSha: 'c'.repeat(40), mergedAt: new Date(Date.parse(granted.execution.expiresAt) - 4000).toISOString() };
  const refused = await engine.observe(w.id, verified.revision, merged);
  assert.notEqual(refused.stage, 'done'); assert.match(refused.violations.join(' '), /without a prior authorization/);
});
test('whole-second merge timestamps require authority through the entire reported interval', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await proven(w);
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  const lowerBound = Math.floor(Date.now() / 1000) * 1000 + 60_000; const expiresAt = new Date(lowerBound + 500).toISOString();
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{mergeExecution,expiresAt}',to_jsonb($2::text)) WHERE id=$1", [w.id, expiresAt]);
  const merged = { ...observation(w), merged: true, mergeSha: 'c'.repeat(40), mergedAt: new Date(lowerBound).toISOString().replace('.000Z', 'Z') } as Observation;
  const refused = await engine.observe(w.id, granted.revision, merged);
  assert.notEqual(refused.stage, 'done'); assert.match(refused.violations.join(' '), /without a prior authorization/);
});
test('a cancelled merge execution cannot authorize a later matching merge', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await proven(w);
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  await engine.cancelMerge(coordinator, w.id, { executionId: granted.execution.id, reason: 'GitHub refused this attempt' }, randomUUID());
  w = (await store.list()).find(item => item.id === w.id)!;
  const merged = { ...observation(w), merged: true, mergeSha: 'c'.repeat(40), mergedAt: new Date(Date.now() + 1000).toISOString() } as Observation;
  const refused = await engine.observe(w.id, w.revision, merged);
  assert.notEqual(refused.stage, 'done'); assert.match(refused.violations.join(' '), /without a prior authorization/);
});
test('a revoked candidate cannot be merged through the broker, including concurrent attempts and retries', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await proven(w);
  assert.equal(w.stage, 'merge'); assert.ok(w.gates.every(gate => gate.passed));
  const withdrawal = { proof: 'integration:claim-safety', sha: head, baseSha: base, policyRevision: w.policyRevision, reason: 'Reported run was attributed to the wrong artifact' };
  for (const [actor, expected] of [[worker, /operator or the trusted producer/], [coordinator, /operator or the trusted producer/], [otherProducer, /operator or the trusted producer/]] as const)
    await assert.rejects(engine.execute(actor, 'revoke', w.id, withdrawal, randomUUID()), expected);
  await assert.rejects(engine.execute(producer, 'revoke', w.id, { ...withdrawal, sha: 'd'.repeat(40) }, randomUUID()), /No trusted evidence matches/);
  const acquireKey = randomUUID(); const acquireInput = { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision };
  for (const actor of [worker, producer, otherProducer])
    await assert.rejects(engine.acquireMerge(actor, w.id, acquireInput, randomUUID()), /Coordinator permission/);
  const granted = await engine.acquireMerge(coordinator, w.id, acquireInput, acquireKey);
  // Fresh accepted runs stay frozen for the bounded execution; only withdrawal may interrupt it.
  await assert.rejects(engine.execute(producer, 'evidence', w.id, proof(), randomUUID()), /merge execution is active/i);
  const revoked = await engine.execute(producer, 'revoke', w.id, withdrawal, randomUUID());
  assert.equal(revoked.mergeExecution, null, 'revocation cancels the in-flight execution rather than waiting for it');
  assert.equal(revoked.mergeAuthorization, null); assert.equal(revoked.stage, 'acceptance');
  assert.match(revoked.gates.find(gate => gate.name === 'acceptance')!.reasons.join(' '), /previously accepted evidence was revoked/);
  assert.equal(revoked.queue, null, 'a withdrawn proof is an adverse conclusion: the entry leaves the queue instead of stalling it');
  assert.match(revoked.queueEjection!.reason, /integration:claim-safety was revoked on speculative tip/);
  assert.equal(revoked.evidence.at(-1)!.revocation?.actor, producer.id);
  assert.equal(revoked.evidence.at(-1)!.revocation?.reason, withdrawal.reason);
  assert.deepEqual(proofPreview(revoked).map(entry => entry.status), ['revoked']);
  const cancellation = (await store.events(w.id)).find(event => event.kind === 'merge.execution.cancelled');
  assert.equal(cancellation?.payload.details.executionId, granted.execution.id);
  await assert.rejects(engine.verifyMerge(coordinator, w.id, { executionId: granted.execution.id }, { ...observation(w), prState: 'open', draft: false }, randomUUID()), /missing, expired, superseded/);
  await assert.rejects(engine.acquireMerge(coordinator, w.id, acquireInput, acquireKey), /expired, cancelled, fenced, or superseded/);
  await assert.rejects(engine.cancelMerge(coordinator, w.id, { executionId: granted.execution.id, reason: 'Late cancel' }, randomUUID()), /missing, expired, superseded/);
  const current = (await store.list()).find(item => item.id === w.id)!;
  const retries = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => engine.acquireMerge(index % 2 ? coordinator : otherCoordinator, w.id,
    { expectedRevision: current.revision, sha: head, baseSha: base, policyRevision: current.policyRevision }, randomUUID())));
  assert.deepEqual(retries.map(result => result.status), Array.from({ length: 8 }, () => 'rejected'));
  for (const result of retries) assert.match((result as PromiseRejectedResult).reason.message, /Merge authorization is no longer current/);
  assert.equal((await store.list()).find(item => item.id === w.id)!.mergeExecution, null);
  // A provider merge that lands after the withdrawal is a visible violation, never delivery.
  const merged = { ...observation(w), merged: true, mergeSha: 'c'.repeat(40), mergedAt: new Date(Date.now() + 5000).toISOString() } as Observation;
  const refused = await engine.observe(w.id, current.revision, merged);
  assert.notEqual(refused.stage, 'done'); assert.match(refused.violations.join(' '), /without a prior authorization/);
  await assert.rejects(engine.execute(producer, 'revoke', w.id, withdrawal, randomUUID()), /No trusted evidence matches/);
});
test('revocation withdraws every accepted run for the candidate and republishes a refusing check', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await proven(w);
  w = await engine.execute(producer, 'evidence', w.id, { ...proof(), executed: 14 }, randomUUID());
  assert.equal(w.stage, 'merge');
  const withdrawal = { proof: 'integration:claim-safety', sha: head, baseSha: base, policyRevision: w.policyRevision, reason: 'Producer retracted both reported runs' };
  w = await engine.execute(producer, 'revoke', w.id, withdrawal, randomUUID());
  assert.equal(w.evidence.filter(item => item.revocation).length, 2, 'an older accepted run must not re-authorize the candidate');
  assert.equal(w.stage, 'acceptance'); assert.equal(w.mergeAuthorization, null);
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
  await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [w.id]);
  const published: Work[] = [];
  const adapter = { observe: async (item: Work) => observation(item), publish: async (item: Work) => { published.push(item); } } as unknown as GitHub;
  await processJob(engine, adapter);
  assert.equal(published.length, 1);
  assert.ok(published[0].gates.some(gate => !gate.passed), 'the published check must stop reporting success for a revoked candidate');
  // Revocation is not a dead end for the proof: a fresh accepted run satisfies acceptance again.
  // The merge queue treats the withdrawal like a failed proof, so the ejected commit itself does
  // not re-enter; a new candidate does, at the back of the queue.
  w = await proven(w);
  assert.ok(w.gates.find(gate => gate.name === 'acceptance')!.passed);
  assert.match(w.gates.find(gate => gate.name === 'merge')!.reasons.join(' '), /Ejected from the merge queue: Proof integration:claim-safety was revoked/);
  assert.equal(w.mergeAuthorization ?? null, null);
});
test('a committed merge execution outlives its expiry until GitHub reconciles the provider outcome', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await proven(w);
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  await engine.verifyMerge(coordinator, w.id, { executionId: granted.execution.id }, { ...observation(w), prState: 'open', draft: false }, randomUUID());
  const committed = await engine.commitMerge(coordinator, w.id, { executionId: granted.execution.id }, randomUUID());
  const expiresAt = new Date(Date.now() - 1000).toISOString();
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{mergeExecution,expiresAt}',to_jsonb($2::text)) WHERE id=$1", [w.id, expiresAt]);
  const withdrawal = { proof: 'integration:claim-safety', sha: head, baseSha: base, policyRevision: w.policyRevision, reason: 'Withdrawal after the authority lapsed' };
  // The provider call may still be in flight: withdrawal, competing mutations, a new execution and
  // periodic reconciliation all keep refusing until GitHub has been observed after the expiry.
  await assert.rejects(engine.execute(producer, 'revoke', w.id, withdrawal, randomUUID()), /already committed this candidate/);
  await assert.rejects(engine.execute(producer, 'evidence', w.id, proof(), randomUUID()), /committed this candidate to the provider; retry after GitHub reconciliation/);
  await assert.rejects(engine.acquireMerge(coordinator, w.id, { expectedRevision: committed.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID()), /awaits GitHub reconciliation/);
  await engine.reconcile();
  const retained = (await store.list()).find(item => item.id === w.id)!;
  assert.equal(retained.mergeExecution?.id, granted.execution.id, 'reconciliation never retires a committed execution');
  assert.equal(retained.mergeExecution?.expiresAt, expiresAt);
  const early = { ...observation(w), at: new Date(Date.parse(expiresAt) - 500).toISOString() };
  await assert.rejects(engine.observe(w.id, retained.revision, early), /awaits an observation taken after its authority expired/);
  assert.equal((await store.list()).find(item => item.id === w.id)!.mergeExecution?.id, granted.execution.id, 'an unmerged reading from inside the authority does not rule the provider merge out');
  const settled = await engine.observe(w.id, retained.revision, observation(w));
  assert.equal(settled.mergeExecution, null, 'an unmerged observation after expiry reconciles the execution');
  assert.notEqual(settled.stage, 'done');
  // The record reopens only now: the withdrawal succeeds and a merge landing afterwards is a violation.
  const revoked = await engine.execute(producer, 'revoke', w.id, withdrawal, randomUUID());
  assert.ok(revoked.evidence.some(item => item.revocation)); assert.equal(revoked.stage, 'acceptance');
  const late = { ...observation(w), merged: true, mergeSha: 'c'.repeat(40), mergedAt: new Date().toISOString() } as Observation;
  const refused = await engine.observe(w.id, revoked.revision, late);
  assert.notEqual(refused.stage, 'done'); assert.match(refused.violations.join(' '), /without a prior authorization/);
});
test('a retained committed execution still attributes the merge that landed inside its authority', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await proven(w);
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  await engine.verifyMerge(coordinator, w.id, { executionId: granted.execution.id }, { ...observation(w), prState: 'open', draft: false }, randomUUID());
  const committed = await engine.commitMerge(coordinator, w.id, { executionId: granted.execution.id }, randomUUID());
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  // The authority lapses on the record after the provider merged but before GitHub was observed.
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{mergeExecution,expiresAt}',to_jsonb($2::text)) WHERE id=$1", [w.id, new Date(Date.now() + 5).toISOString()]);
  await delay(10);
  await assert.rejects(engine.execute(producer, 'revoke', w.id, { proof: 'integration:claim-safety', sha: head, baseSha: base, policyRevision: w.policyRevision, reason: 'Raced the observation' }, randomUUID()), /already committed this candidate/);
  const delivered = await engine.observe(w.id, committed.revision, { ...observation(w), merged: true, mergedAt, mergeSha: 'a'.repeat(40) });
  assert.equal(delivered.stage, 'done'); assert.equal(delivered.mergeExecution, null);
  assert.equal(delivered.delivery?.authorizationRevision, granted.execution.authorizationRevision);
});
test('reconciliation defers a lapsed committed execution until an observation from after its expiry', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await proven(w);
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  await engine.verifyMerge(coordinator, w.id, { executionId: granted.execution.id }, { ...observation(w), prState: 'open', draft: false }, randomUUID());
  await engine.commitMerge(coordinator, w.id, { executionId: granted.execution.id }, randomUUID());
  const expiresAt = new Date(Date.now() - 1000).toISOString();
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{mergeExecution,expiresAt}',to_jsonb($2::text)) WHERE id=$1", [w.id, expiresAt]);
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
  await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [w.id]);
  let publications = 0; let at = new Date(Date.parse(expiresAt) - 500).toISOString();
  const adapter = { observe: async (current: Work) => ({ ...observation(current), at }), publish: async () => { publications++; } } as unknown as GitHub;
  await processJob(engine, adapter);
  const deferred = (await store.pool.query('SELECT error,token,available_at FROM jobs WHERE work_id=$1', [w.id])).rows[0];
  assert.equal(publications, 0); assert.equal(deferred.error, null); assert.equal(deferred.token, null);
  assert.ok(deferred.available_at.getTime() <= Date.now(), 'the lapsed authority makes the next observation due immediately');
  assert.equal((await store.list()).find(item => item.id === w.id)!.mergeExecution?.id, granted.execution.id);
  at = new Date().toISOString();
  await processJob(engine, adapter);
  const reconciled = (await store.list()).find(item => item.id === w.id)!;
  assert.equal(reconciled.mergeExecution, null); assert.equal(publications, 1);
  assert.equal((await store.pool.query('SELECT error FROM jobs WHERE work_id=$1', [w.id])).rows[0].error, null);
});
test('delivered work refuses revocation and keeps its authorized delivery record', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await proven(w);
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  const verified = await engine.verifyMerge(coordinator, w.id, { executionId: granted.execution.id }, { ...observation(w), prState: 'open', draft: false }, randomUUID());
  const committed = await engine.commitMerge(coordinator, w.id, { executionId: granted.execution.id }, randomUUID());
  const tooLate = { proof: 'integration:claim-safety', sha: head, baseSha: base, policyRevision: w.policyRevision, reason: 'Withdrawal raced the provider call' };
  await assert.rejects(engine.execute(producer, 'revoke', w.id, tooLate, randomUUID()), /already committed this candidate/);
  assert.equal((await store.list()).find(item => item.id === w.id)!.evidence.some(item => item.revocation), false);
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  const delivered = await engine.observe(w.id, committed.revision, { ...observation(w), merged: true, mergedAt, mergeSha: 'a'.repeat(40) });
  assert.equal(delivered.stage, 'done');
  await assert.rejects(engine.execute(producer, 'revoke', w.id, { proof: 'integration:claim-safety', sha: head, baseSha: base, policyRevision: w.policyRevision, reason: 'Too late to withdraw' }, randomUUID()), /immutable/);
  const reloaded = (await store.list()).find(item => item.id === w.id)!;
  assert.equal(reloaded.stage, 'done'); assert.ok(reloaded.delivery);
  assert.equal(reloaded.evidence.some(item => item.revocation), false);
});
test('the trusted merge-authorization contract passes against this build', async () => {
  const principals = mergeAuthorizationPrincipals(); let snapshot: Observation | null = null;
  const probeStore = new Store(store.pool.options.connectionString!); const probeEngine = new Engine(probeStore, [15368], 120, 'graphyard-probe/candidate');
  const probeHttp = server(probeEngine, principals, { config: { repository: 'graphyard-probe/candidate', base: 'main', appId: 1, installationId: 1, privateKey: '' }, verify: async () => structuredClone(snapshot), serverTime: async () => Date.now(), reviewRepository: async () => null, reviewPermissions: async () => ({}) } as any);
  await new Promise<void>(resolve => probeHttp.listen(0, '127.0.0.1', resolve));
  try {
    const probeUrl = `http://127.0.0.1:${(probeHttp.address() as any).port}`;
    const transcript = await probeMergeAuthorization({ url: probeUrl, principals, observeCandidate: async (item: Work, observed: Observation, speculation?: QueueSpeculation) => {
      snapshot = observed;
      if (speculation) await probeStore.pool.query("UPDATE work_items SET document=jsonb_set(document,'{queue,speculation}',$2::jsonb) WHERE id=$1", [item.id, JSON.stringify(speculation)]);
      return probeEngine.observe(item.id, item.revision, observed);
    } });
    assert.deepEqual(judgeMergeAuthorization(transcript), mergeAuthorizationCases.map((id: string) => ({ id, result: 'pass' })));
  } finally { await new Promise<void>(resolve => probeHttp.close(() => resolve())); await probeStore.close(); }
});
test('periodic reconciliation defers without publishing failure during active merge execution', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await proven(w);
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
  w = await proven(w);
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
  w = await proven(w);
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
  w = await proven(w); assert.equal(w.stage, 'merge');
  const obs = observation(w); obs.candidate.sha = 'f'.repeat(40); obs.reviews[0].sha = obs.candidate.sha;
  w = await engine.observe(w.id, w.revision, obs); assert.equal(w.stage, 'acceptance');
});
test('latest failed evidence supersedes previous passing evidence', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await proven(w); assert.equal(w.stage, 'merge');
  w = await engine.execute(producer, 'evidence', w.id, { ...proof(), result: 'fail' }, randomUUID()); assert.equal(w.stage, 'acceptance');
});
test('legacy evidence URL remains valid and typed external artifacts do not change trust', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, { ...proof(), url: 'https://reports.example.test/legacy' }, randomUUID());
  assert.equal(w.evidence.at(-1)?.url, 'https://reports.example.test/legacy'); assert.equal(w.evidence.at(-1)?.trusted, true);
  w = await engine.execute(producer, 'evidence', w.id, { ...proof(), artifacts: [{ kind: 'trace', label: 'browser trace', mediaType: 'application/zip', size: 42, digest: `sha256:${'a'.repeat(64)}`, availability: 'external', url: 'https://reports.example.test/trace' }] }, randomUUID());
  assert.equal(w.evidence.at(-1)?.artifacts?.[0].kind, 'trace'); assert.equal(w.evidence.at(-1)?.trusted, true);
  await assert.rejects(engine.execute(producer, 'evidence', w.id, { ...proof(), artifacts: [{ kind: 'report', label: 'unsafe', availability: 'external', url: 'https://user:secret@reports.example.test/report' }] }, randomUUID()), /no credentials/);
});
test('redacted evidence artifact descriptors remain explicit and expose no read target', async () => {
  let w = await submitted();
  w = await engine.execute(producer, 'evidence', w.id, { ...proof(), artifacts: [{
    kind: 'screenshot', label: 'Sensitive screenshot withheld', mediaType: 'image/png',
    digest: `sha256:${'b'.repeat(64)}`, availability: 'redacted',
  }] }, randomUUID());
  assert.deepEqual(w.evidence.at(-1)?.artifacts, [{
    kind: 'screenshot', label: 'Sensitive screenshot withheld', mediaType: 'image/png',
    digest: `sha256:${'b'.repeat(64)}`, availability: 'redacted',
  }]);
  assert.equal(w.evidence.at(-1)?.artifacts?.[0].url, undefined);
  assert.equal(w.evidence.at(-1)?.artifacts?.[0].reference, undefined);
});
test('wrong CI producer, self review, and missing protection fail closed', async () => {
  let w = await submitted(); let obs = observation(w); obs.reviews[0].reviewer = obs.candidate.author;
  w = await engine.observe(w.id, w.revision, obs); assert.equal(w.stage, 'review');
  obs = observation(w); obs.checks[0].appId = 999; w = await engine.observe(w.id, w.revision, obs); assert.equal(w.stage, 'test');
  obs = observation(w); obs.protected = false; w = await engine.observe(w.id, w.revision, obs);
  w = await proven(w, { ...observation(w), protected: false }); assert.equal(w.stage, 'merge'); assert.equal(w.gates.find(g => g.name === 'merge')!.passed, false);
});
test('only an independently observed merge with a verified execution completes work', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await proven(w); assert.equal(w.stage, 'merge');
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  const verified = await engine.verifyMerge(coordinator, w.id, { executionId: granted.execution.id }, { ...observation(w), prState: 'open', draft: false }, randomUUID());
  const committed = await engine.commitMerge(coordinator, w.id, { executionId: granted.execution.id }, randomUUID());
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  w = await engine.observe(w.id, committed.revision, { ...observation(w), merged: true, mergedAt, mergeSha: 'e'.repeat(40) }); assert.equal(w.stage, 'done');
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
    await clearQueue(item.id);
    item = await engine.observe(item.id, item.revision, observation(item));
    item = await proven(item);
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
  await clearQueue(w.id);
  w = await engine.observe(w.id, w.revision, observation(w));
  w = await proven(w);
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
  await clearQueue(w.id);
  w = await engine.observe(w.id, w.revision, observation(w));
  w = await proven(w);
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  const verified = await engine.verifyMerge(coordinator, w.id, { executionId: granted.execution.id }, { ...observation(w), prState: 'open', draft: false }, randomUUID());
  const committed = await engine.commitMerge(coordinator, w.id, { executionId: granted.execution.id }, randomUUID());
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  const merged = { ...observation(w), merged: true, mergedAt, mergeSha: 'f'.repeat(40) } as Observation;
  let current = await engine.observe(w.id, committed.revision, merged);
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
  await clearQueue(w.id);
  w = await engine.observe(w.id, w.revision, observation(w));
  w = await proven(w);
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  const verified = await engine.verifyMerge(coordinator, w.id, { executionId: granted.execution.id }, { ...observation(w), prState: 'open', draft: false }, randomUUID());
  const committed = await engine.commitMerge(coordinator, w.id, { executionId: granted.execution.id }, randomUUID());
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  w = await engine.observe(w.id, committed.revision, { ...observation(w), merged: true, mergedAt, mergeSha: '9'.repeat(40) });
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
  w = await proven(w); assert.notEqual(w.stage, 'done');
});
test('evidence arriving after the actual merge cannot retroactively authorize it', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  const actualMerge = '2000-01-01T00:00:00Z';
  w = await proven(w); assert.ok(w.mergeAuthorization);
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
  await clearQueue(w.id);
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
  w = await proven(w);
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  const verified = await engine.verifyMerge(coordinator, w.id, { executionId: granted.execution.id }, { ...observation(w), prState: 'open', draft: false }, randomUUID());
  await engine.commitMerge(coordinator, w.id, { executionId: granted.execution.id }, randomUUID());
  const authorizedRevision = granted.execution.authorizationRevision;
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{mergeExecution,expiresAt}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=$1", [w.id]);
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{observation,at}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=$1", [w.id]);
  await engine.reconcile();
  w = (await store.list()).find(item => item.id === w.id)!;
  // The lapsed authority was committed to the provider, so the record stays frozen until GitHub
  // answers for it; a reading from after the expiry that has not yet caught up with the merge
  // reconciles the execution, and only then can the failing run be recorded.
  await assert.rejects(engine.execute(producer, 'evidence', w.id, { ...proof(), result: 'fail' }, randomUUID()), /retry after GitHub reconciliation/);
  w = await engine.observe(w.id, w.revision, observation(w)); assert.equal(w.mergeExecution, null);
  w = await engine.execute(producer, 'evidence', w.id, { ...proof(), result: 'fail' }, randomUUID());
  assert.equal(w.mergeAuthorization, null);
  w = await engine.observe(w.id, w.revision, { ...observation(w), merged: true, mergedAt, mergeSha: 'e'.repeat(40) });
  assert.equal(w.stage, 'done'); assert.equal(w.delivery?.authorizationRevision, authorizedRevision);
  assert.ok(w.violations.some(v => v.includes('Post-merge')));
});

test('whole-second merge timestamps do not accept same-second backfilled authorization', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await proven(w);
  const mergedAt = w.mergeAuthorization!.at.replace(/\.\d+Z$/, 'Z');
  w = await engine.observe(w.id, w.revision, { ...observation(w), merged: true, mergedAt, mergeSha: 'e'.repeat(40) });
  assert.notEqual(w.stage, 'done');
});

test('integration publication discards a passing snapshot superseded by failed evidence', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await proven(w);
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
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w)); w = await proven(w);
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
  w = await proven(w);
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  const verified = await engine.verifyMerge(coordinator, w.id, { executionId: granted.execution.id }, { ...observation(w), prState: 'open', draft: false }, randomUUID());
  await engine.commitMerge(coordinator, w.id, { executionId: granted.execution.id }, randomUUID());
  const authorizedRevision = granted.execution.authorizationRevision;
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{mergeExecution,expiresAt}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=$1", [w.id]);
  await engine.reconcile();
  w = (await store.list()).find(item => item.id === w.id)!;
  // The committed execution holds the record past its expiry until a post-expiry reading reconciles it.
  await assert.rejects(engine.execute(operator, 'reviewpolicy', w.id, { provider: 'codex', expectedPolicyRevision: 1, reason: 'Merge not observed yet' }, randomUUID()), /retry after GitHub reconciliation/);
  w = await engine.observe(w.id, w.revision, observation(w)); assert.equal(w.mergeExecution, null);
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
  w = await proven(w);
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
  w = await proven(w);
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

// Post-deployment smoke proof: trunk stays the only pre-merge gate, and the second confidence
// layer binds to the exact commit Graphyard observed serving the merge.
const smokeProducer: Principal = { id: 'smoke-runner', role: 'producer', proofs: ['e2e:deploy-smoke', 'integration:claim-safety'] };
const mergeSha = 'e'.repeat(40), servingSha = 'f'.repeat(40);
async function deliveredWithSmokePolicy() {
  let w = await engine.execute(operator, 'create', null, { ...workInput, policy: { checks: ['test', 'typecheck'], review: true, deploySmoke: true } }, randomUUID());
  w = await engine.execute(operator, 'ready', w.id, {}, randomUUID());
  w = await engine.execute(worker, 'claim', w.id, {}, randomUUID());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'machine-a', path: `/tmp/${w.id}`, branch: `graphyard/${w.id}` }, randomUUID());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: Number(w.key.slice(3)) }, randomUUID());
  await clearQueue(w.id);
  w = await engine.observe(w.id, w.revision, observation(w));
  // The smoke policy changes nothing before the merge: the ordinary proof still takes it to merge.
  w = await proven(w); assert.equal(w.stage, 'merge', 'deploySmoke never adds a pre-merge gate');
  assert.ok(w.gates.every(gate => gate.passed));
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, randomUUID());
  await engine.verifyMerge(coordinator, w.id, { executionId: granted.execution.id }, { ...observation(w), prState: 'open', draft: false }, randomUUID());
  const committed = await engine.commitMerge(coordinator, w.id, { executionId: granted.execution.id }, randomUUID());
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  w = await engine.observe(w.id, committed.revision, { ...observation(w), merged: true, mergedAt, mergeSha }); assert.equal(w.stage, 'done');
  return w;
}
const smoke = (sha: string, baseSha: string, result: 'pass' | 'fail' = 'pass', extra: Record<string, unknown> = {}) => ({ proof: 'e2e:deploy-smoke', sha, baseSha, policyRevision: 1, result, executed: 3, skipped: 0, ...extra });

test('deploy-smoke evidence binds to the observed deployed commit, is accepted only from an authorized producer, and lands in the delivery snapshot', async () => {
  await assert.rejects(engine.execute(operator, 'create', null, { ...workInput, criteria: [{ id: 'AC-1', text: 'Smoke', proofs: ['e2e:deploy-smoke'] }] }, randomUUID()), /policy\.deploySmoke/, 'the post-deploy proof is a policy, never a merge criterion');
  let w = await deliveredWithSmokePolicy();
  assert.equal(deliveryState(w), 'awaiting-deployment');
  const observed = new Date().toISOString();
  // Nobody may report smoke before Graphyard has observed the deployment, whoever they are.
  await assert.rejects(engine.execute(smokeProducer, 'evidence', w.id, smoke(mergeSha, mergeSha), randomUUID()), /has not observed a deployment/);
  // Only the coordinator (or an operator) records a deployment observation, only for delivered work, only for this merge.
  await assert.rejects(engine.execute(worker, 'deployment', w.id, { sha: mergeSha, mergeSha, source: 'endpoint', observedAt: observed }, randomUUID()), /Coordinator permission/);
  await assert.rejects(engine.execute(producer, 'deployment', w.id, { sha: mergeSha, mergeSha, source: 'endpoint', observedAt: observed }, randomUUID()), /Coordinator permission/);
  await assert.rejects(engine.execute(coordinator, 'deployment', w.id, { sha: mergeSha, mergeSha: head, source: 'endpoint', observedAt: observed }, randomUUID()), /another merge commit/);
  const open = await submitted();
  await assert.rejects(engine.execute(coordinator, 'deployment', open.id, { sha: mergeSha, mergeSha, source: 'endpoint', observedAt: observed }, randomUUID()), /only for delivered work/);
  w = await engine.execute(coordinator, 'deployment', w.id, { sha: mergeSha, mergeSha, source: 'endpoint', observedAt: observed }, randomUUID());
  assert.equal(w.stage, 'done'); assert.equal(w.delivery!.deployment!.covers, 'exact'); assert.equal(w.delivery!.deployment!.observer, coordinator.id);
  assert.equal(deliveryState(w), 'awaiting-smoke');
  await assert.rejects(engine.execute(coordinator, 'deployment', w.id, { sha: servingSha, mergeSha, source: 'endpoint', observedAt: observed }, randomUUID()), /already has a recorded deployment/);
  // Authorization: a worker, an operator, and a producer without the grant are all refused outright; nothing untrusted is stored.
  await assert.rejects(engine.execute(worker, 'evidence', w.id, smoke(mergeSha, mergeSha), randomUUID()), /only from a producer authorized/);
  await assert.rejects(engine.execute(operator, 'evidence', w.id, smoke(mergeSha, mergeSha), randomUUID()), /only from a producer authorized/);
  await assert.rejects(engine.execute(producer, 'evidence', w.id, smoke(mergeSha, mergeSha), randomUUID()), /only from a producer authorized/);
  // Binding: the evidence must name the observed deployed commit and this item's merge commit.
  await assert.rejects(engine.execute(smokeProducer, 'evidence', w.id, smoke(head, mergeSha), randomUUID()), /must name the observed deployed commit/);
  await assert.rejects(engine.execute(smokeProducer, 'evidence', w.id, smoke(mergeSha, head), randomUUID()), /must name the observed deployed commit/);
  await assert.rejects(engine.execute(smokeProducer, 'evidence', w.id, smoke(mergeSha, mergeSha, 'pass', { policyRevision: 2 }), randomUUID()), /Policy revision/);
  assert.equal((await reload(w)).evidence.filter(e => e.proof === 'e2e:deploy-smoke').length, 0, 'refused smoke evidence is never stored');
  const before = structuredClone(w.delivery);
  w = await engine.execute(smokeProducer, 'evidence', w.id, smoke(mergeSha, mergeSha, 'pass', { url: 'https://github.com/owner/project/actions/runs/7' }), randomUUID());
  assert.equal(w.stage, 'done'); assert.equal(deliveryState(w), 'smoke-passed');
  const { smoke: _smoke, ...mergeFacts } = w.delivery!;
  assert.deepEqual(mergeFacts, before, 'merge facts in the delivery snapshot are untouched');
  assert.equal(w.delivery!.smoke!.sha, mergeSha); assert.equal(w.delivery!.smoke!.mergeSha, mergeSha); assert.equal(w.delivery!.smoke!.producer, smokeProducer.id);
  assert.equal(w.delivery!.smoke!.evidenceId, w.evidence.find(e => e.proof === 'e2e:deploy-smoke')!.id);
  assert.ok(w.gates.every(gate => gate.passed), 'post-deployment facts never re-evaluate the delivered gates');
  assert.equal((await store.pool.query('SELECT 1 FROM jobs WHERE work_id=$1', [w.id])).rowCount, 0, 'delivered work does not re-enter integration reconciliation');
  const history = (await store.events(w.id)).map(e => e.kind);
  assert.ok(history.includes('deployment') && history.includes('evidence'));
  // A delivery without the policy keeps the ordinary immutability and refuses the smoke proof.
  const plain = await (async () => { let item = await submitted(); item = await engine.observe(item.id, item.revision, observation(item)); item = await proven(item);
    const g = await engine.acquireMerge(coordinator, item.id, { expectedRevision: item.revision, sha: head, baseSha: base, policyRevision: item.policyRevision }, randomUUID());
    await engine.verifyMerge(coordinator, item.id, { executionId: g.execution.id }, { ...observation(item), prState: 'open', draft: false }, randomUUID());
    const c = await engine.commitMerge(coordinator, item.id, { executionId: g.execution.id }, randomUUID());
    await delay(5); const at = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
    return engine.observe(item.id, c.revision, { ...observation(item), merged: true, mergedAt: at, mergeSha }); })();
  assert.equal(deliveryState(plain), 'delivered');
  const recorded = await engine.execute(coordinator, 'deployment', plain.id, { sha: mergeSha, mergeSha, source: 'github-deployment', observedAt: new Date().toISOString() }, randomUUID());
  assert.equal(recorded.delivery!.deployment!.source, 'github-deployment', 'deployment observations are recorded for every delivery; the smoke policy decides what they gate');
  await assert.rejects(engine.execute(smokeProducer, 'evidence', plain.id, smoke(mergeSha, mergeSha), randomUUID()), /does not require e2e:deploy-smoke/);
  await assert.rejects(engine.execute(worker, 'claim', plain.id, {}, randomUUID()), /immutable/);
});

test('a failed deploy-smoke proof is delivered-with-failure with rollback guidance in master status, and counts as post-deploy time in flow analytics', async () => {
  let w = await deliveredWithSmokePolicy();
  const observedAt = new Date().toISOString();
  // A descendant rollout still covers the merge; the smoke result binds to that serving commit.
  w = await engine.execute(coordinator, 'deployment', w.id, { sha: servingSha, mergeSha, source: 'endpoint', observedAt }, randomUUID());
  assert.equal(w.delivery!.deployment!.covers, 'descendant');
  await assert.rejects(engine.execute(smokeProducer, 'evidence', w.id, smoke(mergeSha, mergeSha, 'fail'), randomUUID()), /must name the observed deployed commit/);
  await delay(5);
  w = await engine.execute(smokeProducer, 'evidence', w.id, smoke(servingSha, mergeSha, 'fail', { url: 'https://github.com/owner/project/actions/runs/8' }), randomUUID());
  assert.equal(w.stage, 'done', 'delivery history is never rewritten by a later failure');
  assert.equal(deliveryState(w), 'delivered-with-failure');
  assert.deepEqual(w.violations, [], 'a failed smoke proof is a recorded outcome, not a merge-bypass violation');
  const guidance = rollbackGuidance(w, 'main')!;
  assert.match(guidance, new RegExp(`${w.key} is delivered with a failed post-deployment smoke proof`));
  assert.ok(guidance.includes(servingSha) && guidance.includes(mergeSha) && /revert .* on main/.test(guidance) && /Do not backfill/.test(guidance));
  const snapshot = await store.workSnapshot();
  const status = buildMasterStatus(snapshot, [], [], {}, {}, { pending: [], completed: [] }, 'main');
  const row = status.delivered.find(entry => entry.key === w.key)!;
  assert.equal(row.state, 'delivered-with-failure'); assert.equal(row.rollback, guidance); assert.equal(row.smoke!.result, 'fail'); assert.equal(row.deployment!.sha, servingSha);
  assert.ok(status.counts.postDeployFailures >= 1);
  assert.ok(row.postDeployMs! > 0 && row.productionLatencyMs! > 0);
  assert.equal(status.work.some(entry => entry.key === w.key), false, 'delivered work stays out of the open ledger');
  const metrics = stageMetrics(snapshot.work, Date.parse(snapshot.now));
  assert.ok(metrics.postDeployFailures >= 1); assert.ok(metrics.postDeploy.count >= 1 && metrics.postDeploy.p90Ms > 0); assert.ok(metrics.production.count >= 1);
  // A later pass at the same deployed commit supersedes the verdict; the failure stays in the ledger.
  w = await engine.execute(smokeProducer, 'evidence', w.id, smoke(servingSha, mergeSha, 'pass'), randomUUID());
  assert.equal(deliveryState(w), 'smoke-passed'); assert.equal(w.evidence.filter(e => e.proof === 'e2e:deploy-smoke').length, 2);
});

const sha40 = (label: string) => label.padEnd(40, '0');
function tip(w: Work, candidate: { sha: string; baseSha: string }, extra: Partial<Observation> = {}): Observation {
  return { clockOffset: { min: 0, max: 0 },
    candidate: { ...candidate, pr: w.submission!.pr, branch: w.workspaces.at(-1)!.branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews: [{ reviewer: 'reviewer', sha: candidate.sha, state: 'APPROVED' }], protected: true, mergeable: true,
    merged: false, mergeSha: null, prState: 'open', draft: false, baseTip: candidate.baseSha,
    files: ['src/engine.ts'], scopeFiles: [], at: new Date().toISOString(), ...extra };
}
async function validated(w: Work, candidate: { sha: string; baseSha: string }, extra: Partial<Observation> = {}) {
  const observed = await engine.observe(w.id, w.revision, tip(w, candidate, extra));
  return engine.execute(producer, 'evidence', observed.id, { ...proof(), sha: candidate.sha, baseSha: candidate.baseSha }, randomUUID());
}
async function reload(w: Work) { return (await store.list()).find(item => item.id === w.id)!; }
async function placementOf(w: Work) { return predictQueue(await store.list(), Date.now()).find(entry => entry.id === w.id)!; }
async function onlyJob(w: Work) {
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
  await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [w.id]);
}
function queueAdapter(observation: (w: Work) => Observation, speculation: (w: Work, placement: QueuePlacement) => QueueSpeculation, seen: { key: string; base: string | null; predecessors: string[] }[] = []) {
  return { seen, adapter: {
    observe: async (w: Work) => observation(w),
    publishSpeculativeTip: async (w: Work, placement: QueuePlacement) => {
      seen.push({ key: w.key, base: placement.predictedBase, predecessors: placement.predecessors });
      return speculation(w, placement);
    },
    publish: async () => { throw new Error('the replaced head must not receive a check publication'); },
  } as unknown as GitHub };
}
const predicted = (w: Work, placement: QueuePlacement, tipSha: string, baseTree: string): QueueSpeculation =>
  ({ ref: queueRef(w.key), tip: tipSha, base: placement.predictedBase!, baseTree, predecessors: placement.predecessors, policyRevision: w.policyRevision, publishedAt: new Date().toISOString() });
/**
 * Graphyard publishes a tip for every entry, the head included: publication is what proves the
 * validated commit already contains its base. A branch that already sits on its predicted base
 * publishes its own head, so nothing is rebuilt and nothing is revalidated.
 */
async function publishTip(w: Work, observed: { sha: string; baseSha: string }, tipSha: string, baseTree: string, extra: Partial<Observation> = {}) {
  await onlyJob(w);
  const run = queueAdapter(item => tip(item, observed, extra), (item, placement) => predicted(item, placement, tipSha, baseTree));
  await processJob(engine, run.adapter);
  return run.seen;
}

test('a queued candidate is validated on the speculative tip it will land, and an earlier merge does not invalidate it', async () => {
  const main = sha40('a1'), firstHead = sha40('a2'), secondHead = sha40('a3'), secondTip = sha40('a4'), mainTree = sha40('a5'), mergeSha = sha40('a6');
  let first = await submitted(), second = await submitted();
  first = await validated(first, { sha: firstHead, baseSha: main });
  second = await validated(second, { sha: secondHead, baseSha: main });
  assert.equal((await placementOf(first)).current, false, 'nothing lands until Graphyard has published the tip for it');
  assert.deepEqual(await publishTip(first, { sha: firstHead, baseSha: main }, firstHead, mainTree), [{ key: first.key, base: main, predecessors: [] }]);
  first = await reload(first);
  assert.equal(first.queue!.speculation!.tip, firstHead, 'a branch already on its predicted base publishes its own head as the tip');
  const head = await placementOf(first), behind = await placementOf(second);
  assert.equal(head.position, 0); assert.equal(head.predictedBase, main); assert.equal(head.current, true);
  assert.equal(behind.position, 1); assert.equal(behind.predictedBase, firstHead, 'the entry behind predicts against the tip the head will land');
  assert.equal(behind.current, false);
  second = await reload(second);
  assert.equal(second.mergeAuthorization, null);
  assert.match(second.gates.find(gate => gate.name === 'merge')!.reasons.join(' '), /position 2 of 2/);

  await onlyJob(second);
  const { seen, adapter } = queueAdapter(w => tip(w, { sha: secondHead, baseSha: main }), (w, placement) => predicted(w, placement, secondTip, mainTree));
  await processJob(engine, adapter);
  assert.deepEqual(seen, [{ key: second.key, base: firstHead, predecessors: [first.key] }]);
  second = await reload(second);
  assert.equal(second.queue!.speculation!.tip, secondTip);
  assert.equal(second.queue!.speculation!.ref, `refs/graphyard/queue/${second.key.toLowerCase()}`);
  assert.equal((await store.events(second.id)).filter(event => event.kind === 'queue.predicted').length, 1);

  second = await engine.observe(second.id, second.revision, tip(second, { sha: secondTip, baseSha: firstHead }, { baseTip: main, reviews: [{ reviewer: 'reviewer', sha: secondHead, state: 'APPROVED' }] }));
  assert.equal(second.candidate!.baseSha, firstHead, 'the candidate binds to the predicted base rather than the base branch');
  assert.equal(second.gates.find(gate => gate.name === 'review')!.passed, false, 'approval of the replaced head does not approve the speculative tip');
  assert.equal(second.gates.find(gate => gate.name === 'acceptance')!.passed, false, 'proof of the replaced head does not prove the speculative tip');
  second = await validated(second, { sha: secondTip, baseSha: firstHead }, { baseTip: main });
  assert.equal(second.gates.find(gate => gate.name === 'acceptance')!.passed, true);
  assert.match(second.gates.find(gate => gate.name === 'merge')!.reasons.join(' '), /position 2 of 2/, 'a fully validated entry still waits its turn');

  first = await reload(first);
  const granted = await engine.acquireMerge(coordinator, first.id, { expectedRevision: first.revision, sha: firstHead, baseSha: main, policyRevision: first.policyRevision }, randomUUID());
  await engine.verifyMerge(coordinator, first.id, { executionId: granted.execution.id }, tip(first, { sha: firstHead, baseSha: main }), randomUUID());
  const committed = await engine.commitMerge(coordinator, first.id, { executionId: granted.execution.id }, randomUUID());
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  first = await engine.observe(first.id, committed.revision, tip(first, { sha: firstHead, baseSha: main }, { merged: true, mergeSha, mergedAt }));
  assert.equal(first.stage, 'done');

  second = await reload(second);
  const evidenceBefore = second.evidence.length;
  second = await engine.observe(second.id, second.revision, tip(second, { sha: secondTip, baseSha: firstHead }, { baseTip: mergeSha, baseTree: mainTree }));
  assert.equal((await placementOf(second)).position, 0);
  assert.equal(second.evidence.length, evidenceBefore, 'no new proof was required after the merge ahead of it');
  assert.ok(second.gates.every(gate => gate.passed), second.gates.flatMap(gate => gate.reasons).join('; '));
  assert.equal(second.mergeAuthorization!.sha, secondTip);
  assert.equal(second.mergeAuthorization!.baseSha, firstHead);
});

test('main advancing outside the queue re-validates the head and re-bases the entries behind it without rework', async () => {
  const main = sha40('b1'), firstHead = sha40('b2'), secondHead = sha40('b3'), secondTip = sha40('b4'), mainTree = sha40('b5');
  const outside = sha40('b6'), outsideTree = sha40('b7'), firstTip = sha40('b8'), secondRebase = sha40('b9');
  let first = await submitted(), second = await submitted();
  first = await validated(first, { sha: firstHead, baseSha: main });
  second = await validated(second, { sha: secondHead, baseSha: main });
  await publishTip(first, { sha: firstHead, baseSha: main }, firstHead, mainTree);
  first = await reload(first);
  await onlyJob(second);
  const initial = queueAdapter(w => tip(w, { sha: secondHead, baseSha: main }), (w, placement) => predicted(w, placement, secondTip, mainTree));
  await processJob(engine, initial.adapter);
  second = await validated(await reload(second), { sha: secondTip, baseSha: firstHead }, { baseTip: main });
  assert.ok(second.queue!.speculation);

  // Someone lands a commit on the managed branch outside the queue.
  first = await engine.observe(first.id, (await reload(first)).revision, tip(first, { sha: firstHead, baseSha: main }, { baseTip: outside, baseTree: outsideTree }));
  assert.equal(first.mergeAuthorization, null, 'the stale binding is refused, not reused');
  assert.match(first.gates.find(gate => gate.name === 'merge')!.reasons.join(' '), /Speculative tip on predicted base/);
  const waiting = await placementOf(second);
  assert.equal(waiting.predictedBase, null); assert.equal(waiting.publishable, false);
  assert.match(waiting.reasons.at(-1)!, /Waiting for .* to publish its speculative tip/, 'only the queue head is re-validated against the new base');
  assert.equal((await placementOf(first)).publishable, true);

  await onlyJob(first);
  const headRun = queueAdapter(w => tip(w, { sha: firstHead, baseSha: main }, { baseTip: outside, baseTree: outsideTree }), (w, placement) => predicted(w, placement, firstTip, outsideTree));
  await processJob(engine, headRun.adapter);
  assert.deepEqual(headRun.seen, [{ key: first.key, base: outside, predecessors: [] }]);
  first = await validated(await reload(first), { sha: firstTip, baseSha: outside }, { baseTip: outside });
  assert.ok(first.gates.every(gate => gate.passed));

  const rebased = await placementOf(second);
  assert.equal(rebased.predictedBase, firstTip, 'the entry behind is re-predicted onto the new head tip');
  assert.equal(rebased.publishable, true);
  await onlyJob(second);
  const behindRun = queueAdapter(w => tip(w, { sha: secondTip, baseSha: firstHead }, { baseTip: outside }), (w, placement) => predicted(w, placement, secondRebase, outsideTree));
  await processJob(engine, behindRun.adapter);
  assert.deepEqual(behindRun.seen, [{ key: second.key, base: firstTip, predecessors: [first.key] }]);
  second = await reload(second);
  assert.equal(second.queue!.speculation!.tip, secondRebase);
  assert.equal(second.reworkRequested, false, 'Graphyard re-based the entry; the worker was not asked to redo anything');
  assert.equal(second.submission!.epoch, 1); assert.equal(second.workspaces.length, 1);
  second = await engine.observe(second.id, second.revision, tip(second, { sha: secondRebase, baseSha: firstTip }, { baseTip: outside, reviews: [{ reviewer: 'reviewer', sha: secondTip, state: 'APPROVED' }] }));
  assert.equal(second.gates.find(gate => gate.name === 'acceptance')!.passed, false, 'the binding made against the superseded tip is refused');
  assert.equal(second.gates.find(gate => gate.name === 'review')!.passed, false);
});

test('a failed speculative validation ejects the entry with a reason and re-predicts the queue without it', async () => {
  const main = sha40('c1'), firstHead = sha40('c2'), secondHead = sha40('c3'), thirdHead = sha40('c4'), thirdTip = sha40('c5'), mainTree = sha40('c6');
  let first = await submitted(), second = await submitted(), third = await submitted();
  first = await validated(first, { sha: firstHead, baseSha: main });
  second = await validated(second, { sha: secondHead, baseSha: main });
  third = await validated(third, { sha: thirdHead, baseSha: main });
  await publishTip(first, { sha: firstHead, baseSha: main }, firstHead, mainTree);
  first = await reload(first);
  assert.deepEqual((await placementOf(third)).predecessors, [first.key, second.key]);

  second = await engine.observe(second.id, (await reload(second)).revision, tip(second, { sha: secondHead, baseSha: main }, { checks: [{ name: 'test', result: 'failure', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }] }));
  assert.equal(second.queue, null);
  assert.match(second.queueEjection!.reason, /Required CI check test did not pass on speculative tip/);
  assert.equal(second.queueHistory!.at(-1)!.event, 'ejected');
  assert.ok((await store.events(second.id)).some(event => event.payload.work.queueEjection?.reason === second.queueEjection!.reason), 'the ejection and its reason are in the append-only history');
  assert.deepEqual((await placementOf(third)).predecessors, [first.key], 'the entries behind are re-predicted without the ejected entry');
  assert.equal((await placementOf(third)).predictedBase, firstHead);

  // A repaired candidate returns to the back of the queue; the failed commit cannot re-enter.
  second = await engine.observe(second.id, second.revision, tip(second, { sha: secondHead, baseSha: main }));
  assert.equal(second.queue, null);
  assert.match(second.gates.find(gate => gate.name === 'merge')!.reasons.join(' '), /Ejected from the merge queue/);
  second = await validated(second, { sha: sha40('c7'), baseSha: main });
  assert.ok(second.queue); assert.ok(second.queue!.sequence > third.queue!.sequence);

  // No identity can buy a position, reorder the queue, or merge past the head.
  await assert.rejects(engine.execute(operator, 'queue' as any, third.id, {}, randomUUID()), /Unknown command/);
  third = await reload(third);
  await assert.rejects(engine.acquireMerge(operator, third.id, { expectedRevision: third.revision, sha: thirdHead, baseSha: main, policyRevision: third.policyRevision }, randomUUID()), /Merge authorization is no longer current/);
  await assert.rejects(engine.acquireMerge(coordinator, third.id, { expectedRevision: third.revision, sha: thirdHead, baseSha: main, policyRevision: third.policyRevision }, randomUUID()), /Merge authorization is no longer current/);

  await onlyJob(third);
  const conflicted = {
    observe: async (w: Work) => tip(w, { sha: thirdHead, baseSha: main }),
    publishSpeculativeTip: async () => { throw new SpeculativeConflict(`Speculative merge of ${firstHead.slice(0, 12)} into graphyard/third conflicts and cannot be resolved by Graphyard`); },
    publish: async () => {},
  } as unknown as GitHub;
  await processJob(engine, conflicted);
  third = await reload(third);
  assert.equal(third.queue, null);
  assert.match(third.queueEjection!.reason, /conflicts and cannot be resolved by Graphyard/);
  assert.equal((await store.events(third.id)).filter(event => event.kind === 'queue.ejected').length, 1);
  assert.equal(thirdTip.length, 40);
});

test('agent review policy requires registered reviewer profiles and an operator identity', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.execute(producer, 'evidence', w.id, proof(), randomUUID());
  const intent = { provider: 'agent', expectedPolicyRevision: 1, reason: 'Adopt identity-bound agent review' };
  await assert.rejects(engine.execute(operator, 'reviewpolicy', w.id, intent, randomUUID()), /Reviewer profiles are required/);
  await assert.rejects(engine.execute(operator, 'reviewpolicy', w.id, { ...intent, reviewerProfiles: [{ name: 'ghost', runtime: 'claude', reviewerApp: 'ghost' }] }, randomUUID()), /not registered/);
  await assert.rejects(engine.execute(operator, 'reviewpolicy', w.id, { ...intent, reviewerProfiles: [{ name: 'claude-reviewer', runtime: 'cursor', reviewerApp: 'claude-reviewer' }] }, randomUUID()), /registered runtime/);
  await assert.rejects(engine.execute(worker, 'reviewpolicy', w.id, { ...intent, reviewerProfiles: agentProfiles }, randomUUID()), /Operator/);
  await assert.rejects(engine.execute(operator, 'reviewpolicy', w.id, { provider: 'codex', reviewerProfiles: agentProfiles, expectedPolicyRevision: 1, reason: 'Mixed intent' }, randomUUID()), /rejected for every other provider/);
  w = await engine.execute(operator, 'reviewpolicy', w.id, { ...intent, reviewerProfiles: agentProfiles }, randomUUID());
  assert.equal(w.policyRevision, 2); assert.equal(w.policy.reviewProvider, 'agent');
  assert.deepEqual(w.policy.reviewerProfiles?.map(profile => profile.name), ['claude-reviewer', 'cursor-reviewer']);
  assert.equal(w.policy.reviewerProfiles![0].timeoutSeconds, 1800);
  assert.equal(w.observation, null); assert.equal(w.reviewRequest, null);
  // Acceptance evidence for the previous policy revision no longer counts.
  assert.equal(w.evidence.length, 1); assert.equal(w.gates.find(gate => gate.name === 'acceptance')?.passed, false);
  assert.equal((await store.events(w.id)).find(event => event.kind === 'reviewpolicy').payload.details.reason, intent.reason);
  await assert.rejects(engine.execute(operator, 'reviewpolicy', w.id, { ...intent, expectedPolicyRevision: 2, reviewerProfiles: agentProfiles }, randomUUID()), /already selected/);
  // Reordering the same identities is a real policy change and is accepted.
  w = await engine.execute(operator, 'reviewpolicy', w.id, { ...intent, expectedPolicyRevision: 2, reviewerProfiles: [agentProfiles[1], agentProfiles[0]] }, randomUUID());
  assert.deepEqual(w.policy.reviewerProfiles?.map(profile => profile.name), ['cursor-reviewer', 'claude-reviewer']);
  // Returning to formal GitHub review drops the reviewer profiles entirely.
  w = await engine.execute(operator, 'reviewpolicy', w.id, { provider: 'github', expectedPolicyRevision: 3, reason: 'Return to formal approval' }, randomUUID());
  assert.equal(w.policy.reviewerProfiles, undefined); assert.equal(w.policy.reviewProvider, 'github');
});

test('agent approval satisfies review only for the dispatched profile and registered App', async () => {
  let w = await agentReviewed();
  w = await engine.observe(w.id, w.revision, observation(w));
  const token = await leasedJob(w.id);
  const request = agentRequest(w);
  await assert.rejects(engine.bindReviewRequest(w.id, w.revision, { ...request, profile: 'cursor-reviewer', reviewerApp: 'cursor-reviewer' }, token), /currently selected reviewer profile/);
  await assert.rejects(engine.bindReviewRequest(w.id, w.revision, { ...request, marker: undefined }, token), /currently selected reviewer profile/);
  await assert.rejects(engine.bindReviewRequest(w.id, w.revision, { ...request, provider: 'codex' }, token), /candidate or policy changed/);
  w = await engine.bindReviewRequest(w.id, w.revision, request, token);
  assert.equal(w.reviewRequest?.profile, 'claude-reviewer');
  assert.equal(w.observation?.agentReview?.approved, false);
  assert.match(w.gates.find(gate => gate.name === 'review')!.reasons[0], /Waiting for reviewer profile claude-reviewer/);
  w = await engine.observe(w.id, w.revision, agentVerdict(w, request));
  assert.equal(w.gates.find(gate => gate.name === 'review')?.passed, true);
  for (const forged of [{ requestId: 999 }, { profile: 'cursor-reviewer' }, { reviewerApp: 'cursor-reviewer' }, { sha: 'c'.repeat(40) }, { provider: 'codex' }]) {
    w = await engine.observe(w.id, w.revision, agentVerdict(w, request, forged));
    assert.equal(w.gates.find(gate => gate.name === 'review')?.passed, false, JSON.stringify(forged));
    w = await engine.observe(w.id, w.revision, agentVerdict(w, request));
    assert.equal(w.gates.find(gate => gate.name === 'review')?.passed, true, JSON.stringify(forged));
  }
  // A native change request still blocks an approved agent verdict.
  w = await engine.observe(w.id, w.revision, { ...agentVerdict(w, request), reviews: [{ reviewer: 'human', sha: head, state: 'CHANGES_REQUESTED' }] });
  assert.equal(w.gates.find(gate => gate.name === 'review')?.passed, false);
});

test('provider exhaustion fails over to the next profile and records it in history', async () => {
  let w = await agentReviewed();
  w = await engine.observe(w.id, w.revision, observation(w));
  const token = await leasedJob(w.id);
  await assert.rejects(engine.failoverReviewRequest(w.id, w.revision, { exhaustion: 'usage-limit', reason: 'quota' }, token), /current agent review request/);
  const first = agentRequest(w);
  w = await engine.bindReviewRequest(w.id, w.revision, first, token);
  await assert.rejects(engine.failoverReviewRequest(w.id, w.revision, { exhaustion: 'timeout', reason: 'silent' }, randomUUID()), ReconciliationRetry);
  w = await engine.failoverReviewRequest(w.id, w.revision, { exhaustion: 'usage-limit', reason: 'claude-reviewer reported exhausted usage limits' }, token);
  assert.equal(w.reviewRequest, null); assert.equal(w.reviewFailovers?.length, 1);
  assert.equal(w.reviewFailovers![0].profile, 'claude-reviewer'); assert.equal(w.reviewFailovers![0].nextProfile, 'cursor-reviewer');
  assert.equal(w.reviewFailovers![0].exhaustion, 'usage-limit'); assert.equal(w.reviewFailovers![0].requestCommentId, first.commentId);
  assert.match(w.gates.find(gate => gate.name === 'review')!.reasons[0], /failed over to cursor-reviewer/);
  const failoverEvent = (await store.events(w.id)).find(event => event.kind === 'review.failover');
  assert.equal(failoverEvent.payload.details.profile, 'claude-reviewer'); assert.equal(failoverEvent.payload.details.sha, head);
  // The superseded profile can no longer be rebound, and its old verdict cannot approve.
  await assert.rejects(engine.bindReviewRequest(w.id, w.revision, agentRequest(w), token), /currently selected reviewer profile/);
  w = await engine.observe(w.id, w.revision, agentVerdict(w, first));
  assert.equal(w.gates.find(gate => gate.name === 'review')?.passed, false);
  w = await engine.observe(w.id, w.revision, observation(w));
  const second = agentRequest(w, 'cursor-reviewer', 701);
  w = await engine.bindReviewRequest(w.id, w.revision, second, token);
  w = await engine.failoverReviewRequest(w.id, w.revision, { exhaustion: 'timeout', reason: 'no verdict within 900 seconds' }, token);
  assert.equal(w.reviewFailovers?.length, 2); assert.equal(w.reviewFailovers![1].nextProfile, null);
  assert.match(w.gates.find(gate => gate.name === 'review')!.reasons[0], /Every configured reviewer profile is exhausted/);
  assert.equal(w.stage, 'review');
  // Re-review restarts failover at the first configured profile without approving anything.
  w = await engine.execute(operator, 'rereview', w.id, {}, randomUUID());
  assert.deepEqual(w.reviewFailovers, []);
  w = await engine.observe(w.id, w.revision, observation(w));
  w = await engine.bindReviewRequest(w.id, w.revision, agentRequest(w, 'claude-reviewer', 702), token);
  assert.equal(w.reviewRequest?.profile, 'claude-reviewer');
  assert.ok((await store.events(w.id)).some(event => event.kind === 'review.failover'));
});

test('reconciliation dispatches, fails over, and stops without approving when reviewers are exhausted', async () => {
  let w = await agentReviewed();
  const dispatched: string[] = []; let exhaust: string | null = null; let publications = 0;
  const adapter = {
    reviewerAppFor: (profile: any) => profile && reviewerApps.find(app => app.id === profile.reviewerApp),
    observe: async (work: Work) => {
      const request = work.reviewRequest;
      if (!request?.profile) return { ...observation(work), reviews: [], prState: 'open' as const, draft: false };
      return { ...observation(work), reviews: [], prState: 'open' as const, draft: false,
        agentReview: { provider: 'agent' as const, sha: head, approved: false, profile: request.profile, reviewerApp: request.reviewerApp,
          reason: `${request.profile} is exhausted`, ...(exhaust === request.profile ? { exhausted: true, exhaustion: 'usage-limit' as const } : {}) } };
    },
    requestAgentReview: async (work: Work, profile: any, app: any, guard: () => Promise<void>) => {
      await guard(); dispatched.push(profile.name);
      assert.equal(app.id, profile.reviewerApp);
      return agentRequest(work, profile.name, 800 + dispatched.length);
    },
    publish: async (_work: Work, forced: unknown, guard: () => Promise<void>) => { assert.equal(forced, undefined); await guard(); publications++; },
  } as unknown as GitHub;
  const run = async () => {
    await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
    await store.pool.query('UPDATE jobs SET available_at=now() WHERE work_id=$1', [w.id]);
    await processJob(engine, adapter);
    w = (await store.list()).find(item => item.id === w.id)!;
  };
  await run();
  assert.deepEqual(dispatched, ['claude-reviewer']); assert.equal(w.reviewRequest?.profile, 'claude-reviewer');
  exhaust = 'claude-reviewer'; await run();
  assert.deepEqual(dispatched, ['claude-reviewer', 'cursor-reviewer']);
  assert.equal(w.reviewFailovers?.length, 1); assert.equal(w.reviewRequest?.profile, 'cursor-reviewer');
  exhaust = 'cursor-reviewer'; await run();
  assert.equal(w.reviewFailovers?.length, 2); assert.equal(w.reviewRequest, null);
  assert.deepEqual(dispatched, ['claude-reviewer', 'cursor-reviewer']);
  assert.equal(w.gates.find(gate => gate.name === 'review')?.passed, false);
  // A stalled reviewer never becomes an approval, and the job stays healthy for retries.
  await run();
  assert.equal(w.gates.find(gate => gate.name === 'review')?.passed, false);
  assert.equal((await store.pool.query('SELECT error FROM jobs WHERE work_id=$1', [w.id])).rows[0].error, null);
  assert.ok(publications >= 4);
});

test('existing GitHub and Codex review policies keep their original behavior', async () => {
  // A default policy still requires an independent formal approval, registry or not.
  let native = await submitted();
  native = await engine.observe(native.id, native.revision, { ...observation(native), reviews: [] });
  assert.equal(native.policy.reviewProvider, undefined);
  assert.match(native.gates.find(gate => gate.name === 'review')!.reasons[0], /Independent approval of the current commit/);
  native = await engine.observe(native.id, native.revision, { ...observation(native), reviews: [{ reviewer: 'implementer', sha: head, state: 'APPROVED' }] });
  assert.equal(native.gates.find(gate => gate.name === 'review')?.passed, false);
  native = await engine.observe(native.id, native.revision, observation(native));
  assert.equal(native.gates.find(gate => gate.name === 'review')?.passed, true);
  // A Codex policy still binds to its own provider record and rejects an agent verdict.
  let codex = await submitted();
  codex = await engine.observe(codex.id, codex.revision, observation(codex));
  codex = await engine.execute(operator, 'reviewpolicy', codex.id, { provider: 'codex', expectedPolicyRevision: 1, reason: 'Keep hosted Codex review' }, randomUUID());
  assert.equal(codex.policy.reviewerProfiles, undefined);
  codex = await engine.observe(codex.id, codex.revision, observation(codex));
  const token = await leasedJob(codex.id);
  const request = { commentId: 8124, sha: head, baseSha: base, policyRevision: codex.policyRevision, body: '@codex review', createdAt: new Date().toISOString() };
  codex = await engine.bindReviewRequest(codex.id, codex.revision, request, token);
  assert.equal(codex.reviewRequest?.provider, undefined);
  codex = await engine.observe(codex.id, codex.revision, { ...observation(codex), reviews: [], agentReview: { provider: 'agent', sha: head, approved: true, reason: 'agent', requestId: 8124, profile: 'claude-reviewer', reviewerApp: 'claude-reviewer' } });
  assert.equal(codex.gates.find(gate => gate.name === 'review')?.passed, false);
  codex = await engine.observe(codex.id, codex.revision, { ...observation(codex), reviews: [], agentReview: { provider: 'codex', sha: head, approved: true, reason: 'Clean review', requestId: 8124 } });
  assert.equal(codex.gates.find(gate => gate.name === 'review')?.passed, true);
});

// integration:app-permissions-preflight
const shortfall = 'App graphyard-owner-project lacks Contents: write (installed with read), which the merge queue needs to publish speculative merge-queue tips; accept the pending permission request at https://github.com/settings/installations/4242';
async function jobRow(w: Work) {
  return (await store.pool.query("SELECT error,token,held_reason,held_until,held_on,refusals,attempts,held_until>now() AS held,available_at<=now() AS due FROM jobs WHERE work_id=$1", [w.id])).rows[0];
}
test('a queued candidate whose tip needs a missing App permission is held with the operator reason instead of retried into a 403', async () => {
  const main = sha40('d1'), headSha = sha40('d2'), mainTree = sha40('d3');
  let w = await submitted();
  w = await validated(w, { sha: headSha, baseSha: main });
  assert.equal((await placementOf(w)).publishable, true);
  await onlyJob(w);
  let publications = 0, tips = 0;
  const adapter = {
    observe: async (item: Work) => tip(item, { sha: headSha, baseSha: main }),
    publishSpeculativeTip: async () => { tips++; throw new Error('must not be attempted while the permission is missing'); },
    publish: async () => { publications++; },
    permissionShortfall: (feature: string) => feature === 'merge-queue' ? shortfall : null,
  } as unknown as GitHub;
  await processJob(engine, adapter);
  const held = await jobRow(w);
  assert.equal(tips, 0, 'the write that can only 403 is not attempted');
  assert.equal(publications, 1, 'observation and the required check still run: they need nothing the App lacks');
  assert.equal(held.error, shortfall); assert.equal(held.held_reason, shortfall); assert.equal(held.held, true); assert.equal(held.token, null);
  assert.ok(Math.abs(held.held_until.getTime() - Date.now() - permissionHoldMs) < 5_000, 'a held job re-checks once per bounded hold');
  w = await reload(w);
  assert.equal(w.queue?.speculation ?? null, null); assert.equal(w.mergeAuthorization, null);
  assert.match(w.gates.find(gate => gate.name === 'merge')!.reasons.join(' '), /has not been published/, 'no gate is weakened by the hold');
  // Held jobs are neither taken nor woken by a webhook; the dashboard and diagnose see the hold.
  await store.pool.query('UPDATE jobs SET available_at=now(),generation=generation+1 WHERE work_id=$1', [w.id]);
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour' WHERE work_id<>$1", [w.id]);
  assert.equal(await store.takeJob(), undefined, 'a webhook wakeup cannot lift a permission hold');
  const snapshot = await store.workSnapshot();
  const job = snapshot.jobs.find(entry => entry.work_id === w.id)!;
  assert.equal(job.error, shortfall); assert.ok(Date.parse(job.held_until!) > Date.now());
  const diagnostics = diagnose(w, snapshot.work, Date.parse(snapshot.now), snapshot.jobs);
  assert.equal(diagnostics.find(entry => entry.kind === 'integration-held')?.message, shortfall);
  assert.equal(diagnostics.some(entry => entry.kind === 'integration-error'), false);
  assert.deepEqual((await store.heldJobs()).map(entry => entry.work_id), [w.id]);
  // Once a preflight sees the permission, every held job runs again at once and the tip publishes.
  assert.equal(await store.releaseHeldJobs(), 1);
  const released = await jobRow(w);
  assert.equal(released.held_reason, null); assert.equal(released.held_until, null); assert.equal(released.due, true);
  const run = queueAdapter(item => tip(item, { sha: headSha, baseSha: main }), (item, placement) => predicted(item, placement, headSha, mainTree));
  await processJob(engine, run.adapter);
  assert.deepEqual(run.seen, [{ key: w.key, base: main, predecessors: [] }]);
  assert.equal((await reload(w)).queue!.speculation!.tip, headSha);
  assert.equal((await jobRow(w)).error, null);
});
test('a job whose observation needs a missing permission is held before any GitHub call, and a review dispatch hold keeps observing', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  await onlyJob(w);
  let observations = 0;
  const blind = { observe: async () => { observations++; throw new Error('unreachable'); }, permissionShortfall: (feature: string) => feature === 'observation' ? 'App lacks Pull requests: read; accept the pending permission request at https://github.com/settings/installations/1' : null } as unknown as GitHub;
  await processJob(engine, blind);
  assert.equal(observations, 0); assert.match((await jobRow(w)).held_reason, /Pull requests: read/);
  await store.releaseHeldJobs();
  // A Codex policy needs Pull requests: write to dispatch; without it the request is held, the observation is not.
  w = await engine.execute(operator, 'reviewpolicy', w.id, { provider: 'codex', expectedPolicyRevision: 1, reason: 'Adopt Codex review' }, randomUUID());
  await onlyJob(w);
  let requests = 0, publications = 0;
  const dispatcher = {
    observe: async (item: Work) => ({ ...observation(item), prState: 'open', draft: false }), requestCodex: async () => { requests++; throw new Error('must not be dispatched'); }, publish: async () => { publications++; },
    permissionShortfall: (feature: string) => feature === 'review-dispatch' ? 'App lacks Pull requests: write; accept the pending permission request at https://github.com/settings/installations/1' : null,
  } as unknown as GitHub;
  await processJob(engine, dispatcher);
  assert.equal(requests, 0); assert.equal(publications, 1);
  assert.match((await jobRow(w)).held_reason, /Pull requests: write/);
  assert.ok(Date.parse((await reload(w)).observation!.at) > Date.now() - 10_000, 'the observation stayed fresh');
  assert.equal((await reload(w)).reviewRequest ?? null, null);
  await store.releaseHeldJobs();
});
// integration:github-error-classification
const grantedReport = (granted: Record<string, string>, suspended = false): AppPermissionReport => ({ appId: 1234, installationId: 4242, app: 'graphyard-owner-project', account: 'owner', installationUrl: 'https://github.com/settings/installations/4242', observedAt: new Date().toISOString(), verifiedAt: new Date().toISOString(), error: null, suspended,
  required: { contents: 'write' }, granted, missing: [], blockedFeatures: [], attention: [] });
const fullyGranted = { administration: 'read', checks: 'write', contents: 'write', issues: 'read', metadata: 'read', pull_requests: 'write' };
test('an unexpected permission refusal retries a bounded number of times, then holds with its reason rather than accumulating attempts', async () => {
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  // The preflight passes: this 403 is one the declaration does not explain.
  const refusing = { observe: async () => { throw new GitHubPermissionRefusal('GitHub GET /repos/owner/project/pulls/1 failed (403): the installed App lacks a permission this request needs', 'permission'); }, publish: async () => {}, permissionReport: () => grantedReport(fullyGranted) } as unknown as GitHub;
  for (let attempt = 1; attempt < permissionRefusalLimit; attempt++) {
    await onlyJob(w); await processJob(engine, refusing);
    const row = await jobRow(w);
    assert.equal(row.refusals, attempt); assert.equal(row.held_reason, null); assert.equal(row.held_on, null); assert.match(row.error, /failed \(403\)/);
  }
  await onlyJob(w); await processJob(engine, refusing);
  const held = await jobRow(w);
  assert.equal(held.refusals, permissionRefusalLimit); assert.equal(held.held, true); assert.match(held.held_reason, /failed \(403\)/);
  assert.equal(held.error, held.held_reason);
  assert.equal(held.held_on, installationFingerprint(grantedReport(fullyGranted)), 'the hold records the installation it was decided against');
  await store.pool.query('UPDATE jobs SET available_at=now() WHERE work_id=$1', [w.id]);
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour' WHERE work_id<>$1", [w.id]);
  assert.equal(await store.takeJob(), undefined, 'the held job is not retried');
  // The refusal brings the preflight forward; when it passes against the unchanged installation
  // the hold stays, so the job costs one attempt per bounded hold rather than three per preflight.
  assert.equal(await store.releaseHeldJobs(installationFingerprint(grantedReport({ ...fullyGranted }))), 0, 'an unchanged installation releases nothing');
  assert.equal((await jobRow(w)).held, true); assert.equal((await jobRow(w)).refusals, permissionRefusalLimit);
  assert.equal(await store.takeJob(), undefined, 'still not retried');
  // A different installation reading (a permission accepted, a suspension lifted) releases it at once.
  assert.equal(await store.releaseHeldJobs(installationFingerprint(grantedReport({ ...fullyGranted, workflows: 'write' }))), 1, 'a changed installation releases the hold');
  const released = await jobRow(w);
  assert.equal(released.held, null); assert.equal(released.held_on, null); assert.equal(released.refusals, 0); assert.equal(released.due, true);
  // Once the bounded hold expires the job re-checks once, and the same refusal holds it again immediately.
  await onlyJob(w); await processJob(engine, refusing);
  await store.pool.query('UPDATE jobs SET refusals=$2 WHERE work_id=$1', [w.id, permissionRefusalLimit]);
  await store.pool.query('UPDATE jobs SET held_until=now(),available_at=now() WHERE work_id=$1', [w.id]);
  await processJob(engine, refusing);
  const reheld = await jobRow(w);
  assert.equal(reheld.held, true); assert.equal(reheld.refusals, permissionRefusalLimit + 1); assert.ok(reheld.held_until.getTime() > Date.now() + permissionHoldMs - 5_000, 'held for another bounded period');
  // A rate-limit or transport failure is still the ordinary durable retry, and success clears the counter.
  await store.releaseHeldJobs();
  const failing = { observe: async () => { throw new Error('GitHub GET /pulls/1 failed (503)'); }, publish: async () => {} } as unknown as GitHub;
  await onlyJob(w); await processJob(engine, failing);
  const ordinary = await jobRow(w);
  assert.equal(ordinary.held_reason, null); assert.equal(ordinary.refusals, 0); assert.match(ordinary.error, /503/);
  const healthy = { observe: async (item: Work) => observation(item), publish: async () => {} } as unknown as GitHub;
  await onlyJob(w); await processJob(engine, healthy);
  const cleared = await jobRow(w);
  assert.equal(cleared.error, null); assert.equal(cleared.refusals, 0);
});
test('a hold decided against a permission shortfall is released by the preflight that sees the permission accepted, not by one that re-reads the same shortfall', async () => {
  const legacy = grantedReport({ ...fullyGranted, contents: 'read' });
  assert.equal(installationFingerprint(null), null); assert.equal(installationFingerprint({ ...legacy, granted: null }), null, 'no reading, no fingerprint');
  assert.equal(installationFingerprint(legacy), installationFingerprint(grantedReport({ contents: 'read', pull_requests: 'write', metadata: 'read', issues: 'read', checks: 'write', administration: 'read' })), 'key order does not matter');
  assert.notEqual(installationFingerprint(legacy), installationFingerprint(grantedReport({ ...fullyGranted, contents: 'read' }, true)), 'suspension is part of the reading');
  assert.notEqual(installationFingerprint(legacy), installationFingerprint({ ...legacy, installationId: 1 }), 'so is the installation identity');
  let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
  await onlyJob(w);
  const adapter = { observe: async (item: Work) => observation(item), publish: async () => {}, permissionShortfall: (feature: string) => feature === 'check' ? shortfall : null, permissionReport: () => legacy } as unknown as GitHub;
  await processJob(engine, adapter);
  const held = await jobRow(w);
  assert.equal(held.held, true); assert.equal(held.held_reason, shortfall); assert.equal(held.held_on, installationFingerprint(legacy));
  assert.equal(await store.releaseHeldJobs(installationFingerprint(legacy)), 0, 'the same shortfall read again is not acceptance');
  assert.equal(await store.releaseHeldJobs(installationFingerprint(grantedReport(fullyGranted))), 1, 'Contents: write accepted');
  assert.equal((await jobRow(w)).held, null);
  // A hold placed before any reading existed is released by whichever preflight passes first.
  await onlyJob(w);
  await processJob(engine, { ...adapter, permissionReport: () => null } as unknown as GitHub);
  assert.equal((await jobRow(w)).held, true); assert.equal((await jobRow(w)).held_on, null);
  assert.equal(await store.releaseHeldJobs(installationFingerprint(grantedReport(fullyGranted))), 1);
});
test('the status API reports the App permission preflight and held jobs, and master status raises them as control-plane attention', async () => {
  const report = { appId: 1234, installationId: 4242, app: 'graphyard-owner-project', account: 'owner', installationUrl: 'https://github.com/settings/installations/4242', observedAt: new Date().toISOString(), verifiedAt: new Date().toISOString(), error: null, suspended: false,
    required: { contents: 'write' }, granted: { contents: 'read' }, missing: [{ permission: 'contents', required: 'write', granted: 'read', features: ['merge-queue'], reasons: ['publish speculative merge-queue tips'] }], blockedFeatures: ['merge-queue'], attention: [shortfall] };
  const fake = { config: { repository: 'owner/project', base: 'main', appId: 1234, installationId: 4242, reviewerApps: [] }, reviewRepository: async () => ({ id: 1, fullName: 'owner/project' }), reviewPermissions: async () => ({ pull_requests: 'write', issues: 'read', checks: 'write' }), permissionReport: () => structuredClone(report) } as unknown as GitHub;
  const isolated = new Engine(store, [15368], 120, 'owner/project'); isolated.reviewerApps = reviewerApps; isolated.controlPlaneAppId = 1234;
  const http = server(isolated, [{ ...coordinator, token: 'm'.repeat(32) }], fake);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(http.address() as any).port}`;
  try {
    let w = await submitted(); w = await engine.observe(w.id, w.revision, observation(w));
    const token = await leasedJob(w.id);
    await store.holdJob(w.id, token, shortfall, permissionHoldMs);
    const status: any = await (await fetch(`${origin}/api/status`, { headers: { Authorization: `Bearer ${'m'.repeat(32)}` } })).json();
    assert.deepEqual(status.appPermissions.attention, [shortfall]); assert.equal(status.appPermissions.missing[0].permission, 'contents');
    assert.equal(status.appPermissions.installationUrl, 'https://github.com/settings/installations/4242');
    assert.equal(status.heldJobs, 1);
    assert.equal(status.jobs.find((job: any) => job.work_id === w.id).error, shortfall);
    const snapshot = await store.workSnapshot();
    const master = buildMasterStatus(snapshot, [], [], {}, {}, undefined, undefined, status);
    assert.equal(master.controlPlane.attention[0], shortfall);
    assert.match(master.controlPlane.attention[1], /1 integration job is held/);
    assert.deepEqual(master.controlPlane.appPermissions!.missing, [{ permission: 'contents', required: 'write', features: ['merge-queue'] }]);
    assert.equal(master.counts.attention, master.work.filter(row => row.attention).length + 2);
    const quiet = buildMasterStatus(snapshot, [], [], {}, {}, undefined, undefined, { ...status, appPermissions: { ...status.appPermissions, missing: [], attention: [] }, heldJobs: 0 });
    assert.deepEqual(quiet.controlPlane.attention, []);
    await store.releaseHeldJobs();
  } finally { await new Promise<void>(resolve => http.close(() => resolve())); }
});

// --- Submit-time integration regression guard ---------------------------------------------------
const scoped = (path: string, extra: Partial<ScopeFile> = {}): ScopeFile => ({ path, status: 'modified', sha: sha40('5'), additions: 1, deletions: 1, binary: false, baseSha: sha40('6'), ...extra });
async function claimedScoped(plannedFiles: string[]) {
  let w = await engine.execute(operator, 'create', null, { ...workInput, title: 'Scoped change', plannedFiles }, randomUUID());
  w = await engine.execute(operator, 'ready', w.id, {}, randomUUID());
  w = await engine.execute(worker, 'claim', w.id, {}, randomUUID());
  return engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'machine-a', path: `/tmp/${w.id}`, branch: `graphyard/${w.id}` }, randomUUID());
}
test('complete refuses a candidate that reverts shipped code outside its planned files and accepts it once every such file matches the base', async () => {
  const shipped = await store.list();
  const delivered = shipped.find(item => item.stage === 'done' && item.observation?.files.includes('src/claims.ts'));
  const w = await claimedScoped(['src/scoped/', 'tests/']);
  const pr = Number(w.key.slice(3));
  const observed = (scopeFiles: ScopeFile[]): Observation => ({ ...observation({ ...w, submission: { epoch: 1, pr } } as Work), files: scopeFiles.map(file => file.path), scopeFiles });
  const reverting = observed([scoped('src/scoped/feature.ts', { baseSha: undefined }), scoped('src/claims.ts', { additions: 0, deletions: 14 }), scoped('src/quarantine.ts', { status: 'removed', sha: null }), scoped('tests/new.test.ts', { status: 'added', baseSha: undefined })]);
  await assert.rejects(engine.execute(worker, 'submit', w.id, { epoch: 1, pr }, randomUUID(), { observation: reverting }), (error: any) => {
    assert.match(error.message, new RegExp(`Submission refused for ${w.key}: Candidate changes 2 files outside its planned files`));
    assert.match(error.message, /src\/claims\.ts: removes 14 lines that the base branch holds and adds nothing \(shipped by/);
    if (delivered) assert.ok(error.message.includes(delivered.key), 'the shipped work item is named');
    assert.match(error.message, /src\/quarantine\.ts: deleted; the base branch still holds it/);
    assert.doesNotMatch(error.message, /feature\.ts|new\.test\.ts/, 'in-scope changes are never listed');
    return true;
  });
  assert.equal((await reload(w)).submission, null, 'a refused submission is not recorded');
  assert.equal((await store.events(w.id)).some(event => event.kind === 'submit'), false);
  const otherBranch = observed([]); otherBranch.candidate.branch = 'graphyard/someone-else';
  await assert.rejects(engine.execute(worker, 'submit', w.id, { epoch: 1, pr }, randomUUID(), { observation: otherBranch }), /PR branch does not match the assigned workspace/);
  await assert.rejects(engine.execute(worker, 'submit', w.id, { epoch: 1, pr }, randomUUID(), { observation: { ...observed([]), candidate: { ...observed([]).candidate, pr: pr + 1000 } } }), /Observed pull request does not match/);
  await assert.rejects(engine.execute(worker, 'submit', w.id, { epoch: 1, pr }, randomUUID(), { observation: { ...observed([]), scopeFiles: undefined } }), /has not been compared against the base branch tip/);
  const fixed = observed([scoped('src/scoped/feature.ts', { baseSha: undefined }), scoped('src/claims.ts', { sha: sha40('6') }), scoped('src/quarantine.ts', { status: 'removed', sha: null, baseSha: null }), scoped('src/brand-new.ts', { status: 'added', baseSha: null }), scoped('tests/new.test.ts', { status: 'added', baseSha: undefined })]);
  const accepted = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr }, randomUUID(), { observation: fixed });
  assert.deepEqual(accepted.submission, { epoch: 1, pr });
  await clearQueue(w.id);
});
test('a submission observed by the deployment GitHub client is refused before it is recorded, and a replay never re-observes', async () => {
  const w = await claimedScoped(['src/scoped/']);
  const pr = Number(w.key.slice(3));
  let observations = 0; let scopeFiles: ScopeFile[] = [scoped('src/claims.ts', { additions: 0, deletions: 3 })];
  engine.submissionObserver = async probe => { observations++; assert.deepEqual(probe.submission, { epoch: 1, pr }); return { ...observation(probe), files: scopeFiles.map(file => file.path), scopeFiles }; };
  try {
    const headers = { Authorization: `Bearer ${'w'.repeat(32)}`, 'Content-Type': 'application/json' };
    const submit = (key: string) => fetch(`${url}/api/work/${w.id}/submit`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': key }, body: JSON.stringify({ epoch: 1, pr }) });
    const refused = await submit(randomUUID());
    assert.equal(refused.status, 409); assert.match((await refused.json() as any).error, /Out-of-scope regression: src\/claims\.ts: removes 3 lines/);
    assert.equal((await reload(w)).submission, null);
    scopeFiles = [scoped('src/scoped/feature.ts', { baseSha: undefined })];
    const key = randomUUID();
    assert.equal((await submit(key)).status, 200); const count = observations;
    assert.equal((await submit(key)).status, 200); assert.equal(observations, count, 'the idempotent replay is answered from the receipt');
    // Without a pre-observation the transaction records the submission; the reconciliation job then decides.
    engine.submissionObserver = null;
    await assert.rejects(engine.execute(worker, 'submit', w.id, { epoch: 1, pr: pr + 500 }, randomUUID()), /cannot switch pull requests/);
  } finally { engine.submissionObserver = undefined; await clearQueue(w.id); }
});
test('every later head is re-evaluated: a revert pushed after submission closes the build gate, names the files in diagnose and the published check, and clears when fixed', async () => {
  const w = await claimedScoped(['src/scoped/']);
  const pr = Number(w.key.slice(3));
  const clean = () => ({ ...observation({ ...w, submission: { epoch: 1, pr } } as Work), files: ['src/scoped/feature.ts'], scopeFiles: [scoped('src/scoped/feature.ts', { baseSha: undefined })] });
  let current = clean();
  let published: any[] = [];
  const adapter = { observe: async () => current, publish: async (item: Work) => { published.push(item.gates.flatMap(gate => gate.reasons)); } } as unknown as GitHub;
  engine.submissionObserver = async () => current;
  try {
    let submitted = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr }, randomUUID());
    await clearQueue(w.id);
    await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
    await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [w.id]);
    await processJob(engine, adapter);
    submitted = await reload(w);
    assert.equal(submitted.gates.find(gate => gate.name === 'build')?.passed, true);
    // The worker merges main badly and pushes: the head changes and the observation names the damage.
    const regressed = sha40('9');
    current = { ...clean(), candidate: { ...clean().candidate, sha: regressed }, files: ['src/scoped/feature.ts', 'src/quarantine.ts'], scopeFiles: [scoped('src/scoped/feature.ts', { baseSha: undefined }), scoped('src/quarantine.ts', { status: 'removed', sha: null })] };
    await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [w.id]);
    await processJob(engine, adapter);
    const refused = await reload(w);
    assert.equal(refused.stage, 'build'); assert.equal(refused.candidate?.sha, regressed);
    const build = refused.gates.find(gate => gate.name === 'build')!;
    assert.equal(build.passed, false); assert.match(build.reasons.join('\n'), /Out-of-scope regression: src\/quarantine\.ts: deleted; the base branch still holds it/);
    const diagnostics = diagnose(refused, await store.list(), Date.now());
    assert.ok(diagnostics.some(item => item.kind === 'gate-build' && /src\/quarantine\.ts: deleted/.test(item.message)), 'diagnose surfaces the refusal with the file');
    assert.ok(published.at(-1)!.some((reason: string) => /src\/quarantine\.ts/.test(reason)), 'the published check names the file');
    current = { ...clean(), candidate: { ...clean().candidate, sha: sha40('10') } };
    await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [w.id]);
    await processJob(engine, adapter);
    assert.equal((await reload(w)).gates.find(gate => gate.name === 'build')?.passed, true);
  } finally { engine.submissionObserver = undefined; await clearQueue(w.id); }
});
