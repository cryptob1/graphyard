import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { Validation } from '../src/validation.js';
import { defineScenario } from '../src/scenarios.js';
import type { Principal } from '../src/model.js';
import { backupDigest, backupSchema, createBackup, ledgerCounts, restoreBackup, verifyBackup } from '../src/backup.js';
import { schemaVersion } from '../src/release.js';

const run = promisify(execFile);
const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const runner: Principal = { id: 'runner', role: 'worker' };
const collector: Principal = { id: 'collector', role: 'producer', proofs: ['e2e:booking'] };
const builder: Principal = { id: 'builder', role: 'producer' };
const principals = [operator, worker, runner, collector, builder];
const sha = 'a'.repeat(40), base = 'b'.repeat(40), digest = `sha256:${'c'.repeat(64)}`, inputs = `sha256:${'d'.repeat(64)}`;
let pg: EmbeddedPostgres, port: number, scratch: string;
const id = () => randomUUID();
const url = (database: string) => `postgres://graphyard:testing-only@127.0.0.1:${port}/${database}`;

before(async () => {
  port = Number(process.env.GRAPHYARD_BACKUP_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 3);
  scratch = await mkdtemp(join(tmpdir(), 'graphyard-backup-'));
  pg = new EmbeddedPostgres({ databaseDir: join(scratch, 'data'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start();
  for (const name of ['source', 'restored', 'occupied', 'cli_restored', 'newer']) await pg.createDatabase(name);
});
after(async () => { if (pg) await pg.stop(); });

/**
 * A ledger holding everything the roadmap says an upgrade and restore must preserve: an
 * assignment under a live lease with its registered workspace, the append-only history
 * behind it, two revisions of one scenario, and a validation request that is still
 * pending. Plus the tables an installation accumulates around them.
 */
async function populate(store: Store) {
  const engine = new Engine(store, [15368], 120, 'test/repository');
  const validation = new Validation(engine, principals, 'test/repository');
  const first = await defineScenario(store, operator, { id: 'booking', title: 'Booking', purpose: 'Prove booking', steps: ['Book'], expected: ['Booked'], environment: 'preview', runner: 'playwright', testPath: 'tests/booking.spec.ts' }, id());
  const second = await defineScenario(store, operator, { id: 'booking', title: 'Booking', purpose: 'Prove booking and cancellation', steps: ['Book', 'Cancel'], expected: ['Booked', 'Cancelled'], environment: 'preview', runner: 'playwright', testPath: 'tests/booking.spec.ts', expectedRevision: first.revision }, id());
  assert.equal(second.revision, first.revision + 1);
  const attestationPublicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
  await validation.define(operator, { kind: 'environment', id: 'preview', expectedRevision: 0, repository: 'test/repository', url: 'https://preview.example.test', instance: 'preview-1', immutable: true, services: ['api'], resources: ['test-account-1'] }, id());
  const environment = { id: 'preview', revision: 1 };
  await validation.define(operator, { kind: 'registration', id: 'runner-1', expectedRevision: 0, principalId: runner.id, role: 'runner', environment, adapterVersion: 'test-v1', proofs: [], enabled: true, executionHost: 'unix:///var/run/docker.sock', attestationPublicKey, executionNetwork: 'gy-isolated' }, id());
  await validation.define(operator, { kind: 'registration', id: 'collector-1', expectedRevision: 0, principalId: collector.id, role: 'collector', environment, adapterVersion: 'test-v1', proofs: ['e2e:booking'], enabled: true }, id());
  await validation.define(operator, { kind: 'registration', id: 'builder-1', expectedRevision: 0, principalId: builder.id, role: 'builder', environment, adapterVersion: 'test-v1', proofs: [], enabled: true }, id());
  await validation.define(operator, { kind: 'bundle', id: 'bundle-1', expectedRevision: 0, scenario: 'booking', scenarioRevision: second.revision, scenarioHash: second.hash, digest, runnerImageDigest: inputs, reportFormat: 'junit-xml-v1' }, id());
  // An assigned item under a live lease, with history, plus a second item still in backlog.
  let w = await engine.execute(operator, 'create', null, { title: 'Booking flow', criteria: [{ id: 'AC-1', text: 'Booking is proven', proofs: ['e2e:booking'] }] }, id());
  await engine.execute(operator, 'create', null, { title: 'Later work', criteria: [{ id: 'AC-1', text: 'Later', proofs: ['unit:later'] }] }, id());
  w = await engine.execute(operator, 'ready', w.id, {}, id()); w = await engine.execute(worker, 'claim', w.id, {}, id());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'worker-host', path: '/srv/worktrees/booking', branch: 'graphyard/booking-1' }, id());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: 7 }, id());
  w = await engine.observe(w.id, w.revision, { candidate: { sha, baseSha: base, pr: 7, branch: 'graphyard/booking-1', author: 'implementer' }, checks: [{ name: 'test', appId: 15368, result: 'success' }, { name: 'typecheck', appId: 15368, result: 'success' }], reviews: [{ reviewer: 'other', sha, state: 'APPROVED' }], merged: false, mergeSha: null, protected: true, mergeable: true, files: [], at: new Date().toISOString() });
  const build: any = await validation.attestBuild(builder, { registration: { id: 'builder-1', revision: 1 }, workId: w.id, expectedWorkRevision: w.revision, sourceSha: sha, baseSha: base, buildInputsDigest: inputs, artifacts: [{ service: 'api', digest }], provenanceUrl: 'https://ci.example.test/build/1' }, id());
  const candidate: any = await validation.createCandidate(operator, { workId: w.id, expectedWorkRevision: w.revision, proof: 'e2e:booking', environment, bundle: { id: 'bundle-1', revision: 1 }, buildAttestationId: build.id, requiredArtifacts: ['report'], artifactStorage: 'postgres' }, id());
  const current = (await store.list()).find(x => x.id === w.id)!;
  const request: any = await validation.createRequest(operator, { candidateId: candidate.id, expectedWorkRevision: current.revision, runner: { id: 'runner-1', revision: 1 }, collector: { id: 'collector-1', revision: 1 }, deadline: new Date(Date.now() + 3_600_000).toISOString(), maxAttempts: 3 }, id());
  // Dispatch and acknowledge, so the request is running under an attempt epoch with a
  // reserved protected resource — the state a restart must hand back untouched.
  const dispatched: any = await validation.dispatch(runner, { registration: { id: 'runner-1', revision: 1 } }, id());
  const command = { requestId: request.id, attemptId: dispatched.attempt.id, epoch: dispatched.attempt.epoch };
  await validation.runnerCommand(runner, 'ack', command, id());
  await validation.collectionAuthority(collector, command);
  await validation.uploadArtifact(collector, { ...command, name: 'report', mediaType: 'application/json', bytes: Buffer.from(JSON.stringify({ format: 'junit-xml-v1', private: 'artifact-bytes-marker' })).toString('base64'), capturePolicy: 'approved-test-data-only' }, id());
  await store.pool.query("INSERT INTO webhook_receipts(id) VALUES('delivery-1')");
  return { engine, validation, workId: w.id, requestId: request.id, scenario: { revision: second.revision, hash: second.hash } };
}

async function snapshot(store: Store) {
  const work = await store.list();
  const events = (await store.pool.query('SELECT seq, work_id, actor, kind, payload FROM events ORDER BY seq')).rows;
  const scenarios = (await store.pool.query('SELECT id, revision, document FROM scenarios ORDER BY id, revision')).rows;
  const requests = (await store.pool.query('SELECT id, document FROM validation_requests ORDER BY id')).rows;
  const resources = (await store.pool.query('SELECT resource, request_id FROM validation_resources ORDER BY resource')).rows;
  const artifacts = (await store.pool.query('SELECT id, request_id, attempt_id, name, digest, media_type, encode(bytes, \'hex\') AS bytes, expires_at FROM validation_artifacts ORDER BY id')).rows;
  const definitions = (await store.pool.query('SELECT kind, id, revision, document FROM validation_definitions ORDER BY kind, id, revision')).rows;
  return { work, events, scenarios, requests, resources, artifacts, definitions };
}

test('the documented backup and restore exercise preserves assignments, history, scenario revisions and pending requests, and the restored ledger keeps ordering', async () => {
  const source = new Store(url('source')); await source.init();
  const seeded = await populate(source);
  const before = await snapshot(source);
  assert.ok(before.work.find(w => w.id === seeded.workId)!.lease, 'the fixture holds a live assignment');
  assert.equal(before.requests.find(r => r.id === seeded.requestId)!.document.state, 'collecting');
  assert.equal(before.scenarios.length, 2);

  const backup = await createBackup(source.pool);
  assert.equal(backup.schemaVersion, schemaVersion); assert.equal(verifyBackup(backup).format, 'graphyard-backup-v1');
  assert.deepEqual(Object.fromEntries(backup.tables.map(t => [t.name, t.rows.length])), await ledgerCounts(source.pool));

  // A restore needs a migrated, empty target; nothing else is accepted.
  const restored = new Store(url('restored'));
  await assert.rejects(restoreBackup(restored.pool, backup), /relation "graphyard_schema" does not exist|migrated/);
  await restored.init();
  const result = await restoreBackup(restored.pool, backup);
  assert.equal(result.fromSchema, schemaVersion); assert.deepEqual(result.tablesLeftEmpty, []);
  assert.deepEqual(await ledgerCounts(restored.pool), await ledgerCounts(source.pool));
  assert.deepEqual(await snapshot(restored), before);
  await assert.rejects(restoreBackup(restored.pool, backup), /Restore requires an empty database/);

  // The upgrade step after a restore: the release's migration runs again over restored
  // state, changes nothing it already knows, and the ledger keeps serving.
  await restored.init();
  assert.deepEqual(await snapshot(restored), before);
  const engine = new Engine(restored.pool ? restored : source, [15368], 120, 'test/repository');
  const validation = new Validation(engine, principals, 'test/repository');
  const item = (await restored.list()).find(w => w.id === seeded.workId)!;
  assert.equal(item.lease?.owner, worker.id); assert.equal(item.workspaces[0].path, '/srv/worktrees/booking'); assert.equal(item.submission?.pr, 7);
  const request = (await validation.list()).requests.find(r => r.id === seeded.requestId)!;
  assert.equal(request.state, 'collecting'); assert.equal(request.attempts.at(-1)?.epoch, 1);
  // The heartbeat the collector was holding continues under the same epoch after restore.
  await validation.collectionHeartbeat(collector, { requestId: request.id, attemptId: request.attempts.at(-1)!.id, epoch: 1 }, id());
  // Sequences continue after the restored rows rather than colliding with them.
  const created = await engine.execute(operator, 'create', null, { title: 'After restore', criteria: [{ id: 'AC-1', text: 'Continues', proofs: ['unit:after'] }] }, id());
  const numbers = (await restored.pool.query('SELECT number FROM work_items ORDER BY number')).rows.map(r => Number(r.number));
  assert.deepEqual(numbers, [1, 2, 3]); assert.equal(created.key, 'GY-3');
  const seqs = (await restored.pool.query('SELECT seq FROM events ORDER BY seq')).rows.map(r => Number(r.seq));
  assert.deepEqual(seqs.slice(0, before.events.length), before.events.map(e => Number(e.seq)));
  assert.ok(seqs.length > before.events.length && seqs.every((seq, i) => i === 0 || seq > seqs[i - 1]), 'new history appends after the restored history');
  // Private artifact bytes come back intact and are still served only to the right identity.
  const artifactId = (await restored.pool.query('SELECT id FROM validation_artifacts WHERE request_id=$1', [request.id])).rows[0].id;
  const served = await validation.readArtifact(collector, request.id, artifactId);
  assert.ok(served.bytes.toString('utf8').includes('artifact-bytes-marker'));
  await source.close(); await restored.close();
});

test('a tampered, truncated or newer-schema backup refuses, and a newer-schema database refuses this release', async () => {
  const source = new Store(url('occupied')); await source.init();
  await populate(source);
  const backup = await createBackup(source.pool);
  const edited = { ...backup, tables: backup.tables.map(t => t.name === 'events' ? { ...t, rows: t.rows.slice(1) } : t) };
  assert.throws(() => verifyBackup(edited), /digest does not match/);
  const resigned = { ...edited, digest: backupDigest(edited) };
  assert.equal(verifyBackup(resigned).tables.find(t => t.name === 'events')!.rows.length, backup.tables.find(t => t.name === 'events')!.rows.length - 1, 'a consistently re-signed edit is a different, still well-formed backup');
  const future = { ...backup, schemaVersion: schemaVersion + 1 };
  assert.throws(() => verifyBackup({ ...future, digest: backupDigest(future) }), /newer than this release supports/);
  assert.throws(() => verifyBackup({ ...backup, format: 'graphyard-backup-v0' }));
  assert.throws(() => backupSchema.parse({ ...backup, tables: [...backup.tables, { name: 'pg_authid', rows: [] }] }));
  await assert.rejects(restoreBackup(source.pool, backup), /Restore requires an empty database/);
  const newer = new Store(url('newer')); await newer.init();
  await newer.pool.query("INSERT INTO graphyard_schema(version, graphyard_version) VALUES($1, '9.9.9')", [schemaVersion + 1]);
  await assert.rejects(newer.init(), /newer than this release supports/);
  await assert.rejects(createBackup(newer.pool), /differs from this release/);
  await source.close(); await newer.close();
});

test('the shipped db backup, verify and restore commands perform the exercise end to end', async () => {
  const source = new Store(url('source'));
  const launcher = resolve('bin/graphyard.mjs');
  const env = { ...process.env, DATABASE_URL: url('source'), GRAPHYARD_URL: undefined, GRAPHYARD_TOKEN: undefined } as Record<string, string | undefined>;
  const file = join(scratch, 'ledger.json');
  const taken = JSON.parse((await run(process.execPath, [launcher, 'db', 'backup', file], { env, cwd: scratch })).stdout);
  assert.equal(taken.schema, schemaVersion); assert.ok(taken.rows.work_items >= 2);
  const verified = JSON.parse((await run(process.execPath, [launcher, 'db', 'verify', file], { env, cwd: scratch })).stdout);
  assert.equal(verified.valid, true);
  const corrupted = join(scratch, 'corrupted.json');
  await writeFile(corrupted, (await readFile(file, 'utf8')).replace('"actor":"operator"', '"actor":"someone-else"'));
  await assert.rejects(run(process.execPath, [launcher, 'db', 'verify', corrupted], { env, cwd: scratch }), /digest does not match/);
  const target = { ...env, DATABASE_URL: url('cli_restored') };
  const restored = JSON.parse((await run(process.execPath, [launcher, 'db', 'restore', file], { env: target, cwd: scratch })).stdout);
  assert.deepEqual(restored.counts, await ledgerCounts(source.pool));
  const status = JSON.parse((await run(process.execPath, [launcher, 'db', 'status'], { env: target, cwd: scratch })).stdout);
  assert.equal(status.schema, schemaVersion); assert.deepEqual(status.counts, restored.counts);
  await assert.rejects(run(process.execPath, [launcher, 'db', 'restore', file], { env: target, cwd: scratch }), /Restore requires an empty database/);
  await assert.rejects(run(process.execPath, [launcher, 'db', 'status'], { env: { ...env, DATABASE_URL: undefined }, cwd: scratch }), /Set DATABASE_URL/);
  await source.close();
});
