import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { Validation, type ValidationRequest, type ValidationCandidate } from '../src/validation.js';
import { defineScenario } from '../src/scenarios.js';
import { type Principal, type Work, evaluate } from '../src/model.js';
import { server } from '../src/server.js';
import { proofPreview } from '../src/coordination.js';
import type { Definition } from '../src/validation.js';
const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const runner: Principal = { id: 'runner', role: 'worker' };
const collector: Principal = { id: 'collector', role: 'producer', proofs: [] };
const builder: Principal = { id: 'builder', role: 'producer' };
const principals = [operator, worker, runner, collector, builder];
const sha = 'a'.repeat(40), base = 'b'.repeat(40), digest = `sha256:${'c'.repeat(64)}`, inputs = `sha256:${'d'.repeat(64)}`;
let pg: EmbeddedPostgres, store: Store, engine: Engine, validation: Validation;
let serial = 0;
before(async () => {
  const port = Number(process.env.GRAPHYARD_VALIDATION_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1);
  pg = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-validation-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('validation_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/validation_test`); await store.init(); engine = new Engine(store); validation = new Validation(engine, principals, 'test/repository');
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });
const id = () => randomUUID();
async function definitions(): Promise<Definition[]> { return (await store.pool.query('SELECT document FROM validation_definitions ORDER BY kind,id,revision DESC')).rows.map(r => r.document); }
async function current(workId: string) { return (await store.list()).find(w => w.id === workId)!; }
async function fixture() {
  const n = ++serial, environment = { id: `preview-${n}`, revision: 1 }, runnerRef = { id: `runner-${n}`, revision: 1 }, collectorRef = { id: `collector-${n}`, revision: 1 }, builderRef = { id: `builder-${n}`, revision: 1 }, bundle = { id: `bundle-${n}`, revision: 1 }, proof = `e2e:scenario-${n}`;
  collector.proofs!.push(proof);
  const scenario = await defineScenario(store, operator, { id: `scenario-${n}`, title: 'Behavior', purpose: 'Prove behavior', steps: ['Execute'], expected: ['Correct'], environment: environment.id, runner: 'playwright', testPath: 'tests/behavior.spec.ts' }, id());
  await validation.define(operator, { kind: 'environment', id: environment.id, expectedRevision: 0, repository: 'test/repository', url: 'https://preview.example.test', instance: `instance-${n}`, immutable: true, services: ['api'], resources: [`test-account-${n}`] }, id());
  for (const [ref, actor, role] of [[runnerRef, runner, 'runner'], [collectorRef, collector, 'collector'], [builderRef, builder, 'builder']] as const) await validation.define(operator, { kind: 'registration', id: ref.id, expectedRevision: 0, principalId: actor.id, role, environment, adapterVersion: 'test-v1', proofs: role === 'collector' ? [proof] : [], enabled: true }, id());
  await validation.define(operator, { kind: 'bundle', id: bundle.id, expectedRevision: 0, scenario: scenario.id, scenarioRevision: scenario.revision, scenarioHash: scenario.hash, digest, runnerImageDigest: inputs }, id());
  let w = await engine.execute(operator, 'create', null, { title: 'Validation fixture', criteria: [{ id: 'AC-1', text: 'Behavior is proven', proofs: [proof] }] }, id());
  w = await engine.execute(operator, 'ready', w.id, {}, id()); w = await engine.execute(worker, 'claim', w.id, {}, id());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/validation-${n}`, branch: `graphyard/validation-${n}` }, id());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: n }, id());
  w = await engine.observe(w.id, w.revision, { candidate: { sha, baseSha: base, pr: n, branch: `graphyard/validation-${n}`, author: 'implementer' }, checks: [{ name: 'test', appId: 15368, result: 'success' }, { name: 'typecheck', appId: 15368, result: 'success' }], reviews: [{ reviewer: 'other', sha, state: 'APPROVED' }], merged: false, mergeSha: null, protected: true, mergeable: true, files: [], at: new Date().toISOString() });
  const build: any = await validation.attestBuild(builder, { registration: builderRef, workId: w.id, expectedWorkRevision: w.revision, sourceSha: sha, baseSha: base, buildInputsDigest: inputs, artifacts: [{ service: 'api', digest }], provenanceUrl: 'https://ci.example.test/build/1' }, id());
  const candidateInput = { workId: w.id, expectedWorkRevision: w.revision, proof, environment, bundle, buildAttestationId: build.id, requiredArtifacts: ['report'] };
  const c = await validation.createCandidate(operator, candidateInput, id()) as ValidationCandidate;
  const requestInput = { candidateId: c.id, expectedWorkRevision: (await current(w.id)).revision, runner: runnerRef, collector: collectorRef, deadline: new Date(Date.now() + 600_000).toISOString(), maxAttempts: 3 };
  const r = await validation.createRequest(operator, requestInput, id()) as ValidationRequest;
  return { n, w, c, r, proof, environment, runnerRef, collectorRef, builderRef, candidateInput, requestInput };
}
async function start(f: Awaited<ReturnType<typeof fixture>>) {
  const d: any = await validation.dispatch(runner, { registration: f.runnerRef }, id()); assert.equal(d.request.id, f.r.id);
  const command = { requestId: f.r.id, attemptId: d.attempt.id, epoch: d.attempt.epoch };
  await validation.runnerCommand(runner, 'ack', command, id()); return command;
}
function report(f: Awaited<ReturnType<typeof fixture>>, command: { requestId: string; attemptId: string; epoch: number }) {
  return { ...command, execution: 'completed', behavior: 'passed', executed: 2, skipped: 0, inventoryComplete: true, target: { instance: `instance-${f.n}`, artifacts: [{ service: 'api', digest }], measurement: 'provider', coversEntireRun: true }, bundleDigest: digest, runnerImageDigest: inputs, artifacts: [{ name: 'report', digest, url: 'https://private.example.test/report' }], executionSettled: true };
}
async function expire(f: Awaited<ReturnType<typeof fixture>>) {
  await store.pool.query("UPDATE validation_requests SET document=jsonb_set(document,'{attempts,0,expiresAt}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=$1", [f.r.id]); await validation.reconcile();
}
async function cleanup(f: Awaited<ReturnType<typeof fixture>>) {
  const r = (await validation.list()).requests.find(r => r.id === f.r.id)!;
  if (['queued', 'dispatched', 'running'].includes(r.state)) await validation.operatorCommand(operator, 'cancel', { requestId: r.id, epoch: r.attempts.at(-1)?.epoch ?? 0, reason: 'Test process never launched' }, id());
  const a = r.attempts.at(-1); if (a && !a.settled) await validation.operatorCommand(operator, 'settle', { requestId: r.id, epoch: a.epoch, reason: 'Fixture has no external process', settlementEvidence: 'https://tests.example.test/no-process' }, id());
}

test('authority creation rejects workers, stale config, invalid provenance and weakened targets', async () => {
  const f = await fixture();
  await assert.rejects(validation.createCandidate(worker, f.candidateInput, id()), /Operator/);
  await assert.rejects(validation.createRequest(worker, f.requestInput, id()), /Operator/);
  await assert.rejects(validation.attestBuild(worker, {}, id()), /separately authorized/);
  await assert.rejects(validation.define(worker, {}, id()), /Operator/);
  const env = (await definitions()).find(d => d.kind === 'environment' && d.id === f.environment.id)!;
  const { revision: rev, createdAt, createdBy, ...data } = env;
  await assert.rejects(validation.define(operator, data, id()), /generation changed/);
  for (const override of [{ buildAttestationId: id() }, { proof: 'e2e:unrequired' }, { environment: { id: 'not-approved', revision: 1 } }]) await assert.rejects(validation.createCandidate(operator, { ...f.candidateInput, expectedWorkRevision: (await current(f.w.id)).revision, ...override }, id()));
  await cleanup(f);
});
test('independent pools race one runner slot and restart preserves dispatch/ACK/history', async () => {
  const f = await fixture(), second = new Store(store.pool.options.connectionString!);
  try {
    const replica = new Validation(new Engine(second), principals, 'test/repository');
    const results: any[] = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? validation : replica).dispatch(runner, { registration: f.runnerRef }, id())));
    assert.equal(results.filter(r => r.request).length, 1);
    const d = results.find(r => r.request); assert.deepEqual(d.build.artifacts, [{ service: 'api', digest }]); assert.equal(d.build.producer, builder.id); const command = { requestId: f.r.id, attemptId: d.attempt.id, epoch: 1 };
    await assert.rejects(replica.runnerCommand(worker, 'ack', command, id()), /Wrong runner/);
    await assert.rejects(replica.runnerCommand(runner, 'heartbeat', command, id()), /ACK/);
    const receipt = id(); const ack = await replica.runnerCommand(runner, 'ack', command, receipt);
    assert.deepEqual(await replica.runnerCommand(runner, 'ack', command, receipt), ack);
    assert.equal((await replica.list()).requests.find(r => r.id === f.r.id)?.state, 'running');
    const outcome: any = await replica.result(collector, report(f, command), id()); assert.equal(outcome.passed, true);
    assert.equal((await current(f.w.id)).gates.find(g => g.name === 'acceptance')?.passed, true);
  } finally { await cleanup(f); await second.close(); }
});
test('result receipts deduplicate evidence and a newer request prevents old-pass fallback', async () => {
  const f = await fixture(), command = await start(f), key = id();
  const result = await validation.result(collector, report(f, command), key);
  assert.deepEqual(await validation.result(collector, report(f, command), key), result);
  assert.equal((await current(f.w.id)).evidence.length, 1);
  const late: any = await validation.result(collector, report(f, command), id()); assert.equal(late.accepted, false);
  await validation.createRequest(operator, { ...f.requestInput, expectedWorkRevision: (await current(f.w.id)).revision }, id());
  let w = await current(f.w.id); assert.equal(w.gates.find(g => g.name === 'acceptance')?.passed, false); assert.equal(w.mergeAuthorization, null);
  w = await engine.execute({ ...collector, proofs: [f.proof] }, 'evidence', w.id, { proof: f.proof, sha, baseSha: base, policyRevision: 1, executed: 1, skipped: 0, result: 'pass', scenarioRevision: 1, environment: f.environment.id }, id());
  assert.equal(w.gates.find(g => g.name === 'acceptance')?.passed, false, 'generic evidence cannot bypass pinned attempt');
  await cleanup(f);
});
test('unacknowledged timeout is recoverable and stale ACK cannot start an old epoch', async () => {
  const f = await fixture(), d: any = await validation.dispatch(runner, { registration: f.runnerRef }, id());
  await expire(f);
  assert.equal((await validation.list()).requests.find(r => r.id === f.r.id)?.attempts[0].settled, true);
  await validation.operatorCommand(operator, 'retry', { requestId: f.r.id, epoch: 1, reason: 'No ACK, no authorized execution' }, id());
  const next: any = await validation.dispatch(runner, { registration: f.runnerRef }, id()); assert.equal(next.attempt.epoch, 2);
  await assert.rejects(validation.runnerCommand(runner, 'ack', { requestId: f.r.id, attemptId: d.attempt.id, epoch: 1 }, id()), /expired|superseded/);
  await cleanup(f);
});
test('lost running lease blocks resource reassignment until independently settled', async () => {
  const f = await fixture(), command = await start(f); await expire(f);
  await assert.rejects(validation.operatorCommand(operator, 'retry', { requestId: f.r.id, epoch: 1, reason: 'Try again' }, id()), /settled/);
  const late: any = await validation.result(collector, report(f, command), id()); assert.equal(late.accepted, false);
  assert.equal((await store.pool.query('SELECT * FROM validation_resources WHERE request_id=$1', [f.r.id])).rowCount, 3);
  await validation.operatorCommand(operator, 'settle', { requestId: f.r.id, epoch: 1, reason: 'Verified no process in fixture', settlementEvidence: 'https://test.example.test/settlement' }, id());
  await validation.operatorCommand(operator, 'retry', { requestId: f.r.id, epoch: 1, reason: 'Safe after settlement' }, id());
  assert.equal((await validation.list()).requests.find(r => r.id === f.r.id)?.state, 'queued'); await cleanup(f);
});
test('revocation invalidates current and completed authority across replicas without dropping resources', async () => {
  const f = await fixture(), command = await start(f);
  const registration = (await definitions()).find(d => d.kind === 'registration' && d.id === f.runnerRef.id)!;
  const { revision, createdAt, createdBy, ...data } = registration;
  await validation.define(operator, { ...data, expectedRevision: revision, enabled: false }, id());
  assert.equal((await validation.list()).requests.find(r => r.id === f.r.id)?.state, 'superseded');
  const result: any = await validation.result(collector, report(f, command), id()); assert.equal(result.accepted, false);
  assert.equal((await current(f.w.id)).evidence.length, 0);
  assert.ok((await store.events(f.w.id)).some(e => e.kind === 'validation.result-rejected'));
  assert.equal((await store.pool.query('SELECT * FROM validation_resources WHERE request_id=$1', [f.r.id])).rowCount, 3); await cleanup(f);
});
test('cancellation preserves history and rejects late success without losing its audit', async () => {
  const f = await fixture(), command = await start(f);
  await validation.operatorCommand(operator, 'cancel', { requestId: f.r.id, epoch: 1, reason: 'Operator cancelled' }, id());
  const key = id(), result: any = await validation.result(collector, report(f, command), key); assert.equal(result.accepted, false);
  assert.deepEqual(await validation.result(collector, report(f, command), key), result);
  assert.equal((await store.events(f.w.id)).filter(e => e.kind === 'validation.result-rejected').length, 1); await cleanup(f);
});
test('empty, skipped, mismatched, unknown and incomplete reports never pass', async () => {
  for (const change of [{ executed: 0 }, { skipped: 1 }, { artifacts: [] }, { inventoryComplete: false }, { bundleDigest: inputs }, { executionSettled: false }, { behavior: 'blocked' }]) {
    const f = await fixture(), command = await start(f);
    const result: any = await validation.result(collector, { ...report(f, command), ...change }, id()); assert.equal(result.accepted, true); assert.equal(result.passed, false);
    assert.equal((await current(f.w.id)).gates.find(g => g.name === 'acceptance')?.passed, false); await cleanup(f);
  }
  for (const change of [{ measurement: 'unknown' }, { coversEntireRun: false }, { instance: 'wrong' }, { artifacts: [{ service: 'api', digest: inputs }] }]) {
    const f = await fixture(), command = await start(f), good = report(f, command);
    const result: any = await validation.result(collector, { ...good, target: { ...good.target, ...change } }, id()); assert.equal(result.passed, false); await cleanup(f);
  }
});
test('new source invalidates running attempts and worker cannot publish trusted reports', async () => {
  const f = await fixture(), command = await start(f);
  await assert.rejects(validation.result(worker, report(f, command), id()), /separate trusted/);
  await assert.rejects(validation.result(builder, report(f, command), id()), /Wrong collector/);
  const w = await current(f.w.id); await engine.observe(w.id, w.revision, { ...w.observation!, candidate: { ...w.candidate!, sha: 'f'.repeat(40) }, at: new Date().toISOString() });
  const result: any = await validation.result(collector, report(f, command), id()); assert.equal(result.accepted, false); await cleanup(f);
});
test('HTTP validation endpoints enforce authenticated roles', async () => {
  const http = server(engine, [{ ...worker, token: 'w'.repeat(32) }]);
  await new Promise<void>(r => http.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${(http.address() as any).port}/api/validation`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${'w'.repeat(32)}` } })).status, 200);
    assert.equal((await fetch(`${url}/define`, { method: 'POST', headers: { Authorization: `Bearer ${'w'.repeat(32)}`, 'Content-Type': 'application/json', 'Idempotency-Key': id() }, body: '{}' })).status, 403);
  } finally { await new Promise<void>(r => http.close(() => r())); }
});

test('replayed execution grants cannot revive revoked authority or expired ACKs', async () => {
  const f = await fixture(), dispatchKey = id();
  const d: any = await validation.dispatch(runner, { registration: f.runnerRef }, dispatchKey);
  const command = { requestId: f.r.id, attemptId: d.attempt.id, epoch: 1 }, ackKey = id();
  await validation.runnerCommand(runner, 'ack', command, ackKey); await expire(f);
  await assert.rejects(validation.runnerCommand(runner, 'ack', command, ackKey), /expired|superseded/);
  await assert.rejects(validation.dispatch(runner, { registration: f.runnerRef }, dispatchKey), /expired|superseded/); await cleanup(f);
});
test('requirement revisions invalidate reports and completed evidence; changing oracle bytes requires a new scenario', async () => {
  const f = await fixture(), command = await start(f);
  await validation.result(collector, report(f, command), id());
  await engine.execute(worker, 'release', f.w.id, { epoch: 1 }, id());
  let w = await current(f.w.id);
  w = await engine.execute(operator, 'requirements', w.id, { expectedPolicyRevision: w.policyRevision, reason: 'Refined acceptance requirement', criteria: w.criteria.map(ac => ({ ...ac, text: 'Updated behavior assertion' })), dependencies: [], plannedFiles: [], exclusiveResources: [] }, id());
  await validation.reconcile();
  assert.equal((await validation.list()).requests.find(r => r.id === f.r.id)?.state, 'superseded');
  assert.equal((await current(w.id)).gates.find(g => g.name === 'acceptance')?.passed, false);
  const bundle = (await definitions()).find(d => d.kind === 'bundle' && d.id === f.c.bundle.id)!;
  const { revision, createdAt, createdBy, ...data } = bundle;
  await assert.rejects(validation.define(operator, { ...data, expectedRevision: revision, digest: inputs }, id()), /new scenario/); await cleanup(f);
});

test('operators can record revocation after a credential is removed from configuration', async () => {
  const f = await fixture(), command = await start(f);
  const withoutRunner = new Validation(engine, principals.filter(p => p.id !== runner.id), 'test/repository');
  const registration = (await definitions()).find(d => d.kind === 'registration' && d.id === f.runnerRef.id)!;
  const { revision, createdAt, createdBy, ...data } = registration;
  await withoutRunner.define(operator, { ...data, expectedRevision: revision, enabled: false }, id());
  const result: any = await withoutRunner.result(collector, report(f, command), id()); assert.equal(result.accepted, false); await cleanup(f);
});

test('result publication racing revocation across replicas cannot leave accepted current evidence', async () => {
  const f = await fixture(), command = await start(f), second = new Store(store.pool.options.connectionString!);
  try {
    const replica = new Validation(new Engine(second), principals, 'test/repository');
    const registration = (await definitions()).find(d => d.kind === 'registration' && d.id === f.collectorRef.id)!;
    const { revision, createdAt, createdBy, ...data } = registration;
    const outcomes = await Promise.allSettled([
      replica.result(collector, report(f, command), id()),
      validation.define(operator, { ...data, expectedRevision: revision, enabled: false }, id()),
    ]);
    assert.ok(outcomes.every(r => r.status === 'fulfilled'));
    const w = await current(f.w.id);
    assert.equal(w.gates.find(g => g.name === 'acceptance')?.passed, false);
    assert.equal(w.mergeAuthorization, null);
    assert.equal((await replica.list()).requests.find(r => r.id === f.r.id)?.state, 'superseded');
    const late: any = await replica.result(collector, report(f, command), id()); assert.equal(late.accepted, false);
  } finally { await cleanup(f); await second.close(); }
});
test('authorized build producers still cannot attest a mismatched source or incomplete manifest', async () => {
  const f = await fixture();
  const good = { registration: f.builderRef, workId: f.w.id, expectedWorkRevision: (await current(f.w.id)).revision, sourceSha: sha, baseSha: base, buildInputsDigest: inputs, artifacts: [{ service: 'api', digest }], provenanceUrl: 'https://ci.example.test/build/2' };
  await assert.rejects(validation.attestBuild(builder, { ...good, sourceSha: 'f'.repeat(40) }, id()), /Build source differs/);
  await assert.rejects(validation.attestBuild(builder, { ...good, artifacts: [{ service: 'wrong-service', digest }] }, id()), /complete service manifest/);
  await cleanup(f);
});

test('builder and collector registrations cannot collapse onto one producer principal', async () => {
  const f = await fixture();
  const shared = { id: `shared-builder-${f.n}`, revision: 1 };
  await validation.define(operator, { kind: 'registration', id: shared.id, expectedRevision: 0, principalId: collector.id, role: 'builder', environment: f.environment, adapterVersion: 'test-v1', proofs: [], enabled: true }, id());
  const build: any = await validation.attestBuild(collector, { registration: shared, workId: f.w.id, expectedWorkRevision: (await current(f.w.id)).revision, sourceSha: sha, baseSha: base, buildInputsDigest: inputs, artifacts: [{ service: 'api', digest }], provenanceUrl: 'https://ci.example.test/build/shared' }, id());
  const c: any = await validation.createCandidate(operator, { ...f.candidateInput, expectedWorkRevision: (await current(f.w.id)).revision, buildAttestationId: build.id }, id());
  await assert.rejects(validation.createRequest(operator, { ...f.requestInput, candidateId: c.id, expectedWorkRevision: (await current(f.w.id)).revision }, id()), /distinct principals/); await cleanup(f);
});
test('completed evidence is retained across idle ticks but revoked on definition changes', async () => {
  const f = await fixture(), command = await start(f); await validation.result(collector, report(f, command), id());
  const before = (await store.events(f.w.id)).length;
  await validation.reconcile(); await validation.reconcile();
  assert.equal((await store.events(f.w.id)).length, before);
  assert.equal((await validation.list()).requests.find(r => r.id === f.r.id)?.state, 'completed');
  const registration = (await definitions()).find(d => d.kind === 'registration' && d.id === f.builderRef.id)!;
  const { revision, createdAt, createdBy, ...data } = registration;
  await validation.define(operator, { ...data, expectedRevision: revision, enabled: false }, id());
  assert.equal((await current(f.w.id)).gates.find(g => g.name === 'acceptance')?.passed, false);
  assert.equal((await validation.list()).requests.find(r => r.id === f.r.id)?.state, 'superseded'); await cleanup(f);
});

test('cancelling or expiring a queued retry preserves its settled attempt outcome', async () => {
  for (const terminate of ['cancel', 'expire'] as const) {
    const f = await fixture(), command = await start(f); await validation.result(collector, report(f, command), id());
    const previous = (await validation.list()).requests.find(r => r.id === f.r.id)!.attempts[0];
    await validation.operatorCommand(operator, 'retry', { requestId: f.r.id, epoch: 1, reason: 'Rerun' }, id());
    if (terminate === 'cancel') await validation.operatorCommand(operator, 'cancel', { requestId: f.r.id, epoch: 1, reason: 'Cancel queued retry' }, id());
    else { await store.pool.query("UPDATE validation_requests SET document=jsonb_set(document,'{deadline}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=$1", [f.r.id]); await validation.reconcile(); }
    assert.deepEqual((await validation.list()).requests.find(r => r.id === f.r.id)!.attempts[0], previous); await cleanup(f);
  }
});
test('superseding a never-ACKed dispatch releases resources and refuses late ACK', async () => {
  const f = await fixture(), d: any = await validation.dispatch(runner, { registration: f.runnerRef }, id());
  const registration = (await definitions()).find(d => d.kind === 'registration' && d.id === f.runnerRef.id)!;
  const { revision, createdAt, createdBy, ...data } = registration;
  await validation.define(operator, { ...data, expectedRevision: revision, enabled: false }, id());
  const r = (await validation.list()).requests.find(r => r.id === f.r.id)!;
  assert.equal(r.attempts[0].settled, true); assert.equal(r.state, 'superseded');
  assert.equal((await store.pool.query('SELECT * FROM validation_resources WHERE request_id=$1', [r.id])).rowCount, 0);
  await assert.rejects(validation.runnerCommand(runner, 'ack', { requestId: r.id, attemptId: d.attempt.id, epoch: 1 }, id()), /superseded|revoked/); await cleanup(f);
});

test('request and definition pages are bounded and stable under newer inserts', async () => {
  const f = await fixture();
  for (let i = 0; i < 24; i++) await validation.createRequest(operator, { ...f.requestInput, expectedWorkRevision: (await current(f.w.id)).revision }, id());
  const first = await validation.list(); assert.equal(first.requests.length, 20); assert.ok(first.nextCursor);
  assert.ok(first.candidates.length <= first.requests.length);
  await validation.createRequest(operator, { ...f.requestInput, expectedWorkRevision: (await current(f.w.id)).revision }, id());
  const second = await validation.list(first.nextCursor!);
  assert.ok(second.requests.length <= 20); assert.ok(second.requests.every(r => !first.requests.some(x => x.id === r.id)));
  const a = await validation.definitions(); assert.equal(a.definitions.length, 50); assert.ok(a.nextCursor);
  const b = await validation.definitions(a.nextCursor!);
  assert.ok(b.definitions.length <= 50);
  assert.ok(b.definitions.every(r => !a.definitions.some(x => x.kind === r.kind && x.id === r.id && x.revision === r.revision)));
  const detail = await validation.readCandidate(f.c.id); assert.equal(detail.id, f.c.id); assert.equal(detail.build.sourceSha, sha);
  await assert.rejects(validation.list('invalid-cursor'));
});
test('proof previews reject generic and superseded validation passes just like gates', async () => {
  const f = await fixture();
  let w = await current(f.w.id);
  w = await engine.execute(collector, 'evidence', w.id, { proof: f.proof, sha, baseSha: base, policyRevision: 1, result: 'pass', executed: 1, skipped: 0, scenarioRevision: 1, environment: f.environment.id }, id());
  assert.equal(proofPreview(w)[0].status, 'unmeasured');
  const command = await start(f); await validation.result(collector, report(f, command), id());
  w = await current(f.w.id); assert.equal(proofPreview(w)[0].status, 'passed');
  await validation.createRequest(operator, { ...f.requestInput, expectedWorkRevision: w.revision }, id());
  w = await current(f.w.id); assert.equal(proofPreview(w)[0].status, 'unmeasured');
  assert.equal(w.gates.find(g => g.name === 'acceptance')?.passed, false); await cleanup(f);
});
