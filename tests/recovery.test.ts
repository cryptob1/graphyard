import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { Validation, type ValidationCandidate, type ValidationRequest } from '../src/validation.js';
import { Delivery, type EnvironmentDelivery, type Release, type RollbackRequest } from '../src/delivery.js';
import { S3ArtifactBackend } from '../src/artifacts.js';
import { defineScenario } from '../src/scenarios.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';

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
class ObjectStore {
  objects = new Map<string, { bytes: Buffer; type: string }>();
  requests: { method: string; path: string }[] = [];
  failNextPut = false; corruptNextPut = false;
  http!: Server; endpoint = '';
  async start() {
    this.http = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks), path = decodeURIComponent(req.url ?? '/');
        this.requests.push({ method: req.method!, path });
        const authorization = String(req.headers.authorization ?? '');
        if (!/^AWS4-HMAC-SHA256 Credential=test-access-key\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[a-f0-9]{64}$/.test(authorization) || req.headers['x-amz-content-sha256'] !== createHash('sha256').update(body).digest('hex')) { res.writeHead(403); return res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>'); }
        if (req.method === 'PUT') {
          if (this.failNextPut) { this.failNextPut = false; res.writeHead(500); return res.end('<Error><Code>InternalError</Code></Error>'); }
          const stored = this.corruptNextPut ? Buffer.from('corrupted bytes that fail their digest') : body; this.corruptNextPut = false;
          this.objects.set(path, { bytes: stored, type: String(req.headers['content-type'] ?? 'application/octet-stream') });
          res.writeHead(200, { ETag: `"${createHash('md5').update(body).digest('hex')}"` }); return res.end();
        }
        const object = this.objects.get(path);
        if (req.method === 'DELETE') { this.objects.delete(path); res.writeHead(204); return res.end(); }
        if (!object) { res.writeHead(404); return res.end(req.method === 'HEAD' ? undefined : '<Error><Code>NoSuchKey</Code></Error>'); }
        res.writeHead(200, { 'Content-Type': object.type, 'Content-Length': object.bytes.length, ETag: `"${createHash('md5').update(object.bytes).digest('hex')}"` });
        res.end(req.method === 'HEAD' ? undefined : object.bytes);
      });
    });
    await new Promise<void>(resolve => this.http.listen(0, '127.0.0.1', resolve));
    this.endpoint = `http://127.0.0.1:${(this.http.address() as any).port}`;
  }
  async stop() { await new Promise<void>(resolve => this.http.close(() => resolve())); }
  backend() { return new S3ArtifactBackend({ endpoint: this.endpoint, bucket: 'graphyard-artifacts', region: 'us-east-1', accessKeyId: 'test-access-key', secretAccessKey: 'test-secret', prefix: 'private' }); }
}
const objects = new ObjectStore();

before(async () => {
  const port = Number(process.env.GRAPHYARD_RECOVERY_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 5);
  pg = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-recovery-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('recovery_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/recovery_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'test/repository'); validation = new Validation(engine, principals, 'test/repository'); delivery = new Delivery(validation);
  await objects.start();
});
after(async () => { await objects.stop(); if (store) await store.close(); if (pg) await pg.stop(); });
const id = () => randomUUID();
const at = (offsetSeconds: number, from = Date.now()) => new Date(from + offsetSeconds * 1000).toISOString();
async function current(workId: string) { return (await store.list()).find(w => w.id === workId)!; }
async function request(requestId: string): Promise<ValidationRequest> { return (await store.pool.query('SELECT document FROM validation_requests WHERE id=$1', [requestId])).rows[0].document; }
async function reserved(resource: string) { return (await store.pool.query('SELECT request_id FROM validation_resources WHERE resource=$1', [resource])).rows.map(r => r.request_id as string); }
async function events(kind: string) { return (await store.pool.query('SELECT payload FROM events WHERE kind=$1 ORDER BY seq', [kind])).rows.map(r => r.payload); }

// ---- validation fixtures: an environment with runner/collector/builder registrations and one pinned request ----
type Fixture = { n: number; runner: Principal; w: Work; c: ValidationCandidate; r: ValidationRequest; proof: string; environment: { id: string; revision: number }; runnerRef: { id: string; revision: number }; collectorRef: { id: string; revision: number }; builderRef: { id: string; revision: number }; bundle: { id: string; revision: number }; scenario: { id: string; revision: number; hash: string } };
/** `share` reuses another fixture's environment, registrations, scenario and bundle for a second work item in the same queue. */
async function fixture(options: { artifactStorage?: 'external' | 'postgres'; runner?: Principal; runnerAuthority?: Record<string, unknown>; share?: Fixture } = {}): Promise<Fixture> {
  const n = ++serial, runnerPrincipal = options.runner ?? runner;
  const shared = options.share;
  const environment = shared?.environment ?? { id: `preview-${n}`, revision: 1 }, runnerRef = shared?.runnerRef ?? { id: `runner-${n}`, revision: 1 }, collectorRef = shared?.collectorRef ?? { id: `collector-${n}`, revision: 1 }, builderRef = shared?.builderRef ?? { id: `builder-${n}`, revision: 1 }, bundle = shared?.bundle ?? { id: `bundle-${n}`, revision: 1 }, proof = shared?.proof ?? `e2e:scenario-${n}`;
  let scenario = shared?.scenario;
  if (!shared) {
    collector.proofs!.push(proof);
    scenario = await defineScenario(store, operator, { id: `scenario-${n}`, title: 'Behavior', purpose: 'Prove behavior', steps: ['Execute'], expected: ['Correct'], environment: environment.id, runner: 'playwright', testPath: 'tests/behavior.spec.ts' }, id());
    await validation.define(operator, { kind: 'environment', id: environment.id, expectedRevision: 0, repository: 'test/repository', url: 'https://preview.example.test', instance: `instance-${n}`, immutable: true, services: ['api'], resources: [`test-account-${n}`] }, id());
    for (const [ref, actor, role] of [[runnerRef, runnerPrincipal, 'runner'], [collectorRef, collector, 'collector'], [builderRef, builder, 'builder']] as const) await validation.define(operator, { kind: 'registration', id: ref.id, expectedRevision: 0, principalId: actor.id, role, environment, adapterVersion: 'test-v1', proofs: role === 'collector' ? [proof] : [], enabled: true, ...(role === 'runner' ? { executionHost: 'unix:///var/run/docker.sock', attestationPublicKey, executionNetwork: 'gy-isolated', ...options.runnerAuthority } : {}) }, id());
    await validation.define(operator, { kind: 'bundle', id: bundle.id, expectedRevision: 0, scenario: scenario!.id, scenarioRevision: scenario!.revision, scenarioHash: scenario!.hash, digest, runnerImageDigest: inputs }, id());
  }
  let w = await engine.execute(operator, 'create', null, { title: `Recovery fixture ${n}`, criteria: [{ id: 'AC-1', text: 'Behavior is proven', proofs: [proof] }] }, id());
  w = await engine.execute(operator, 'ready', w.id, {}, id()); w = await engine.execute(worker, 'claim', w.id, {}, id());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/recovery-${n}`, branch: `graphyard/recovery-${n}` }, id());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: n }, id());
  w = await engine.observe(w.id, w.revision, { candidate: { sha: head, baseSha: base, pr: n, branch: `graphyard/recovery-${n}`, author: 'implementer' }, checks: [{ name: 'test', appId: 15368, result: 'success' }, { name: 'typecheck', appId: 15368, result: 'success' }], reviews: [{ reviewer: 'other', sha: head, state: 'APPROVED' }], merged: false, mergeSha: null, protected: true, mergeable: true, files: [], at: new Date().toISOString() });
  const build: any = await validation.attestBuild(builder, { registration: builderRef, workId: w.id, expectedWorkRevision: w.revision, sourceSha: head, baseSha: base, buildInputsDigest: inputs, artifacts: [{ service: 'api', digest }], provenanceUrl: 'https://ci.example.test/build/1' }, id());
  const c = await validation.createCandidate(operator, { workId: w.id, expectedWorkRevision: w.revision, proof, environment, bundle, buildAttestationId: build.id, requiredArtifacts: ['report'], artifactStorage: options.artifactStorage ?? 'external' }, id()) as ValidationCandidate;
  const r = await validation.createRequest(operator, { candidateId: c.id, expectedWorkRevision: (await current(w.id)).revision, runner: runnerRef, collector: collectorRef, deadline: new Date(Date.now() + 600_000).toISOString(), maxAttempts: 3 }, id()) as ValidationRequest;
  return { n, runner: shared?.runner ?? runnerPrincipal, w, c, r, proof, environment, runnerRef, collectorRef, builderRef, bundle, scenario: scenario! };
}
async function dispatch(f: Fixture, instance: Validation = validation) {
  const d: any = await instance.dispatch(f.runner, { registration: f.runnerRef }, id()); assert.equal(d.request?.id, f.r.id, d.reason);
  return { requestId: f.r.id, attemptId: d.attempt.id as string, epoch: d.attempt.epoch as number };
}
async function start(f: Fixture) {
  const command = await dispatch(f);
  await validation.runnerCommand(f.runner, 'ack', command, id());
  await validation.collectionAuthority(collector, command); return command;
}
function report(f: Fixture, command: { requestId: string; attemptId: string; epoch: number }, artifacts: { name: string; digest: string; url: string }[] = [{ name: 'report', digest, url: 'https://private.example.test/report' }]) {
  return { ...command, execution: 'completed', behavior: 'passed', executed: 2, skipped: 0, inventoryComplete: true, target: { instance: `instance-${f.n}`, artifacts: [{ service: 'api', digest }], measurement: 'provider', coversEntireRun: true, attribution: 'matched' }, bundleDigest: digest, runnerImageDigest: inputs, artifacts, artifactState: 'verified', executionSettled: true, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } };
}
async function expireAttempt(f: Fixture) {
  await store.pool.query("UPDATE validation_requests SET document=jsonb_set(document,'{attempts,0,expiresAt}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=$1", [f.r.id]); await validation.reconcile();
}
async function cleanup(...fixtures: Fixture[]) {
  for (const f of fixtures) {
    const r = await request(f.r.id);
    if (['queued', 'dispatched', 'running', 'collecting'].includes(r.state)) await validation.operatorCommand(operator, 'cancel', { requestId: r.id, epoch: r.attempts.at(-1)?.epoch ?? 0, reason: 'Test process never launched' }, id());
    const a = (await request(f.r.id)).attempts.at(-1); if (a && !a.settled) await validation.operatorCommand(operator, 'settle', { requestId: r.id, epoch: a.epoch, reason: 'Fixture has no external process', settlementEvidence: 'https://tests.example.test/no-process' }, id());
  }
}
const upload = (command: { requestId: string; attemptId: string; epoch: number }, bytes: Buffer, name = 'report') => ({ ...command, name, mediaType: 'application/json', bytes: bytes.toString('base64'), capturePolicy: 'approved-test-data-only' });

test('D4-1 queue starvation, unacknowledged dispatch and missing runner heartbeat have distinct next steps', async () => {
  const starved = await fixture({ runner: idleRunner });
  const unacknowledged = await fixture({ runner: runners[0] }); await dispatch(unacknowledged);
  const stalled = await fixture({ runner: runners[1] }); const stalledCommand = await dispatch(stalled); await validation.runnerCommand(stalled.runner, 'ack', stalledCommand, id());
  await validation.runnerCommand(stalled.runner, 'heartbeat', stalledCommand, id());
  // The runner renewed once, 30 seconds ago by the record: longer than the renewal interval, inside the lease.
  await store.pool.query("UPDATE validation_requests SET document=jsonb_set(document,'{attempts,0,lastHeartbeatAt}',to_jsonb($2::text)) WHERE id=$1", [stalled.r.id, at(-30)]);
  const healthy = await fixture({ runner: runners[2] }); const healthyCommand = await dispatch(healthy); await validation.runnerCommand(healthy.runner, 'ack', healthyCommand, id()); await validation.runnerCommand(healthy.runner, 'heartbeat', healthyCommand, id());
  // Contention for the runner slot: a second request in the healthy fixture's queue, after the runner polled.
  const waiting = await fixture({ share: healthy });
  const nothing: any = await validation.dispatch(healthy.runner, { registration: healthy.runnerRef }, id()); assert.equal(nothing.request, null);
  // A lost lease that keeps the barrier closed, and a request behind it.
  const lost = await fixture({ runner: runners[3] }); const lostCommand = await dispatch(lost); await validation.runnerCommand(lost.runner, 'ack', lostCommand, id()); await expireAttempt(lost);
  const behind = await fixture({ share: lost });
  await validation.dispatch(lost.runner, { registration: lost.runnerRef }, id());
  const capacity = await validation.capacity();
  const diagnosis = (f: Fixture) => capacity.requests.find(d => d.requestId === f.r.id)!;
  assert.equal(diagnosis(starved).condition, 'queued-starved'); assert.match(diagnosis(starved).nextStep, /No dispatch poll from runner .* ever; the queue is starved\. Start or repair the runner process/);
  assert.equal(diagnosis(unacknowledged).condition, 'unacknowledged'); assert.match(diagnosis(unacknowledged).nextStep, /not acknowledged; the ACK window ends .*No execution was authorized/);
  assert.equal(diagnosis(stalled).condition, 'heartbeat-missing'); assert.match(diagnosis(stalled).nextStep, /last renewed at .* longer ago than the 20s renewal interval.*leave its reserved resources alone/);
  assert.equal(diagnosis(healthy).condition, 'running'); assert.match(diagnosis(healthy).nextStep, /nothing to do/);
  assert.equal(diagnosis(waiting).condition, 'queued-waiting-for-slot'); assert.match(diagnosis(waiting).nextStep, new RegExp(`is in use by request ${healthy.r.id} \\(running\\) under a live lease`));
  assert.equal(diagnosis(lost).condition, 'awaiting-settlement'); assert.match(diagnosis(lost).nextStep, /never verified settled.*validation settle with settlement evidence/);
  assert.equal(diagnosis(behind).condition, 'queued-resource-held'); assert.match(diagnosis(behind).nextStep, new RegExp(`reserved by request ${lost.r.id} \\(expired, settlement not verified\\)`));
  const conditions = [starved, unacknowledged, stalled, waiting, lost, behind].map(f => diagnosis(f));
  assert.equal(new Set(conditions.map(d => d.condition)).size, conditions.length, 'every condition is distinct'); assert.equal(new Set(conditions.map(d => d.nextStep)).size, conditions.length, 'every next step is distinct');
  assert.ok(diagnosis(waiting).dwellSeconds >= 0 && diagnosis(behind).attempt === null);
  // Capacity reporting: the idle runner never polled, the busy runner has queue dwell, and every reserved resource is attributed.
  const idle = capacity.runners.find(r => r.registration.id === starved.runnerRef.id)!, busy = capacity.runners.find(r => r.registration.id === healthy.runnerRef.id)!;
  assert.equal(idle.lastPollAt, null); assert.equal(idle.queued, 1); assert.equal(idle.executing, null); assert.equal(idle.queueLimit, 20);
  assert.ok(busy.lastPollAt && busy.executing === healthy.r.id && busy.queued === 1 && busy.oldestQueuedSeconds !== null);
  assert.ok(capacity.resources.some(r => r.resource === `runner:${healthy.runner.id}` && r.requestId === healthy.r.id && r.live) && capacity.resources.some(r => r.requestId === lost.r.id && !r.live));
  // Retryable and settled are their own states once the barrier opens.
  await validation.operatorCommand(operator, 'settle', { requestId: lost.r.id, epoch: 1, reason: 'Verified no process', settlementEvidence: 'https://tests.example.test/settlement' }, id());
  assert.equal((await validation.capacity()).requests.find(d => d.requestId === lost.r.id)?.condition, 'retryable');
  await cleanup(starved, unacknowledged, stalled, healthy, waiting, lost, behind);
  const after = await validation.capacity();
  assert.equal(after.requests.find(d => d.requestId === healthy.r.id)?.condition, 'retryable', 'a cancelled, settled attempt with budget left is retryable');
  assert.ok(after.resources.length === 0 && after.runners.every(r => r.executing === null), 'settlement released every reservation');
});

test('D4-1 a runner queue applies backpressure at its registered limit', async () => {
  const f = await fixture({ runnerAuthority: { queueLimit: 1 } });
  await assert.rejects(fixture({ share: f }), /already has 1 queued requests, its queue limit/);
  await assert.rejects(validation.define(operator, { kind: 'registration', id: `builder-limit-${f.n}`, expectedRevision: 0, principalId: builder.id, role: 'builder', environment: f.environment, adapterVersion: 'test-v1', proofs: [], enabled: true, queueLimit: 5 }, id()), /queue limit/);
  await cleanup(f);
});

test('D4-2 network partition recovery cannot grant two authoritative attempts the same protected execution resource', async () => {
  const f = await fixture(), command = await dispatch(f); await validation.runnerCommand(f.runner, 'ack', command, id());
  const environmentResource = `environment:${f.environment.id}`, account = `external:test-account-${f.n}`;
  assert.deepEqual(await reserved(environmentResource), [f.r.id]);
  // The runner is partitioned: its lease lapses while its container may still be mutating the test account.
  await expireAttempt(f);
  assert.equal((await request(f.r.id)).state, 'expired'); assert.deepEqual(await reserved(account), [f.r.id]);
  // A second request for the same environment, polled from another replica, gets nothing while the barrier stands.
  const g = await fixture({ share: f });
  const replica = new Store(store.pool.options.connectionString!);
  try {
    const other = new Validation(new Engine(replica), principals, 'test/repository');
    const races: any[] = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? validation : other).dispatch(runner, { registration: f.runnerRef }, id())));
    assert.ok(races.every(r => r.request === null && /still reserved/.test(r.reason)));
    // The partition heals: the old runner and its collector resume against epoch 1 and are refused everywhere.
    await assert.rejects(other.runnerCommand(f.runner, 'heartbeat', command, id()), /expired|superseded/);
    await assert.rejects(other.collectionAuthority(collector, command), /expired|superseded/);
    const late: any = await other.result(collector, report(f, command), id()); assert.equal(late.accepted, false);
    await assert.rejects(other.operatorCommand(operator, 'retry', { requestId: f.r.id, epoch: 1, reason: 'Try again' }, id()), /settled/);
    assert.deepEqual(await reserved(environmentResource), [f.r.id]);
    // Only independently verified settlement opens the barrier; then exactly one attempt wins it.
    await validation.operatorCommand(operator, 'settle', { requestId: f.r.id, epoch: 1, reason: 'Container removed and absence confirmed', settlementEvidence: 'https://tests.example.test/settlement' }, id());
    assert.deepEqual(await reserved(environmentResource), []);
    const grants: any[] = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? validation : other).dispatch(runner, { registration: f.runnerRef }, id())));
    assert.equal(grants.filter(r => r.request).length, 1); assert.equal(grants.find(r => r.request).request.id, g.r.id);
    assert.deepEqual(await reserved(environmentResource), [g.r.id]); assert.deepEqual(await reserved(account), [g.r.id]);
    await assert.rejects(other.runnerCommand(f.runner, 'ack', command, id()), /expired|superseded/);
    assert.equal((await store.pool.query('SELECT count(*) FROM validation_resources WHERE resource=$1', [account])).rows[0].count, '1');
  } finally { await replica.close(); await cleanup(f, g); }
});

test('D4-3 artifact upload failure and expired artifact retention are visible proof states; the S3 backend verifies bytes, deletion and migration', async () => {
  validation.artifactBackend = objects.backend();
  try {
    const f = await fixture({ artifactStorage: 'postgres' }), command = await start(f);
    const bytes = Buffer.from(JSON.stringify({ tests: 2, outcome: 'passed', marker: 'private-s3-marker' })), key = id();
    // A failed move to the store is recorded, refused to the collector, and resumed by the same key.
    objects.failNextPut = true;
    await assert.rejects(validation.uploadArtifact(collector, upload(command, bytes), key), /upload to s3 .* failed.*Retry with the same idempotency key/);
    let row = (await store.pool.query('SELECT state,backend,location,bytes FROM validation_artifacts WHERE request_id=$1', [f.r.id])).rows[0];
    assert.equal(row.state, 'upload-failed'); assert.equal(row.backend, 's3'); assert.equal(row.bytes, null);
    assert.equal((await validation.capacity()).artifacts.uploadFailed, 1);
    await assert.rejects(validation.readArtifact(operator, f.r.id, (await store.pool.query('SELECT id FROM validation_artifacts WHERE request_id=$1', [f.r.id])).rows[0].id), /upload failed/);
    await assert.rejects(validation.uploadArtifact(collector, upload(command, Buffer.from('{"different":true}')), key), /resumed with the same bytes/);
    const failedArtifactId = (await store.pool.query('SELECT id FROM validation_artifacts WHERE request_id=$1', [f.r.id])).rows[0].id;
    const failed: any = await validation.result(collector, report(f, command, [{ name: 'report', digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, url: `graphyard-artifact://test/repository/${f.r.id}/${failedArtifactId}` }]), id());
    assert.equal(failed.accepted, true); assert.equal(failed.passed, false); assert.match(failed.reasons.join('\n'), /Private artifact report upload failed/);
    assert.equal((await current(f.w.id)).evidence.at(-1)?.artifacts?.[0].availability, 'upload-failed');
    await cleanup(f);
    // The same collector retries after the transport failure and the artifact publishes with verified bytes.
    const g = await fixture({ artifactStorage: 'postgres' }), gCommand = await start(g), gKey = id();
    objects.failNextPut = true;
    await assert.rejects(validation.uploadArtifact(collector, upload(gCommand, bytes), gKey), /upload-failed/);
    const artifact: any = await validation.uploadArtifact(collector, upload(gCommand, bytes), gKey);
    assert.equal(artifact.backend, 's3'); assert.deepEqual(await validation.uploadArtifact(collector, upload(gCommand, bytes), gKey), artifact);
    row = (await store.pool.query('SELECT state,backend,location,bytes,size FROM validation_artifacts WHERE id=$1', [artifact.id])).rows[0];
    assert.equal(row.state, 'stored'); assert.equal(row.bytes, null); assert.equal(Number(row.size), bytes.length); assert.match(row.location, new RegExp(`^test_repository/${g.r.id}/${gCommand.attemptId}/${artifact.id}$`));
    assert.ok(objects.objects.has(`/graphyard-artifacts/private/${row.location}`), 'the object lives under the configured bucket and prefix');
    assert.equal((await validation.readArtifact(reader, g.r.id, artifact.id)).bytes.toString(), bytes.toString());
    await assert.rejects(validation.readArtifact({ id: 'unassigned-worker', role: 'worker' }, g.r.id, artifact.id), /not authorized/);
    assert.ok(!JSON.stringify(await events('validation.artifact-stored')).includes('private-s3-marker'), 'bytes never enter the ledger');
    const passing: any = await validation.result(collector, report(g, gCommand, [{ name: 'report', digest: artifact.digest, url: artifact.url }]), id());
    assert.equal(passing.passed, true, passing.reasons.join());
    assert.equal((await current(g.w.id)).evidence.at(-1)?.artifacts?.[0].availability, 'available');
    // Substituted bytes at the store fail the digest on read; the row is never trusted over the hash.
    const stored = objects.objects.get(`/graphyard-artifacts/private/${row.location}`)!; objects.objects.set(`/graphyard-artifacts/private/${row.location}`, { ...stored, bytes: Buffer.from('{"tampered":true}') });
    await assert.rejects(validation.readArtifact(operator, g.r.id, artifact.id), /integrity/);
    objects.objects.set(`/graphyard-artifacts/private/${row.location}`, stored);
    // Retention: expiry refuses reads at once; the object is deleted, its absence verified, and the evidence expires with it.
    await store.pool.query("UPDATE validation_artifacts SET expires_at='2000-01-01' WHERE id=$1", [artifact.id]);
    await assert.rejects(validation.readArtifact(operator, g.r.id, artifact.id), /retention expired/);
    assert.equal(await validation.expireArtifacts(), 1); assert.equal(await validation.expireArtifacts(), 0);
    assert.ok(!objects.objects.has(`/graphyard-artifacts/private/${row.location}`)); assert.ok(objects.requests.some(r => r.method === 'HEAD' && r.path === `/graphyard-artifacts/private/${row.location}`), 'deletion is verified with a read');
    row = (await store.pool.query('SELECT state,deleted_at FROM validation_artifacts WHERE id=$1', [artifact.id])).rows[0];
    assert.equal(row.state, 'expired'); assert.ok(row.deleted_at);
    assert.equal((await events('validation.artifact-deleted')).filter(e => e.artifactId === artifact.id && e.verified).length, 1);
    const expiredCapacity = (await validation.capacity()).artifacts; assert.equal(expiredCapacity.expired >= 1 && expiredCapacity.awaitingDeletion, 0);
    await cleanup(g);
    // An expired artifact reported at result time is its own refusal.
    const h = await fixture({ artifactStorage: 'postgres' }), hCommand = await start(h);
    const hArtifact: any = await validation.uploadArtifact(collector, upload(hCommand, bytes), id());
    await store.pool.query("UPDATE validation_artifacts SET expires_at='2000-01-01' WHERE id=$1", [hArtifact.id]);
    const expired: any = await validation.result(collector, report(h, hCommand, [{ name: 'report', digest: hArtifact.digest, url: hArtifact.url }]), id());
    assert.equal(expired.passed, false); assert.match(expired.reasons.join('\n'), /Private artifact report retention expired/);
    assert.equal((await current(h.w.id)).evidence.at(-1)?.artifacts?.[0].availability, 'expired');
    await cleanup(h);
    // Capacity is a visible state, not a silent drop.
    const k = await fixture({ artifactStorage: 'postgres' }), kCommand = await start(k);
    validation.artifactCapacityBytes = 16;
    await assert.rejects(validation.uploadArtifact(collector, upload(kCommand, bytes), id()), /capacity exhausted/);
    assert.equal((await store.pool.query('SELECT count(*) FROM validation_artifacts WHERE request_id=$1', [k.r.id])).rows[0].count, '0');
    validation.artifactCapacityBytes = 2 * 1024 ** 3;
    await cleanup(k);
  } finally { validation.artifactBackend = null; validation.artifactCapacityBytes = 2 * 1024 ** 3; }
});

test('D4-3 backend migration preserves authorization and retention and verifies every artifact', async () => {
  const f = await fixture({ artifactStorage: 'postgres' }), command = await start(f);
  const bytes = Buffer.from('{"migrated":true}');
  const artifact: any = await validation.uploadArtifact(collector, upload(command, bytes), id());
  assert.equal(artifact.backend, 'postgres');
  const passing: any = await validation.result(collector, report(f, command, [{ name: 'report', digest: artifact.digest, url: artifact.url }]), id()); assert.equal(passing.passed, true);
  await assert.rejects(validation.migrateArtifacts(operator, { target: 's3' }), /No external artifact backend/);
  validation.artifactBackend = objects.backend();
  try {
    await assert.rejects(validation.migrateArtifacts(collector, { target: 's3' }), /Operator/);
    // A store that keeps different bytes than it acknowledged is caught by the read-back; the source stays.
    objects.corruptNextPut = true;
    const refused = await validation.migrateArtifacts(operator, { target: 's3' });
    assert.deepEqual(refused.migrated, []); assert.equal(refused.refused.length, 1); assert.match(refused.refused[0].reason, /fail their digest on read-back/);
    assert.equal((await store.pool.query('SELECT backend FROM validation_artifacts WHERE id=$1', [artifact.id])).rows[0].backend, 'postgres');
    const moved = await validation.migrateArtifacts(operator, { target: 's3' });
    assert.deepEqual(moved.migrated, [artifact.id]); assert.equal(moved.remaining, 0);
    let row = (await store.pool.query('SELECT backend,location,bytes,expires_at,state FROM validation_artifacts WHERE id=$1', [artifact.id])).rows[0];
    assert.equal(row.backend, 's3'); assert.equal(row.bytes, null); assert.equal(row.state, 'stored'); assert.equal(row.expires_at.toISOString(), artifact.expiresAt, 'retention is preserved');
    assert.equal((await validation.readArtifact(worker, f.r.id, artifact.id)).bytes.toString(), bytes.toString(), 'the assigned worker still reads it');
    await assert.rejects(validation.readArtifact({ id: 'unassigned-worker', role: 'worker' }, f.r.id, artifact.id), /not authorized/, 'authorization did not move with the bytes');
    assert.equal((await current(f.w.id)).evidence.at(-1)?.artifacts?.[0].reference?.artifactId, artifact.id, 'evidence keeps its reference');
    // And back: the copy in Postgres is verified before the S3 object is removed, with verified deletion.
    const back = await validation.migrateArtifacts(operator, { target: 'postgres' });
    assert.deepEqual(back.migrated, [artifact.id]); assert.equal(back.deleted, 1);
    row = (await store.pool.query('SELECT backend,location,bytes,deleted_at FROM validation_artifacts WHERE id=$1', [artifact.id])).rows[0];
    assert.equal(row.backend, 'postgres'); assert.equal(row.bytes.toString(), bytes.toString()); assert.equal(row.location, null);
    assert.ok(![...objects.objects.keys()].some(k => k.includes(artifact.id)), 'no orphaned object remains');
    assert.equal((await validation.readArtifact(operator, f.r.id, artifact.id)).bytes.toString(), bytes.toString());
    assert.equal((await events('validation.artifact-migrated')).filter(e => e.artifactId === artifact.id).length, 2);
  } finally { validation.artifactBackend = null; await cleanup(f); }
});

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
  const rollback = await delivery.requestRollback(operator, rollbackRequest(f, one, 2, { repairWorkId: (await fixture()).w.id }), id());
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
    assert.equal((await call(worker, 'validation/capacity')).status, 200);
    assert.equal((await call(worker, 'validation/artifacts/migrate', { target: 'postgres' })).status, 403);
  } finally { await new Promise<void>(resolve => http.close(() => resolve())); }
});

test('S3 requests are signed with SigV4 over the payload hash and encoded path', async () => {
  const backend = new S3ArtifactBackend({ endpoint: 'https://objects.example.test', bucket: 'bucket', region: 'eu-west-1', accessKeyId: 'AKIA', secretAccessKey: 'secret', prefix: 'p' }, fetch, () => new Date('2026-09-18T12:00:00Z'));
  const signed = backend.sign('PUT', 'owner_repo/req/att/art name', Buffer.from('bytes'), 'application/json');
  assert.equal(signed.url, 'https://objects.example.test/bucket/p/owner_repo/req/att/art%20name');
  assert.equal(signed.headers['x-amz-content-sha256'], createHash('sha256').update('bytes').digest('hex')); assert.equal(signed.headers['x-amz-date'], '20260918T120000Z');
  assert.match(signed.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIA\/20260918\/eu-west-1\/s3\/aws4_request, SignedHeaders=content-length;content-md5;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/);
  assert.notEqual(signed.headers.Authorization, backend.sign('PUT', 'owner_repo/req/att/art name', Buffer.from('other'), 'application/json').headers.Authorization, 'the signature binds the body');
  await delay(0);
});
