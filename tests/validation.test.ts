import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { Validation, type ValidationRequest, type ValidationCandidate } from '../src/validation.js';
import { acknowledgeAttempt } from '../src/runner-executor.js';
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
const attestationPublicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
const sha = 'a'.repeat(40), base = 'b'.repeat(40), digest = `sha256:${'c'.repeat(64)}`, inputs = `sha256:${'d'.repeat(64)}`;
let pg: EmbeddedPostgres, store: Store, engine: Engine, validation: Validation;
let serial = 0;
before(async () => {
  const port = Number(process.env.GRAPHYARD_VALIDATION_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1);
  pg = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-validation-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('validation_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/validation_test`); await store.init(); engine = new Engine(store, [15368], 120, 'test/repository'); validation = new Validation(engine, principals, 'test/repository');
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });
const id = () => randomUUID();
async function definitions(): Promise<Definition[]> { return (await store.pool.query('SELECT document FROM validation_definitions ORDER BY kind,id,revision DESC')).rows.map(r => r.document); }
async function current(workId: string) { return (await store.list()).find(w => w.id === workId)!; }
/** `runnerAuthority` adds execution authority the operator pinned on the runner registration. */
async function fixture(artifactStorage: 'external' | 'postgres' = 'external', runnerAuthority: Record<string, unknown> = {}, slice?: Work['slice']) {
  const n = ++serial, environment = { id: `preview-${n}`, revision: 1 }, runnerRef = { id: `runner-${n}`, revision: 1 }, collectorRef = { id: `collector-${n}`, revision: 1 }, builderRef = { id: `builder-${n}`, revision: 1 }, bundle = { id: `bundle-${n}`, revision: 1 }, proof = `e2e:scenario-${n}`;
  collector.proofs!.push(proof);
  const scenario = await defineScenario(store, operator, { id: `scenario-${n}`, title: 'Behavior', purpose: 'Prove behavior', steps: ['Execute'], expected: ['Correct'], environment: environment.id, runner: 'playwright', testPath: 'tests/behavior.spec.ts' }, id());
  await validation.define(operator, { kind: 'environment', id: environment.id, expectedRevision: 0, repository: 'test/repository', url: 'https://preview.example.test', instance: `instance-${n}`, immutable: true, services: ['api'], resources: [`test-account-${n}`] }, id());
  for (const [ref, actor, role] of [[runnerRef, runner, 'runner'], [collectorRef, collector, 'collector'], [builderRef, builder, 'builder']] as const) await validation.define(operator, { kind: 'registration', id: ref.id, expectedRevision: 0, principalId: actor.id, role, environment, adapterVersion: 'test-v1', proofs: role === 'collector' ? [proof] : [], enabled: true, ...(role === 'runner' ? { executionHost: 'unix:///var/run/docker.sock', attestationPublicKey, executionNetwork: 'gy-isolated', ...runnerAuthority } : {}) }, id());
  await validation.define(operator, { kind: 'bundle', id: bundle.id, expectedRevision: 0, scenario: scenario.id, scenarioRevision: scenario.revision, scenarioHash: scenario.hash, digest, runnerImageDigest: inputs }, id());
  let w = await engine.execute(operator, 'create', null, { title: 'Validation fixture', ...(slice ? { slice } : {}), criteria: [{ id: 'AC-1', text: 'Behavior is proven', proofs: [proof] }] }, id());
  w = await engine.execute(operator, 'ready', w.id, {}, id()); w = await engine.execute(worker, 'claim', w.id, {}, id());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/validation-${n}`, branch: `graphyard/validation-${n}` }, id());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: n }, id());
  w = await engine.observe(w.id, w.revision, { candidate: { sha, baseSha: base, pr: n, branch: `graphyard/validation-${n}`, author: 'implementer' }, checks: [{ name: 'test', appId: 15368, result: 'success' }, { name: 'typecheck', appId: 15368, result: 'success' }], reviews: [{ reviewer: 'other', sha, state: 'APPROVED' }], merged: false, mergeSha: null, protected: true, mergeable: true, files: [], scopeFiles: [], at: new Date().toISOString() });
  const build: any = await validation.attestBuild(builder, { registration: builderRef, workId: w.id, expectedWorkRevision: w.revision, sourceSha: sha, baseSha: base, buildInputsDigest: inputs, artifacts: [{ service: 'api', digest }], provenanceUrl: 'https://ci.example.test/build/1' }, id());
  const candidateInput = { workId: w.id, expectedWorkRevision: w.revision, proof, environment, bundle, buildAttestationId: build.id, requiredArtifacts: ['report'], artifactStorage };
  const c = await validation.createCandidate(operator, candidateInput, id()) as ValidationCandidate;
  const requestInput = { candidateId: c.id, expectedWorkRevision: (await current(w.id)).revision, runner: runnerRef, collector: collectorRef, deadline: new Date(Date.now() + 600_000).toISOString(), maxAttempts: 3 };
  const r = await validation.createRequest(operator, requestInput, id()) as ValidationRequest;
  return { n, w, c, r, proof, environment, runnerRef, collectorRef, builderRef, candidateInput, requestInput };
}
async function start(f: Awaited<ReturnType<typeof fixture>>) {
  const d: any = await validation.dispatch(runner, { registration: f.runnerRef }, id()); assert.equal(d.request.id, f.r.id);
  const command = { requestId: f.r.id, attemptId: d.attempt.id, epoch: d.attempt.epoch };
  await validation.runnerCommand(runner, 'ack', command, id());
  // Publishing anything about an attempt happens under collection authority, which
  // revokes the runner's before settlement can be observed.
  await validation.collectionAuthority(collector, command); return command;
}
function report(f: Awaited<ReturnType<typeof fixture>>, command: { requestId: string; attemptId: string; epoch: number }) {
  return { ...command, execution: 'completed', behavior: 'passed', executed: 2, skipped: 0, inventoryComplete: true, target: { instance: `instance-${f.n}`, artifacts: [{ service: 'api', digest }], measurement: 'provider', coversEntireRun: true, attribution: 'matched' }, bundleDigest: digest, runnerImageDigest: inputs, artifacts: [{ name: 'report', digest, url: 'https://private.example.test/report' }], artifactState: 'verified', executionSettled: true };
}
async function expire(f: Awaited<ReturnType<typeof fixture>>) {
  await store.pool.query("UPDATE validation_requests SET document=jsonb_set(document,'{attempts,0,expiresAt}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=$1", [f.r.id]); await validation.reconcile();
}
async function cleanup(f: Awaited<ReturnType<typeof fixture>>) {
  const r = (await validation.list()).requests.find(r => r.id === f.r.id)!;
  if (['queued', 'dispatched', 'running', 'collecting'].includes(r.state)) await validation.operatorCommand(operator, 'cancel', { requestId: r.id, epoch: r.attempts.at(-1)?.epoch ?? 0, reason: 'Test process never launched' }, id());
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
    // The runner's acknowledgement against the real service, with the first response lost
    // after the commit: the retry replays the receipt, and the replayed request document is
    // what the runner accepts as its confirmation — so the replay must be a confirmation.
    let sends = 0;
    const confirmed = await acknowledgeAttempt(async (path, body, key) => {
      assert.equal(path, 'validation/ack');
      const result = await replica.runnerCommand(runner, 'ack', body, key);
      if (++sends === 1) throw new TypeError('fetch failed');
      return result;
    }, command, { retryMs: 0, sleep: async () => {} });
    assert.equal(confirmed.sends, 2);
    const ack: any = await replica.runnerCommand(runner, 'ack', command, `${command.attemptId}-ack`);
    assert.deepEqual(await replica.runnerCommand(runner, 'ack', command, `${command.attemptId}-ack`), ack);
    assert.equal(ack.attempts.at(-1).acknowledgedAt, confirmed.acknowledgedAt);
    assert.equal((await replica.list()).requests.find(r => r.id === f.r.id)?.state, 'running');
    // A different key is a second acknowledgement, and the service refuses it as such:
    // the runner retries with its stable key precisely so it never sends one.
    await assert.rejects(replica.runnerCommand(runner, 'ack', command, id()), /Attempt already acknowledged/);
    await replica.collectionAuthority(collector, command);
    assert.equal((await replica.list()).requests.find(r => r.id === f.r.id)?.state, 'collecting');
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
  for (const change of [{ executed: 0 }, { skipped: 1 }, { artifacts: [] }, { artifactState: 'upload-failed' }, { artifactState: 'expired' }, { inventoryComplete: false }, { bundleDigest: inputs }, { executionSettled: false }, { behavior: 'blocked' }]) {
    const f = await fixture(), command = await start(f);
    const result: any = await validation.result(collector, { ...report(f, command), ...change }, id()); assert.equal(result.accepted, true); assert.equal(result.passed, false);
    assert.equal((await current(f.w.id)).gates.find(g => g.name === 'acceptance')?.passed, false); await cleanup(f);
  }
  for (const change of [{ measurement: 'unknown' }, { coversEntireRun: false }, { attribution: 'changed' }, { attribution: 'mismatched' }, { attribution: 'unknown' }, { instance: 'wrong' }, { artifacts: [{ service: 'api', digest: inputs }] }]) {
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
test('collection authority fences the runner before settlement can release resources', async () => {
  const f = await fixture('postgres'), d: any = await validation.dispatch(runner, { registration: f.runnerRef }, id());
  const command = { requestId: f.r.id, attemptId: d.attempt.id, epoch: d.attempt.epoch };
  await validation.runnerCommand(runner, 'ack', command, id());

  // Settlement observed while the runner may still act proves nothing: a container can be
  // started again after the observation. Nothing is publishable before the handoff.
  await assert.rejects(validation.collectionHeartbeat(collector, command, id()), /collection authority was never taken over/);
  await assert.rejects(validation.uploadArtifact(collector, { ...command, name: 'report', mediaType: 'application/json', bytes: Buffer.from('{}').toString('base64'), capturePolicy: 'approved-test-data-only' }, id()), /collection authority was never taken over/);
  const early: any = await validation.result(collector, report(f, command), id());
  assert.equal(early.accepted, false);
  assert.ok(early.reasons.some((r: string) => /collection authority/.test(r)));
  assert.equal((await current(f.w.id)).evidence.length, 0);

  const authority: any = await validation.collectionAuthority(collector, command);
  assert.equal(authority.attemptId, d.attempt.id);
  assert.equal((await validation.list()).requests.find(r => r.id === f.r.id)?.state, 'collecting');
  // The runner's lease is gone: it cannot renew, and it cannot start another phase.
  await assert.rejects(validation.runnerCommand(runner, 'heartbeat', command, id()), /expired, cancelled or superseded/);
  await assert.rejects(validation.runnerCommand(runner, 'ack', command, id()), /expired, cancelled or superseded/);
  // Recovery still cannot release the barrier under an active collection.
  await assert.rejects(validation.operatorCommand(operator, 'settle', { requestId: f.r.id, epoch: command.epoch, reason: 'Premature', settlementEvidence: 'https://tests.example.test/premature' }, id()), /Terminate\/cancel first/);
  // The handoff is idempotent for a collector that re-reads its authority mid-collection.
  await validation.collectionAuthority(collector, command);
  await validation.collectionHeartbeat(collector, command, id());
  const outcome: any = await validation.result(collector, { ...report(f, command), artifacts: [] }, id());
  assert.equal(outcome.accepted, true);
  await cleanup(f);
});

test('HTTP validation endpoints enforce authenticated roles', async () => {
  const http = server(engine, [{ ...worker, token: 'w'.repeat(32) }]);
  await new Promise<void>(r => http.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${(http.address() as any).port}/api/validation`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${'w'.repeat(32)}` } })).status, 200);
    // Every command the packaged runner and collector call must be routed. An unmatched
    // path answers 404, which the collector cannot distinguish from a missing request,
    // so it would never publish a result at all.
    const post = (command: string) => fetch(`${url}/${command}`, { method: 'POST', headers: { Authorization: `Bearer ${'w'.repeat(32)}`, 'Content-Type': 'application/json', 'Idempotency-Key': id() }, body: '{}' });
    for (const command of ['define', 'build', 'candidate', 'request', 'dispatch', 'ack', 'heartbeat', 'collection-authority', 'collection-heartbeat', 'result', 'cancel', 'settle', 'retry']) {
      assert.notEqual((await post(command)).status, 404, command);
    }
    assert.equal((await post('define')).status, 403);
    // The collection commands are the collector's, and this worker is not one.
    for (const command of ['collection-authority', 'collection-heartbeat']) assert.equal((await post(command)).status, 403, command);
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
  let w = await current(f.w.id);
  assert.equal(w.lease, null, 'submission ended the implementation lease');
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

test('the execution boundary a runner may use is operator-versioned, not runner configuration', async () => {
  const f = await fixture();
  const n = `net-${f.n}`;
  const base = { kind: 'registration' as const, id: n, expectedRevision: 0, principalId: runner.id, role: 'runner' as const, environment: f.environment, adapterVersion: 'test-v1', proofs: [], enabled: true, executionHost: 'unix:///var/run/docker.sock', attestationPublicKey };
  // Docker resolves a network name against every network the daemon already has, so an
  // unpinned one lets a runner attach the browser container to databases and other
  // internal services. The approved isolated network is authority, like the host and key.
  await assert.rejects(validation.define(operator, base, id()), /dedicated isolated Docker network/);
  for (const executionNetwork of ['host', 'bridge', 'default', 'none', 'not a network'])
    await assert.rejects(validation.define(operator, { ...base, executionNetwork }, id()), /dedicated isolated Docker network/);
  // Only a runner registration configures an execution boundary at all.
  await assert.rejects(validation.define(operator, { ...base, id: `${n}-c`, principalId: collector.id, role: 'collector', proofs: [f.proof], executionNetwork: 'gy-isolated' }, id()), /Only runner registrations/);
  // A remote daemon would resolve the attempt's bind-mount pathnames on a filesystem the
  // attestor never measured, so only a local socket may be pinned.
  for (const executionHost of ['ssh://graphyard@runner-1.example.test', 'tcp://10.0.0.4:2376', 'unix://relative.sock'])
    await assert.rejects(validation.define(operator, { ...base, id: `${n}-h`, executionHost, executionNetwork: 'gy-isolated' }, id()), /local unix:\/\/ Docker socket/);
  // The runner learns the approved network from dispatch; it is never in its own input.
  const dispatched: any = await validation.dispatch(runner, { registration: f.runnerRef }, id());
  assert.equal(dispatched.executionAuthority.network, 'gy-isolated');
  const command = { requestId: f.r.id, attemptId: dispatched.attempt.id, epoch: 1 };
  await validation.runnerCommand(runner, 'ack', command, id());
  assert.equal((await validation.collectionAuthority(collector, command) as any).executionNetwork, 'gy-isolated');
  await cleanup(f);
});

test('which approved test-account material an attempt may use is operator-versioned too', async () => {
  const f = await fixture();
  const n = `acct-${f.n}`;
  const testAccountDigest = `sha256:${'e'.repeat(64)}`;
  const base = { kind: 'registration' as const, id: n, expectedRevision: 0, principalId: runner.id, role: 'runner' as const, environment: f.environment, adapterVersion: 'test-v1', proofs: [], enabled: true, executionHost: 'unix:///var/run/docker.sock', attestationPublicKey, executionNetwork: 'gy-isolated' };
  // It is execution authority, so only a runner registration may carry it at all.
  await assert.rejects(validation.define(operator, { ...base, id: `${n}-c`, principalId: collector.id, role: 'collector', proofs: [f.proof], testAccountDigest }, id()), /Only runner registrations/);
  await assert.doesNotReject(validation.define(operator, { ...base, testAccountDigest }, id()));
  // Approving none is the default, and says so explicitly rather than by omission: the
  // attestor refuses a plan that names an env file when nothing is approved.
  const none: any = await validation.dispatch(runner, { registration: f.runnerRef }, id());
  assert.equal(none.executionAuthority.testAccountDigest, null);
  await cleanup(f);

  // A registration that does approve material carries the digest through dispatch and
  // through both independent re-reads, so the runner never chooses which account — and
  // which privileges its evidence would cover — the target-facing phase signs in as.
  const g = await fixture('external', { testAccountDigest });
  const d: any = await validation.dispatch(runner, { registration: g.runnerRef }, id());
  assert.equal(d.executionAuthority.testAccountDigest, testAccountDigest);
  const command = { requestId: g.r.id, attemptId: d.attempt.id, epoch: d.attempt.epoch };
  assert.equal((await validation.attemptAuthority({ id: 'attestor', role: 'reader' }, g.r.id) as any).grant.testAccountDigest, testAccountDigest);
  await validation.runnerCommand(runner, 'ack', command, id());
  assert.equal((await validation.collectionAuthority(collector, command) as any).testAccountDigest, testAccountDigest);
  await cleanup(g);
});
test('the host attestor reads current attempt authority itself, under a read-only credential', async () => {
  const f = await fixture();
  const d: any = await validation.dispatch(runner, { registration: f.runnerRef }, id());
  const command = { requestId: f.r.id, attemptId: d.attempt.id, epoch: d.attempt.epoch };
  const attestor: Principal = { id: 'attestor', role: 'reader' };

  // Before the ACK the attempt carries authority but may not be executed: the attestor's
  // second read is what releases containers, so `dispatched` has to be visible here.
  const dispatched: any = await validation.attemptAuthority(attestor, f.r.id);
  assert.equal(dispatched.state, 'dispatched');
  assert.equal(dispatched.acknowledged, false);
  // The authority it returns is the same one the runner was dispatched, field for field,
  // so a plan carrying a substituted target or network cannot match it.
  assert.deepEqual(dispatched.grant, { requestId: f.r.id, attemptId: d.attempt.id, epoch: d.attempt.epoch, runner: f.runnerRef,
    executionHost: 'unix:///var/run/docker.sock', attestationPublicKey, executionNetwork: 'gy-isolated',
    bundleDigest: digest, runnerImageDigest: inputs, reportFormat: 'graphyard-playwright-v1', targetUrl: 'https://preview.example.test', deadline: f.requestInput.deadline,
    testAccountDigest: null });

  await validation.runnerCommand(runner, 'ack', command, id());
  const running: any = await validation.attemptAuthority(attestor, f.r.id);
  assert.equal(running.state, 'running');
  assert.equal(running.acknowledged, true);
  assert.ok(Date.parse(running.expiresAt) > Date.parse(running.now));

  // Once the collector has taken over, the attempt must start no further container.
  await validation.collectionAuthority(collector, command);
  assert.equal((await validation.attemptAuthority(attestor, f.r.id) as any).state, 'collecting');

  // The credential is read-only and separate: the runner and the collector cannot use it
  // to look up authority, and it can do nothing else. Reading changed no attempt state.
  for (const other of [runner, collector, builder, worker]) await assert.rejects(validation.attemptAuthority(other, f.r.id), /read-only attestor credential/);
  assert.equal((await validation.list()).requests.find(r => r.id === f.r.id)?.state, 'collecting');
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
test('a collector bound to the work item\'s own slice cannot be selected to mint trusted evidence', async () => {
  const f = await fixture('external', {}, 'product');
  // A coordinator identity cannot even be registered as a collector, and a proof
  // agent bound to the item's own slice is refused selection.
  await assert.rejects(validation.define(operator, { kind: 'registration', id: `lead-collector-${f.n}`, expectedRevision: 0, principalId: 'product-lead', role: 'collector', environment: f.environment, adapterVersion: 'test-v1', proofs: [f.proof], enabled: true }, id()), /separate role/);
  collector.slice = 'product';
  try {
    await assert.rejects(validation.createRequest(operator, { ...f.requestInput, expectedWorkRevision: (await current(f.w.id)).revision }, id()), /independent of that slice/);
  } finally { delete collector.slice; }
  await cleanup(f);
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


test('private artifacts bind request/attempt, authenticate reads and never enter audit bytes', async () => {
  const f = await fixture('postgres'), command = await start(f), key = id();
  const bytes = Buffer.from(JSON.stringify({ tests: 2, outcome: 'passed', marker: 'private-fixture-marker' }));
  const input = { ...command, name: 'report', mediaType: 'application/json', bytes: bytes.toString('base64'), capturePolicy: 'approved-test-data-only' };
  await assert.rejects(validation.uploadArtifact(worker, input, id()), /separate trusted/);
  await assert.rejects(validation.uploadArtifact({ ...collector, id: 'wrong-collector' }, input, id()), /Wrong collector/);
  const artifact: any = await validation.uploadArtifact(collector, input, key);
  assert.deepEqual(await validation.uploadArtifact(collector, input, key), artifact);
  await assert.rejects(validation.uploadArtifact(collector, input, id()), /already published/);
  assert.equal((await validation.readArtifact(worker, f.r.id, artifact.id)).bytes.toString(), bytes.toString());
  await assert.rejects(validation.readArtifact({ id: 'unassigned-worker', role: 'worker' }, f.r.id, artifact.id), /not authorized/);
  const otherRepo = new Validation(engine, principals, 'other/repository');
  await assert.rejects(otherRepo.readArtifact(operator, f.r.id, artifact.id), /repository scope/);
  const events = (await store.pool.query("SELECT payload FROM events WHERE work_id=$1 AND kind LIKE 'validation.artifact%'", [f.w.id])).rows;
  assert.ok(!JSON.stringify(events).includes('private-fixture-marker')); assert.ok(!JSON.stringify(events).includes(input.bytes));
  const result: any = await validation.result(collector, { ...report(f, command), artifacts: [{ name: 'report', digest: artifact.digest, url: artifact.url }] }, id());
  assert.equal(result.passed, true);
  const w = await current(f.w.id);
  assert.equal(w.evidence.at(-1)?.expiresAt, artifact.expiresAt);
  assert.deepEqual(w.evidence.at(-1)?.artifacts, [{ kind: 'report', label: 'report', mediaType: 'application/json', size: bytes.length, digest: artifact.digest,
    expiresAt: artifact.expiresAt, availability: 'available', reference: { requestId: f.r.id, artifactId: artifact.id } }]);
  assert.equal(evaluate(w, [w], new Date(Date.now() + 8 * 86_400_000), [15368]).gates.find(g => g.name === 'acceptance')?.passed, false);
  await store.pool.query("UPDATE validation_artifacts SET expires_at='2000-01-01' WHERE id=$1", [artifact.id]);
  await assert.rejects(validation.readArtifact(operator, f.r.id, artifact.id), /retention expired/);
  assert.equal(await validation.expireArtifacts(), 1); assert.equal(await validation.expireArtifacts(), 0);
  assert.equal((await store.pool.query('SELECT bytes FROM validation_artifacts WHERE id=$1', [artifact.id])).rows[0].bytes, null);
  assert.equal((await store.pool.query("SELECT count(*) FROM events WHERE work_id=$1 AND kind='validation.artifact-expired'", [f.w.id])).rows[0].count, '1');
  await cleanup(f);
});
test('private artifact requirements cannot pass with a caller-authored URL or missing bytes', async () => {
  const f = await fixture('postgres'), command = await start(f);
  const result: any = await validation.result(collector, report(f, command), id());
  assert.equal(result.passed, false); assert.ok(result.reasons.some((s: string) => s.includes('Private artifact report'))); await cleanup(f);
});
test('external storage binds artifact URLs to safe public locations; private routes cannot pass', async () => {
  const f = await fixture(), command = await start(f);
  try {
    await assert.rejects(validation.result(collector, { ...report(f, command), artifacts: [{ name: 'report', digest, url: 'https://user:secret@private.example.test/report' }] }, id()), /HTTP\(S\)/);
    const result: any = await validation.result(collector, { ...report(f, command), artifacts: [
      { name: 'report', digest, url: `graphyard-artifact://test/repository/${f.r.id}/${randomUUID()}` }] }, id());
    assert.equal(result.accepted, true); assert.equal(result.passed, false);
    assert.ok(result.reasons.some((s: string) => s.includes('safe HTTP(S)')));
    const w = await current(f.w.id);
    assert.equal(w.evidence.at(-1)?.result, 'fail');
    assert.deepEqual(w.evidence.at(-1)?.artifacts, [{ kind: 'report', label: 'report', digest, availability: 'missing' }]);
    assert.equal(w.gates.find(g => g.name === 'acceptance')?.passed, false);
  } finally { await cleanup(f); }
  const ok = await fixture(), okCommand = await start(ok);
  try {
    const passing: any = await validation.result(collector, report(ok, okCommand), id());
    assert.equal(passing.passed, true);
    assert.deepEqual((await current(ok.w.id)).evidence.at(-1)?.artifacts, [{ kind: 'report', label: 'report', digest, availability: 'external', url: 'https://private.example.test/report' }]);
  } finally { await cleanup(ok); }
});
test('revocation and expired epochs refuse artifact uploads before storing bytes', async () => {
  const f = await fixture('postgres'), command = await start(f);
  const input = { ...command, name: 'report', mediaType: 'application/json', bytes: Buffer.from('{}').toString('base64'), capturePolicy: 'approved-test-data-only' };
  await assert.rejects(validation.uploadArtifact(collector, { ...input, epoch: command.epoch + 1 }, id()), /authority/);
  const registration = (await definitions()).find(d => d.kind === 'registration' && d.id === f.collectorRef.id)!;
  const { revision, createdAt, createdBy, ...data } = registration;
  await validation.define(operator, { ...data, expectedRevision: revision, enabled: false }, id());
  await assert.rejects(validation.uploadArtifact(collector, input, id()), /superseded|revoked/);
  assert.equal((await store.pool.query('SELECT count(*) FROM validation_artifacts WHERE request_id=$1', [f.r.id])).rows[0].count, '0'); await cleanup(f);
});

test('artifact HTTP routes require authentication and return private attachments', async () => {
  const f = await fixture('postgres'), command = await start(f);
  const artifact: any = await validation.uploadArtifact(collector, { ...command, name: 'report', mediaType: 'application/json', bytes: Buffer.from('{"private":true}').toString('base64'), capturePolicy: 'approved-test-data-only' }, id());
  const previousRepository = process.env.GITHUB_REPOSITORY; process.env.GITHUB_REPOSITORY = 'test/repository';
  const http = server(engine, principals.map((p, i) => ({ ...p, token: String(i).repeat(32) })));
  if (previousRepository === undefined) delete process.env.GITHUB_REPOSITORY; else process.env.GITHUB_REPOSITORY = previousRepository;
  await new Promise<void>(r => http.listen(0, '127.0.0.1', r));
  try {
    const origin = `http://127.0.0.1:${(http.address() as any).port}`, url = `${origin}/api/validation/artifacts/${f.r.id}/${artifact.id}`;
    assert.equal((await fetch(url)).status, 401);
    const headers = { Authorization: `Bearer ${'1'.repeat(32)}` };
    const response = await fetch(url, { headers });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition')!, /^attachment/); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('content-type'), 'application/octet-stream'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await response.text(), '{"private":true}');
    const preview = await fetch(`${url}?preview=1`, { headers });
    assert.match(preview.headers.get('content-disposition')!, /^inline/); assert.equal(preview.headers.get('content-type'), 'application/json');
    await store.pool.query("UPDATE validation_artifacts SET media_type='text/html' WHERE id=$1", [artifact.id]);
    const html = await fetch(`${url}?preview=1`, { headers });
    assert.match(html.headers.get('content-disposition')!, /^attachment/); assert.equal(html.headers.get('content-type'), 'application/octet-stream');
    assert.equal((await fetch(`${origin}/api/validation/artifacts`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': id() }, body: '{}' })).status, 403);
    assert.equal((await store.pool.query("SELECT count(*) FROM events WHERE work_id=$1 AND kind='validation.artifact-read'", [f.w.id])).rows[0].count, '3');
  } finally { await new Promise<void>(r => http.close(() => r())); await cleanup(f); }
});

test('artifact boundary accepts 8 MiB without regex stack overflow and rejects malformed encoding', async () => {
  const f = await fixture('postgres'), command = await start(f);
  const input = { ...command, name: 'report', mediaType: 'application/zip', capturePolicy: 'approved-test-data-only' };
  await assert.rejects(validation.uploadArtifact(collector, { ...input, bytes: 'YQ= ' }, id()), /canonical base64/);
  const artifact: any = await validation.uploadArtifact(collector, { ...input, bytes: Buffer.alloc(8_388_608).toString('base64') }, id());
  assert.equal(artifact.size, 8_388_608); assert.equal((await validation.readArtifact(operator, f.r.id, artifact.id)).bytes.length, 8_388_608); await cleanup(f);
});

test('the report format is operator-pinned bundle authority: it defaults, travels in every grant, and cannot change without a new scenario', async () => {
  const f = await fixture();
  const bundle = (await definitions()).find(d => d.kind === 'bundle' && d.id === f.c.bundle.id)! as any;
  assert.equal(bundle.reportFormat, 'graphyard-playwright-v1');
  const { revision, createdAt, createdBy, ...data } = bundle;
  // Re-pinning the same bytes under another adapter is a change of executable authority.
  await assert.rejects(validation.define(operator, { ...data, expectedRevision: revision, reportFormat: 'junit-xml-v1' }, id()), /new scenario/);
  await assert.rejects(validation.define(operator, { ...data, expectedRevision: revision, reportFormat: 'nunit-3' }, id()));
  // A bundle stored before formats existed is read as the Playwright default.
  await store.pool.query("UPDATE validation_definitions SET document=document-'reportFormat' WHERE kind='bundle' AND id=$1", [f.c.bundle.id]).catch(() => {});
  const d: any = await validation.dispatch(runner, { registration: f.runnerRef }, id());
  assert.equal(d.bundle.reportFormat, 'graphyard-playwright-v1');
  const command = { requestId: f.r.id, attemptId: d.attempt.id, epoch: d.attempt.epoch };
  await validation.runnerCommand(runner, 'ack', command, id());
  const reader: Principal = { id: 'attestor-reader', role: 'reader' };
  assert.equal((await validation.attemptAuthority(reader, f.r.id)).grant.reportFormat, 'graphyard-playwright-v1');
  assert.equal((await validation.collectionAuthority(collector, command) as any).reportFormat, 'graphyard-playwright-v1');
  await cleanup(f);

  // A JUnit-pinned bundle dispatches with its format in every grant.
  const g = await fixture();
  const stored = (await definitions()).find(d => d.kind === 'bundle' && d.id === g.c.bundle.id)! as any;
  const junitBundle = { id: `${stored.id}-junit`, revision: 1 };
  await validation.define(operator, { kind: 'bundle', id: junitBundle.id, expectedRevision: 0, scenario: stored.scenario, scenarioRevision: stored.scenarioRevision, scenarioHash: stored.scenarioHash, digest: stored.digest, runnerImageDigest: stored.runnerImageDigest, reportFormat: 'junit-xml-v1' }, id())
    .then(() => assert.fail('another bundle for the same scenario revision must carry the same authority'), (error: Error) => assert.match(error.message, /new scenario/));
  await cleanup(g);
});
