import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { Validation } from '../src/validation.js';
import { Delivery, type EnvironmentDelivery, type Release, type RollbackRequest } from '../src/delivery.js';
import { defineScenario } from '../src/scenarios.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { defaultRepositoryPolicy, setRepositoryPolicy } from '../src/model/repository-policy.js';
// GY-2965: the fixtures create items carrying e2e: proofs, so this process declares the serve the trial would use.
setRepositoryPolicy({ ...defaultRepositoryPolicy, e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

// Time-bomb allowance (GY-1694): the 2000-01-01 expiresAt forces an attempt lapse that stays lapsed, and 2026-09-18 is the injected SigV4 signing clock; Date.now() builds deadlines and snapshot instants on the real clock only.

/**
 * D4 acceptance checks of the turnkey delivery roadmap, one test per check, named
 * "D4-N". Runner capacity and diagnostics, execution-resource safety under partitions,
 * artifact backends and retention, and the rollback workflow all run against a disposable
 * real Postgres database; the S3-compatible store is an in-process HTTP stub that behaves
 * like one (SigV4 headers, MD5 ETags, 404 after deletion) and can be told to fail or corrupt.
 */
const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const runner: Principal = { id: 'runner', role: 'worker' };
const runners: Principal[] = ['runner-b', 'runner-c', 'runner-d', 'runner-e'].map(id => ({ id, role: 'worker' }));
const idleRunner: Principal = { id: 'idle-runner', role: 'worker' };
const collector: Principal = { id: 'collector', role: 'producer', proofs: [] };
const builder: Principal = { id: 'builder', role: 'producer' };
const observer: Principal = { id: 'observer', role: 'producer' };
const promoter: Principal = { id: 'promoter', role: 'producer' };
const executor: Principal = { id: 'executor', role: 'producer' };
const secondExecutor: Principal = { id: 'second-executor', role: 'producer' };
const reader: Principal = { id: 'auditor', role: 'reader' };
const principals = [operator, worker, runner, ...runners, idleRunner, collector, builder, observer, promoter, executor, secondExecutor, reader];
const attestationPublicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
const head = 'a'.repeat(40), base = 'b'.repeat(40), digest = `sha256:${'c'.repeat(64)}`, inputs = `sha256:${'d'.repeat(64)}`;
const digestOf = (label: string) => `sha256:${label.repeat(64).slice(0, 64)}`;
const manifests = { one: { api: digestOf('1'), web: digestOf('2') }, two: { api: digestOf('3'), web: digestOf('4') }, three: { api: digestOf('5'), web: digestOf('6') } };
let pg: EmbeddedPostgres, store: Store, engine: Engine, validation: Validation, delivery: Delivery;
let serial = 0;

/** An S3-compatible object store: path-style, SigV4-authenticated, MD5 ETags, and switches to fail or corrupt the next write. */
before(async () => {
  const port = Number(process.env.GRAPHYARD_RECOVERY_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 5);
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('recovery'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('recovery_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/recovery_test`); await store.init();
  engine = new Engine(store, 120, 'test/repository'); validation = new Validation(engine, principals, 'test/repository'); delivery = new Delivery(validation);
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });
const id = () => randomUUID();
const at = (offsetSeconds: number, from = Date.now()) => new Date(from + offsetSeconds * 1000).toISOString();
async function current(workId: string) { return (await store.list()).find(w => w.id === workId)!; }
async function events(kind: string) { return (await store.pool.query('SELECT payload FROM events WHERE kind=$1 ORDER BY seq', [kind])).rows.map(r => r.payload); }

// ---- delivery fixtures: an environment with observer, promoter, builder and rollback executors ----
type Env = { n: number; env: { id: string; revision: number }; registrations: Record<'builder' | 'observer' | 'promoter' | 'executor' | 'serialized' | 'unfenced' | 'second', { id: string; revision: number }>; epoch: number; executorEpoch: number };
async function environment(policy: { freshnessSeconds: number; approvalRequired: boolean; automaticRollback?: boolean } = { freshnessSeconds: 300, approvalRequired: true }, executors: { automatic: boolean } = { automatic: true }): Promise<Env> {
  const n = ++serial, env = { id: `production-${n}`, revision: 1 };
  await validation.define(operator, { kind: 'environment', id: env.id, expectedRevision: 0, repository: 'test/repository', url: 'https://production.example.test', instance: `instance-${n}`, immutable: true, services: ['api', 'web'], resources: [`account-${n}`], delivery: policy }, id());
  const registrations = { builder: { id: `builder-${n}`, revision: 1 }, observer: { id: `observer-${n}`, revision: 1 }, promoter: { id: `promoter-${n}`, revision: 1 }, executor: { id: `executor-${n}`, revision: 1 }, serialized: { id: `serialized-${n}`, revision: 1 }, unfenced: { id: `unfenced-${n}`, revision: 1 }, second: { id: `second-${n}`, revision: 1 } };
  await validation.define(operator, { kind: 'registration', id: registrations.builder.id, expectedRevision: 0, principalId: builder.id, role: 'builder', environment: env, adapterVersion: 'test-v1', proofs: [], enabled: true }, id());
  await validation.define(operator, { kind: 'registration', id: registrations.observer.id, expectedRevision: 0, principalId: observer.id, role: 'observer', environment: env, adapterVersion: 'test-v1', proofs: [], enabled: true, services: ['api', 'web'] }, id());
  await validation.define(operator, { kind: 'registration', id: registrations.promoter.id, expectedRevision: 0, principalId: promoter.id, role: 'promoter', environment: env, adapterVersion: 'test-v1', proofs: [], enabled: true, services: ['api', 'web'] }, id());
  await validation.define(operator, { kind: 'registration', id: registrations.executor.id, expectedRevision: 0, principalId: executor.id, role: 'rollback', environment: env, adapterVersion: 'test-v1', proofs: [], enabled: true, services: ['api', 'web'], rollback: { fencing: 'provider', automatic: executors.automatic } }, id());
  await validation.define(operator, { kind: 'registration', id: registrations.serialized.id, expectedRevision: 0, principalId: executor.id, role: 'rollback', environment: env, adapterVersion: 'test-v1', proofs: [], enabled: true, services: ['api', 'web'], rollback: { fencing: 'serialized', automatic: false } }, id());
  await validation.define(operator, { kind: 'registration', id: registrations.unfenced.id, expectedRevision: 0, principalId: executor.id, role: 'rollback', environment: env, adapterVersion: 'test-v1', proofs: [], enabled: true, services: ['api', 'web'], rollback: { fencing: 'none', automatic: false } }, id());
  await validation.define(operator, { kind: 'registration', id: registrations.second.id, expectedRevision: 0, principalId: secondExecutor.id, role: 'rollback', environment: env, adapterVersion: 'test-v1', proofs: [], enabled: true, services: ['api', 'web'], rollback: { fencing: 'provider', automatic: true } }, id());
  const lease = await delivery.lease(observer, { registration: registrations.observer });
  const executorLease = await delivery.lease(executor, { registration: registrations.executor });
  return { n, env, registrations, epoch: lease.epoch, executorEpoch: executorLease.epoch };
}
async function release(f: Env, manifest: Record<'api' | 'web', string>, releaseId = `release-${f.n}-${++serial}`) {
  const artifacts = [{ service: 'api', digest: manifest.api }, { service: 'web', digest: manifest.web }];
  const build: any = await delivery.attestBuild(builder, { registration: f.registrations.builder, sourceSha: head, buildInputsDigest: inputs, artifacts, provenanceUrl: 'https://ci.example.test/build/1' }, id());
  return delivery.createRelease(operator, { id: releaseId, expectedRevision: 0, environment: f.env, sourceSha: head, buildId: build.id, manifest: artifacts, members: [] }, id()) as Promise<Release>;
}
async function approve(f: Env, r: Release) { return delivery.approve(operator, { release: { id: r.id, revision: r.revision }, environment: f.env }, id()); }
async function select(f: Env, r: Release, expectedGeneration: number) {
  const approval = await approve(f, r);
  return delivery.select(operator, { environment: f.env, release: { id: r.id, revision: r.revision }, expectedGeneration, approvalId: approval.id }, id());
}
function snapshot(f: Env, generation: number, manifest: Record<'api' | 'web', string>, overrides: Record<string, unknown> = {}, healthy = true) {
  const now = Date.now(); // one clock reading per snapshot: a millisecond tick between fields would push observedAt past validTo
  return { registration: f.registrations.observer, epoch: f.epoch, environment: f.env, expectedGeneration: generation, snapshotId: `snapshot-${++serial}`, observedAt: at(0, now), validFrom: at(-60, now), validTo: at(0, now),
    services: [{ service: 'api', complete: true, instances: [{ instance: 'api-1', digest: manifest.api, measurement: 'provider', healthy }], deployment: { id: 'dep-api', status: 'success', deployedAt: at(-120, now) } },
      { service: 'web', complete: true, instances: [{ instance: 'web-1', digest: manifest.web, measurement: 'provider', healthy }], deployment: { id: 'dep-web', status: 'success', deployedAt: at(-120, now) } }], ...overrides };
}
async function state(f: Env): Promise<EnvironmentDelivery> { return (await delivery.status()).environments.find(e => e.environmentId === f.env.id)!; }
async function rollbackOf(rollbackId: string): Promise<RollbackRequest> { return (await delivery.status()).rollbacks.find(r => r.id === rollbackId)!; }
/** A verified release one, then a verified release two that degrades: the situation a rollback answers. */
async function degraded(f: Env) {
  const one = await release(f, manifests.one), two = await release(f, manifests.two);
  await select(f, one, 0); await delivery.observe(observer, snapshot(f, 1, manifests.one), id()); await delivery.sweep();
  assert.equal((await state(f)).verification.status, 'verified');
  await select(f, two, 1); await delivery.observe(observer, snapshot(f, 2, manifests.two), id()); await delivery.sweep();
  assert.equal((await state(f)).verification.status, 'verified');
  await delivery.observe(observer, snapshot(f, 2, manifests.two, {}, false), id()); await delivery.sweep();
  const s = await state(f); assert.equal(s.verification.status, 'degraded'); assert.equal(s.incidents.length, 1);
  return { one, two };
}
const rollbackRequest = (f: Env, target: Release, expectedGeneration: number, extra: Record<string, unknown> = {}) => ({ environment: f.env, target: { id: target.id, revision: target.revision }, expectedGeneration, reason: 'Release two degraded', ...extra });
const claim = (f: Env, rollbackId: string, registration = f.registrations.executor, epoch = f.executorEpoch, actor: Principal = executor) => delivery.claimRollback(actor, { rollbackId, registration, epoch }, id());
const settle = (f: Env, rollbackId: string, operationId: string, outcome: 'applied' | 'failed' | 'unknown', extra: Record<string, unknown> = {}, registration = f.registrations.executor, epoch = f.executorEpoch) => delivery.settleRollback(executor, { rollbackId, operationId, registration, epoch, outcome, ...extra }, id());

test('D4-4 a requested rollback is not complete until the target deployment is observed and required checks pass', async () => {
  const f = await environment(); const { one, two } = await degraded(f);
  // Only a previously verified target, with its approval still binding, is a rollback target.
  const three = await release(f, manifests.three);
  await assert.rejects(delivery.requestRollback(operator, rollbackRequest(f, three, 2), id()), /verified in this environment before/);
  await assert.rejects(delivery.requestRollback(operator, rollbackRequest(f, two, 2), id()), /already the expected release/);
  await assert.rejects(delivery.requestRollback(operator, rollbackRequest(f, one, 1), id()), /generation changed/);
  await assert.rejects(delivery.requestRollback(worker, rollbackRequest(f, one, 2), id()), /promotion principal/);
  const rollback = await delivery.requestRollback(operator, rollbackRequest(f, one, 2), id());
  assert.equal(rollback.state, 'requested'); assert.equal(rollback.generation, 3); assert.equal(rollback.failed.releaseId, two.id); assert.equal(rollback.failed.incidentIds.length, 1);
  assert.equal(rollback.target.releaseId, one.id); assert.ok(rollback.target.approvalId);
  let s = await state(f); assert.equal(s.generation, 3); assert.equal(s.expected?.releaseId, one.id); assert.equal(s.verification.status, 'unobserved');
  assert.equal(s.history.find(h => h.generation === 2)?.outcome, 'verified', 'the failed release keeps its historical verification');
  // Claim and apply. The provider's word moves the rollback to applied, no further.
  const granted = await claim(f, rollback.id);
  assert.equal(granted.operation.fencing, 'provider'); assert.equal(granted.operation.precondition.expectedRunning, two.manifestHash); assert.equal(granted.operation.precondition.generation, 3);
  assert.deepEqual(granted.target.manifest.map(a => a.digest), [manifests.one.api, manifests.one.web]);
  assert.equal((await rollbackOf(rollback.id)).state, 'in-flight');
  const applied = await settle(f, rollback.id, granted.operation.id, 'applied', { providerOperationId: 'railway:deploy:42' });
  assert.equal(applied.accepted, true); assert.equal(applied.state, 'applied');
  await delivery.sweep(); assert.equal((await rollbackOf(rollback.id)).state, 'applied', 'no observation yet');
  // The provider says applied, the observer still sees release two running: mismatched, not complete.
  await delivery.observe(observer, snapshot(f, 3, manifests.two), id()); await delivery.sweep();
  s = await state(f); assert.equal(s.verification.status, 'mismatched'); assert.equal((await rollbackOf(rollback.id)).state, 'applied');
  // Healthy but unmeasured identity is unknown, still not complete.
  await delivery.observe(observer, snapshot(f, 3, manifests.one, { services: [{ service: 'api', complete: true, instances: [{ instance: 'api-1', digest: manifests.one.api, measurement: 'self-report', healthy: true }] }, { service: 'web', complete: true, instances: [{ instance: 'web-1', digest: manifests.one.web, measurement: 'provider', healthy: true }] }] }), id()); await delivery.sweep();
  assert.equal((await state(f)).verification.status, 'unknown'); assert.equal((await rollbackOf(rollback.id)).state, 'applied');
  // Measured, healthy, complete, over a common interval: verified, and only now is the rollback complete.
  await delivery.observe(observer, snapshot(f, 3, manifests.one), id()); await delivery.sweep();
  s = await state(f); assert.equal(s.verification.status, 'verified');
  const done = await rollbackOf(rollback.id);
  assert.equal(done.state, 'verified'); assert.equal(done.verifiedAt, s.verification.verifiedAt); assert.deepEqual(done.interval, s.verification.interval);
  assert.deepEqual(done.history.map(h => h.state), ['requested', 'in-flight', 'applied', 'verified']);
  assert.equal((await events('delivery.rollback-verified')).filter(e => e.rollbackId === rollback.id).length, 1);
  // Late reports after completion are history, never a second outcome.
  const late = await settle(f, rollback.id, granted.operation.id, 'failed'); assert.equal(late.accepted, false); assert.match(late.reasons.join(), /already verified/);
  assert.equal((await rollbackOf(rollback.id)).state, 'verified');
});

test('D4-5 recovery after server restart preserves the external operation identity and avoids duplicate side effects', async () => {
  const f = await environment(); const { one } = await degraded(f);
  const rollback = await delivery.requestRollback(operator, rollbackRequest(f, one, 2, { repairWorkId: (await engine.execute(operator, 'create', null, { type: 'chore', title: 'Rollback repair', criteria: [{ id: 'AC-1', text: 'Repair verified', proofs: ['unit:repair', 'e2e:fixture'] }] }, id())).id }), id());
  const key = id();
  const first = await delivery.claimRollback(executor, { rollbackId: rollback.id, registration: f.registrations.executor, epoch: f.executorEpoch }, key);
  // The server restarts: fresh pool, engine, validation and delivery over the same database.
  const restarted = new Store(store.pool.options.connectionString!);
  try {
    const revived = new Delivery(new Validation(new Engine(restarted), principals, 'test/repository'));
    const replay = await revived.claimRollback(executor, { rollbackId: rollback.id, registration: f.registrations.executor, epoch: f.executorEpoch }, key);
    assert.equal(replay.operation.id, first.operation.id, 'the receipt returns the same operation');
    const again = await revived.claimRollback(executor, { rollbackId: rollback.id, registration: f.registrations.executor, epoch: f.executorEpoch }, id());
    assert.equal(again.operation.id, first.operation.id, 'a fresh key from the same executor still names one operation'); assert.equal(again.operation.precondition.token, first.operation.precondition.token);
    assert.equal((await revived.status()).rollbacks.find(r => r.id === rollback.id)?.history.filter(h => h.state === 'in-flight').length, 1);
    // A different executor cannot take it over while it is in flight, and an unknown operation identity is refused.
    await assert.rejects(revived.claimRollback(secondExecutor, { rollbackId: rollback.id, registration: f.registrations.second, epoch: (await revived.lease(secondExecutor, { registration: f.registrations.second })).epoch }, id()), /in-flight under operation/);
    await assert.rejects(revived.settleRollback(executor, { rollbackId: rollback.id, operationId: id(), registration: f.registrations.executor, epoch: f.executorEpoch, outcome: 'applied' }, id()), /Operation identity differs/);
    const settled = await revived.settleRollback(executor, { rollbackId: rollback.id, operationId: first.operation.id, registration: f.registrations.executor, epoch: f.executorEpoch, outcome: 'applied', providerOperationId: 'railway:deploy:7' }, id());
    assert.equal(settled.accepted, true);
    const record = (await revived.status()).rollbacks.find(r => r.id === rollback.id)!;
    assert.equal(record.operation?.providerOperationId, 'railway:deploy:7'); assert.equal(record.operation?.reports.length, 1); assert.ok(record.repairWorkId);
  } finally { await restarted.close(); }
});

test('D4-6 a partitioned rollback executor cannot apply an obsolete target after authority changes', async () => {
  // Delayed provider call under provider fencing: the target is superseded, the late outcome is history only.
  const f = await environment(); const { one, two } = await degraded(f);
  const rollback = await delivery.requestRollback(operator, rollbackRequest(f, one, 2), id());
  const granted = await claim(f, rollback.id);
  const three = await release(f, manifests.three); await select(f, three, 3);
  assert.equal((await rollbackOf(rollback.id)).state, 'superseded');
  const late = await settle(f, rollback.id, granted.operation.id, 'applied');
  assert.equal(late.accepted, false); assert.match(late.reasons.join(), /superseded by a newer selection/);
  let s = await state(f); assert.equal(s.expected?.releaseId, three.id); assert.equal(s.generation, 4);
  assert.equal((await rollbackOf(rollback.id)).operation?.reports[0].authoritative, false);
  await assert.rejects(claim(f, rollback.id), /superseded/);
  // Lease expiry: the executor's report is refused until it holds a lease again; nobody else can take the operation meanwhile.
  await delivery.observe(observer, snapshot(f, 4, manifests.three), id()); await delivery.sweep(); assert.equal((await state(f)).verification.status, 'verified');
  await delivery.observe(observer, snapshot(f, 4, manifests.three, {}, false), id()); await delivery.sweep(); assert.equal((await state(f)).verification.status, 'degraded');
  const second = await delivery.requestRollback(operator, rollbackRequest(f, two, 4), id());
  const secondGrant = await claim(f, second.id);
  await store.pool.query("UPDATE delivery_leases SET expires_at='2000-01-01' WHERE registration_id=$1", [f.registrations.executor.id]);
  await assert.rejects(settle(f, second.id, secondGrant.operation.id, 'applied'), /lease epoch is expired/);
  await assert.rejects(claim(f, second.id, f.registrations.second, (await delivery.lease(secondExecutor, { registration: f.registrations.second })).epoch, secondExecutor), /in-flight/);
  assert.equal((await rollbackOf(second.id)).state, 'in-flight', 'lease expiry alone releases nothing');
  const renewed = await delivery.lease(executor, { registration: f.registrations.executor }); assert.equal(renewed.epoch, f.executorEpoch + 1);
  await assert.rejects(settle(f, second.id, secondGrant.operation.id, 'applied', {}, f.registrations.executor, f.executorEpoch), /lease epoch is expired/);
  const recovered = await settle(f, second.id, secondGrant.operation.id, 'applied', {}, f.registrations.executor, renewed.epoch);
  assert.equal(recovered.accepted, true); f.executorEpoch = renewed.epoch;
  await delivery.observe(observer, snapshot(f, 5, manifests.two), id()); await delivery.sweep();
  assert.equal((await rollbackOf(second.id)).state, 'verified');
  // Ambiguous outcome: unknown blocks every successor until an operator resolves it with evidence.
  await delivery.observe(observer, snapshot(f, 5, manifests.two, {}, false), id()); await delivery.sweep(); assert.equal((await state(f)).verification.status, 'degraded');
  const third = await delivery.requestRollback(operator, rollbackRequest(f, three, 5), id());
  const thirdGrant = await claim(f, third.id);
  const ambiguous = await settle(f, third.id, thirdGrant.operation.id, 'unknown', { detail: 'provider timed out after the request was sent' });
  assert.equal(ambiguous.state, 'unknown');
  await assert.rejects(claim(f, third.id, f.registrations.second, (await delivery.lease(secondExecutor, { registration: f.registrations.second })).epoch, secondExecutor), /unknown under operation/);
  await assert.rejects(delivery.requestRollback(operator, rollbackRequest(f, one, 6), id()), /unresolved provider operation .*\(unknown\)/);
  await assert.rejects(select(f, await release(f, manifests.three), 6), /unresolved provider operation/);
  await assert.rejects(delivery.resolveRollback(operator, { rollbackId: third.id, outcome: 'applied', reason: 'Checked the provider' }, id()), /settlement evidence/);
  await assert.rejects(delivery.resolveRollback(executor, { rollbackId: third.id, outcome: 'applied', reason: 'Checked', evidence: 'https://provider.example.test/ops/9' }, id()), /Operator/);
  const resolved = await delivery.resolveRollback(operator, { rollbackId: third.id, operationId: thirdGrant.operation.id, outcome: 'applied', reason: 'Provider console shows deployment 9 succeeded', evidence: 'https://provider.example.test/ops/9' }, id());
  assert.equal(resolved.state, 'applied'); assert.equal(resolved.operation?.resolvedBy, operator.id); assert.equal(resolved.operation?.evidence, 'https://provider.example.test/ops/9');
  await delivery.observe(observer, snapshot(f, 6, manifests.three), id()); await delivery.sweep();
  assert.equal((await rollbackOf(third.id)).state, 'verified');
});

test('D4-6 an unresolved serialized operation blocks successors; an unfenced adapter refuses automatic rollback', async () => {
  const f = await environment(); const { one, two } = await degraded(f);
  // Serialized fencing: no selection and no other rollback until the operation is settled or cancelled.
  const rollback = await delivery.requestRollback(operator, rollbackRequest(f, one, 2), id());
  const serializedEpoch = (await delivery.lease(executor, { registration: f.registrations.serialized })).epoch;
  const granted = await claim(f, rollback.id, f.registrations.serialized, serializedEpoch);
  assert.equal(granted.operation.fencing, 'serialized');
  const three = await release(f, manifests.three);
  await assert.rejects(select(f, three, 3), /unresolved serialized operation .* no successor mutation or selection is authorized/);
  assert.equal((await state(f)).generation, 3);
  await assert.rejects(delivery.requestRollback(operator, rollbackRequest(f, two, 3), id()), /unresolved serialized operation/);
  // The executor's lease lapsing does not open the barrier either.
  await store.pool.query("UPDATE delivery_leases SET expires_at='2000-01-01' WHERE registration_id=$1", [f.registrations.serialized.id]);
  await assert.rejects(select(f, three, 3), /unresolved serialized operation/);
  const failed = await settle(f, rollback.id, granted.operation.id, 'failed', { detail: 'provider rejected the deploy' }, f.registrations.serialized, (await delivery.lease(executor, { registration: f.registrations.serialized })).epoch);
  assert.equal(failed.state, 'failed');
  await select(f, three, 3); assert.equal((await state(f)).generation, 4);
  // A cancelled unclaimed rollback is terminal; an operator cannot declare an unclaimed one applied.
  await delivery.observe(observer, snapshot(f, 4, manifests.three), id()); await delivery.sweep();
  await delivery.observe(observer, snapshot(f, 4, manifests.three, {}, false), id()); await delivery.sweep();
  const unclaimed = await delivery.requestRollback(operator, rollbackRequest(f, two, 4), id());
  await assert.rejects(delivery.resolveRollback(operator, { rollbackId: unclaimed.id, outcome: 'applied', reason: 'no', evidence: 'https://provider.example.test/ops/1' }, id()), /only be cancelled/);
  assert.equal((await delivery.resolveRollback(operator, { rollbackId: unclaimed.id, outcome: 'cancelled', reason: 'Rolling forward instead' }, id())).state, 'cancelled');
  // Unfenced adapters: never automatic, by definition and by claim.
  await assert.rejects(validation.define(operator, { kind: 'registration', id: `auto-unfenced-${f.n}`, expectedRevision: 0, principalId: executor.id, role: 'rollback', environment: f.env, adapterVersion: 'test-v1', proofs: [], enabled: true, services: ['api', 'web'], rollback: { fencing: 'none', automatic: true } }, id()), /unfenced rollback adapter cannot offer automatic rollback/);
  await assert.rejects(validation.define(operator, { kind: 'registration', id: `no-fencing-${f.n}`, expectedRevision: 0, principalId: executor.id, role: 'rollback', environment: f.env, adapterVersion: 'test-v1', proofs: [], enabled: true, services: ['api', 'web'] }, id()), /must declare their fencing/);
  await assert.rejects(validation.define(operator, { kind: 'registration', id: `observer-fencing-${f.n}`, expectedRevision: 0, principalId: observer.id, role: 'observer', environment: f.env, adapterVersion: 'test-v1', proofs: [], enabled: true, services: ['api', 'web'], rollback: { fencing: 'provider', automatic: false } }, id()), /Only rollback registrations declare/);
  // Automatic rollback is opt-in per environment and refused visibly without a fenced automatic executor.
  const g = await environment({ freshnessSeconds: 300, approvalRequired: true, automaticRollback: true }, { automatic: false });
  const { revision, createdAt, createdBy, ...second } = (await store.pool.query("SELECT document FROM validation_definitions WHERE kind='registration' AND id=$1 ORDER BY revision DESC LIMIT 1", [g.registrations.second.id])).rows[0].document;
  await validation.define(operator, { ...second, expectedRevision: revision, enabled: false }, id());
  const secondRef = { id: g.registrations.second.id, revision: revision + 2 };
  const releases = await degraded(g);
  let s = await state(g); assert.equal(s.generation, 2); assert.match(s.verification.reasons.join('\n'), /Automatic rollback refused: no enabled rollback adapter with provider or serialized fencing is registered for automatic rollback/);
  assert.equal((await delivery.status()).rollbacks.filter(r => r.environmentId === g.env.id).length, 0);
  assert.equal((await events('delivery.rollback-refused')).filter(e => e.environment === g.env.id).length, 1);
  await delivery.sweep(); assert.equal((await events('delivery.rollback-refused')).filter(e => e.environment === g.env.id).length, 1, 'an unchanged refusal is not re-announced each tick');
  // Registering a fenced automatic executor lets the next sweep roll back to the last verified release.
  await validation.define(operator, { ...second, expectedRevision: revision + 1, enabled: true }, id());
  await delivery.sweep();
  s = await state(g); assert.equal(s.generation, 3); assert.equal(s.expected?.releaseId, releases.one.id);
  const automatic = (await delivery.status()).rollbacks.find(r => r.environmentId === g.env.id)!;
  assert.equal(automatic.automatic, true); assert.equal(automatic.requestedBy, 'graphyard'); assert.equal(automatic.state, 'requested'); assert.equal(automatic.failed.incidentIds.length, 1);
  assert.equal(s.automaticRollbackRefusal, undefined);
  // An unfenced executor cannot claim an automatic rollback; a fenced automatic one can, and nothing else may act meanwhile.
  await assert.rejects(claim(g, automatic.id, g.registrations.unfenced, (await delivery.lease(executor, { registration: g.registrations.unfenced })).epoch), /fenced adapter registered for automatic rollback/);
  await assert.rejects(claim(g, automatic.id, g.registrations.serialized, (await delivery.lease(executor, { registration: g.registrations.serialized })).epoch), /fenced adapter registered for automatic rollback/);
  const auto = await claim(g, automatic.id, secondRef, (await delivery.lease(secondExecutor, { registration: secondRef })).epoch, secondExecutor);
  assert.equal(auto.operation.principal, secondExecutor.id);
  await delivery.sweep(); assert.equal((await state(g)).generation, 3, 'one rollback per generation');
  // Manual rollbacks may use an unfenced executor, behind the same serialized barrier.
  const h = await environment(); const hReleases = await degraded(h);
  const manual = await delivery.requestRollback(promoter, rollbackRequest(h, hReleases.one, 2, { delegate: { registration: h.registrations.promoter, epoch: (await delivery.lease(promoter, { registration: h.registrations.promoter })).epoch } }), id());
  const manualGrant = await claim(h, manual.id, h.registrations.unfenced, (await delivery.lease(executor, { registration: h.registrations.unfenced })).epoch);
  assert.equal(manualGrant.operation.fencing, 'none');
  await assert.rejects(select(h, await release(h, manifests.three), 3), /unresolved none operation/);
});

test('rollback HTTP routes derive authority from the credential and appear in delivery status', async () => {
  const f = await environment(); const { one } = await degraded(f);
  // Collector, builder, observer, promoter and both executors hold producer
  // credentials and count toward the review/proof agent limit the server
  // enforces at boot; raise the configurable limit for this roster.
  const configuredReviewers = process.env.GRAPHYARD_MAX_REVIEWERS; process.env.GRAPHYARD_MAX_REVIEWERS = '6';
  let http: ReturnType<typeof server>;
  try { http = server(engine, principals.map(p => ({ ...p, token: `${p.id}-token-${'x'.repeat(32)}` }))); }
  finally { if (configuredReviewers === undefined) delete process.env.GRAPHYARD_MAX_REVIEWERS; else process.env.GRAPHYARD_MAX_REVIEWERS = configuredReviewers; }
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as any).port}`;
  const call = async (actor: Principal, path: string, body?: unknown) => { const response = await fetch(`${url}/api/${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${actor.id}-token-${'x'.repeat(32)}`, 'Content-Type': 'application/json', 'Idempotency-Key': id() }, body: body ? JSON.stringify(body) : undefined }); return { status: response.status, body: await response.json() as any }; };
  try {
    assert.equal((await call(worker, 'delivery/rollback', rollbackRequest(f, one, 2))).status, 403);
    assert.equal((await call(executor, 'delivery/rollback', rollbackRequest(f, one, 2))).status, 403);
    const requested = await call(operator, 'delivery/rollback', rollbackRequest(f, one, 2)); assert.equal(requested.status, 200);
    assert.equal((await call(worker, 'delivery/rollback-claim', { rollbackId: requested.body.id, registration: f.registrations.executor, epoch: f.executorEpoch })).status, 403);
    const claimed = await call(executor, 'delivery/rollback-claim', { rollbackId: requested.body.id, registration: f.registrations.executor, epoch: f.executorEpoch }); assert.equal(claimed.status, 200);
    assert.equal((await call(executor, 'delivery/rollback-resolve', { rollbackId: requested.body.id, outcome: 'applied', reason: 'no', evidence: 'https://provider.example.test/ops/1' })).status, 403);
    assert.equal((await call(reader, 'delivery')).body.rollbacks.find((r: RollbackRequest) => r.id === requested.body.id).state, 'in-flight');
    assert.equal((await call(worker, 'validation/capacity')).status, 404);
    assert.equal((await call(worker, 'validation/artifacts/migrate', { target: 'postgres' })).status, 404);
  } finally { await new Promise<void>(resolve => http.close(() => resolve())); }
});
