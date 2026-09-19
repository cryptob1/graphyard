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
import { Delivery } from '../src/delivery.js';
import { defineScenario } from '../src/scenarios.js';
import { ProofGrants, authorizedForProof } from '../src/proof-grants.js';
import { recordIntake, recordLeadRuling } from '../src/delegation.js';
import type { Principal } from '../src/model.js';
import { projectFlow } from '../src/flow-analytics.js';
import { backupDigest, backupSchema, createBackup, ledgerCounts, restoreBackup, verifyBackup } from '../src/backup.js';
import { ledgerSeeded } from '../src/store.js';
import { schemaVersion } from '../src/release.js';

const run = promisify(execFile);
const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const runner: Principal = { id: 'runner', role: 'worker' };
const collector: Principal = { id: 'collector', role: 'producer', proofs: ['e2e:booking'] };
const builder: Principal = { id: 'builder', role: 'producer' };
const auditor: Principal = { id: 'auditor', role: 'producer', proofs: ['manual:audit'] };
const observer: Principal = { id: 'observer', role: 'producer' };
const promoter: Principal = { id: 'promoter', role: 'producer' };
const lead: Principal = { id: 'product-lead', role: 'slice-lead', slice: 'product', sessionKind: 'ai' };
const principals = [operator, worker, runner, collector, builder, auditor, observer, promoter, lead];
const sha = 'a'.repeat(40), base = 'b'.repeat(40), digest = `sha256:${'c'.repeat(64)}`, inputs = `sha256:${'d'.repeat(64)}`;
let pg: EmbeddedPostgres, port: number, scratch: string;
const id = () => randomUUID();
const url = (database: string) => `postgres://graphyard:testing-only@127.0.0.1:${port}/${database}`;

before(async () => {
  port = Number(process.env.GRAPHYARD_BACKUP_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 6);
  scratch = await mkdtemp(join(tmpdir(), 'graphyard-backup-'));
  pg = new EmbeddedPostgres({ databaseDir: join(scratch, 'data'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start();
  for (const name of ['source', 'restored', 'occupied', 'cli_restored', 'newer', 'authority', 'seeded']) await pg.createDatabase(name);
});
after(async () => { if (pg) await pg.stop(); });

/**
 * A ledger holding everything the roadmap says an upgrade and restore must preserve: an
 * assignment under a live lease with its registered workspace, the append-only history
 * behind it, two revisions of one scenario, and a validation request that is still
 * pending. Plus the tables an installation accumulates around them, and the proof-grant
 * ledger after the operator has moved it away from the environment seed: one producer
 * holds a pattern that exists only in the database, another has had its seeded pattern
 * revoked. Both are what a restore that re-seeded the environment would get wrong. And the
 * delivery side of the same environment: an attested release build, the release selected
 * from it under an approval, the observer's lease and the observation that verified it,
 * then a second release selected over it and a rollback requested back to the first.
 * And the delegation ledger: a slice lead's standing ruling over an item in its slice and
 * an intake item citing it, both immutable rows a restore has to carry as history.
 */
async function populate(store: Store) {
  const engine = new Engine(store, [15368], 120, 'test/repository');
  const validation = new Validation(engine, principals, 'test/repository');
  const grants = new ProofGrants(store, principals);
  assert.equal((await grants.seed()).length, 5, 'every producer is materialized from the environment');
  await grants.grant(operator, builder.id, { patterns: ['unit:*'], reason: 'Builder attests unit evidence' }, id());
  await grants.revoke(operator, auditor.id, { patterns: ['manual:audit'], reason: 'Audit authority withdrawn inside Graphyard' }, id());
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
  const later = await engine.execute(operator, 'create', null, { title: 'Later work', slice: 'product', criteria: [{ id: 'AC-1', text: 'Later', proofs: ['unit:later'] }] }, id());
  await recordLeadRuling(store, lead, later.id, { action: 'send-back', ruleId: 'rules/plan-v1#coverage', reason: 'Negative coverage is missing' }, id());
  await recordIntake(store, operator, { origin: 'verification-finding', title: 'Cancellation is unproven', description: 'Found while reviewing the plan', sourceWorkId: later.id }, id());
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
  // Observed delivery for the same environment: a release built, approved, selected and
  // seen running, so the restored ledger still knows what production is expected to be.
  const delivery = new Delivery(validation);
  await validation.define(operator, { kind: 'registration', id: 'observer-1', expectedRevision: 0, principalId: observer.id, role: 'observer', environment, adapterVersion: 'test-v1', proofs: [], enabled: true, services: ['api'] }, id());
  await validation.define(operator, { kind: 'registration', id: 'promoter-1', expectedRevision: 0, principalId: promoter.id, role: 'promoter', environment, adapterVersion: 'test-v1', proofs: [], enabled: true, services: ['api'] }, id());
  const releaseBuild: any = await delivery.attestBuild(builder, { registration: { id: 'builder-1', revision: 1 }, sourceSha: sha, buildInputsDigest: inputs, artifacts: [{ service: 'api', digest }], provenanceUrl: 'https://ci.example.test/build/2' }, id());
  const release: any = await delivery.createRelease(operator, { id: 'release-1', expectedRevision: 0, environment, sourceSha: sha, buildId: releaseBuild.id, manifest: releaseBuild.artifacts, members: [] }, id());
  const approval: any = await delivery.approve(operator, { release: { id: release.id, revision: release.revision }, environment }, id());
  await delivery.select(operator, { environment, release: { id: release.id, revision: release.revision }, expectedGeneration: 0, approvalId: approval.id }, id());
  const lease: any = await delivery.lease(observer, { registration: { id: 'observer-1', revision: 1 } });
  const now = Date.now(), at = (offsetSeconds: number) => new Date(now + offsetSeconds * 1000).toISOString();
  await delivery.observe(observer, { registration: { id: 'observer-1', revision: 1 }, epoch: lease.epoch, environment, expectedGeneration: 1, snapshotId: 'snapshot-1', observedAt: at(0), validFrom: at(-60), validTo: at(0),
    services: [{ service: 'api', complete: true, instances: [{ instance: 'api-1', digest, measurement: 'provider', healthy: true }], deployment: { id: 'dep-api', status: 'success', deployedAt: at(-120) } }] }, id());
  await delivery.sweep();
  // Recovery: a second release supersedes the verified one, and the operator asks for a
  // rollback to the release that was verified, so the restored ledger still carries the
  // open rollback and the history it was judged against.
  const secondBuild: any = await delivery.attestBuild(builder, { registration: { id: 'builder-1', revision: 1 }, sourceSha: base, buildInputsDigest: inputs, artifacts: [{ service: 'api', digest: inputs }], provenanceUrl: 'https://ci.example.test/build/3' }, id());
  const secondRelease: any = await delivery.createRelease(operator, { id: 'release-2', expectedRevision: 0, environment, sourceSha: base, buildId: secondBuild.id, manifest: secondBuild.artifacts, members: [] }, id());
  const secondApproval: any = await delivery.approve(operator, { release: { id: secondRelease.id, revision: secondRelease.revision }, environment }, id());
  await delivery.select(operator, { environment, release: { id: secondRelease.id, revision: secondRelease.revision }, expectedGeneration: 1, approvalId: secondApproval.id }, id());
  await delivery.requestRollback(operator, { environment, target: { id: release.id, revision: release.revision }, expectedGeneration: 2, reason: 'Release two degraded' }, id());
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
  const grants = (await store.pool.query('SELECT principal_id, document FROM proof_grants ORDER BY principal_id')).rows;
  const grantHistory = (await store.pool.query('SELECT seq, principal_id, document, created_at FROM proof_grant_history ORDER BY seq')).rows;
  const releases = (await store.pool.query('SELECT id, revision, document FROM releases ORDER BY id, revision')).rows;
  const approvals = (await store.pool.query('SELECT id, document FROM release_approvals ORDER BY id')).rows;
  const environments = (await store.pool.query('SELECT environment_id, document FROM delivery_environments ORDER BY environment_id')).rows;
  const observations = (await store.pool.query('SELECT seq, id, environment_id, registration_id, snapshot_id, document, received_at FROM delivery_observations ORDER BY seq')).rows;
  const leases = (await store.pool.query('SELECT registration_id, principal, epoch, expires_at FROM delivery_leases ORDER BY registration_id')).rows;
  const rulings = (await store.pool.query('SELECT id, work_id, lead_id, slice_id, action, rule_id, reason, created_at FROM lead_rulings ORDER BY created_at, id')).rows;
  const intake = (await store.pool.query('SELECT id, origin, title, description, source_work_id, submitted_by, created_at FROM intake_items ORDER BY created_at, id')).rows;
  const polls = (await store.pool.query('SELECT registration_id, principal, polled_at, granted_request_id FROM validation_runner_polls ORDER BY registration_id')).rows;
  const rollbacks = (await store.pool.query('SELECT id, environment_id, generation, document, created_at FROM delivery_rollbacks ORDER BY created_at, id')).rows;
  const flowFacts = (await store.pool.query('SELECT id, work_id, kind, observed_at, source_event, dedupe FROM flow_facts ORDER BY id')).rows;
  const flowCheckpoint = (await store.pool.query('SELECT id, last_event FROM flow_projection ORDER BY id')).rows;
  return { work, events, scenarios, requests, resources, artifacts, definitions, grants, grantHistory, releases, approvals, environments, observations, leases, rulings, intake, polls, rollbacks, flowFacts, flowCheckpoint };
}

test('the documented backup and restore exercise preserves assignments, history, scenario revisions and pending requests, and the restored ledger keeps ordering', async () => {
  const source = new Store(url('source')); await source.init();
  const seeded = await populate(source);
  // The flow projection has folded the ledger so far: durable facts plus the checkpoint
  // row the migration seeds and the projection advances.
  await projectFlow(source);
  const before = await snapshot(source);
  assert.ok(before.work.find(w => w.id === seeded.workId)!.lease, 'the fixture holds a live assignment');
  assert.ok(before.flowFacts.length > 0 && Number(before.flowCheckpoint[0].last_event) > 0, 'the fixture holds projected flow facts behind an advanced checkpoint');
  assert.equal(before.requests.find(r => r.id === seeded.requestId)!.document.state, 'collecting');
  assert.equal(before.scenarios.length, 2);
  assert.deepEqual(before.grants.map(g => [g.principal_id, g.document.patterns]), [['auditor', []], ['builder', ['unit:*']], ['collector', ['e2e:booking']], ['observer', []], ['promoter', []]]);
  assert.deepEqual(before.grantHistory.map(h => [Number(h.seq), h.principal_id, h.document.kind]), [[1, 'collector', 'seed'], [2, 'builder', 'seed'], [3, 'auditor', 'seed'], [4, 'observer', 'seed'], [5, 'promoter', 'seed'], [6, 'builder', 'grant'], [7, 'auditor', 'revoke']]);
  assert.equal(before.approvals.length, 2); assert.equal(before.observations.length, 1); assert.equal(before.leases.length, 1);
  assert.equal(before.environments[0].document.verification?.status, 'unobserved', 'the fixture holds a newly selected second release');
  assert.deepEqual(before.environments[0].document.history.map((h: any) => [h.releaseId, h.outcome]).filter((h: any) => h[1] === 'verified'), [['release-1', 'verified']], 'the first release was verified before it was superseded');
  assert.deepEqual(before.rulings.map(r => [r.lead_id, r.action]), [[lead.id, 'send-back']], 'the fixture holds a standing slice-lead ruling');
  assert.deepEqual(before.intake.map(i => [i.origin, i.submitted_by]), [['verification-finding', operator.id]], 'the fixture holds an intake item citing sliced work');
  assert.equal(before.work.find(w => w.slice === 'product')!.leadHold?.action, 'send-back');
  assert.deepEqual(before.polls.map(p => [p.registration_id, p.granted_request_id]), [['runner-1', seeded.requestId]], 'the fixture holds the runner poll that granted the request');
  assert.deepEqual(before.rollbacks.map(r => [r.environment_id, r.generation, r.document.state]), [['preview', 3, 'requested']], 'the fixture holds an open rollback, its own generation, back to the verified release');
  assert.equal(before.releases.length, 2, 'two releases, the second superseding the verified first');

  const backup = await createBackup(source.pool);
  assert.ok(backup.sequences.some(s => s.name.endsWith('proof_grant_history_seq_seq') && s.value === 7), 'the grant history sequence travels with the backup');
  assert.ok(backup.sequences.some(s => s.name.endsWith('delivery_observations_seq_seq') && s.value === 1), 'the observation sequence travels with the backup');
  assert.equal(backup.schemaVersion, schemaVersion); assert.equal(verifyBackup(backup).format, 'graphyard-backup-v1');
  assert.deepEqual(Object.fromEntries(backup.tables.map(t => [t.name, t.rows.length])), await ledgerCounts(source.pool));

  // A restore needs a migrated, empty target; nothing else is accepted.
  const restored = new Store(url('restored'));
  await assert.rejects(restoreBackup(restored.pool, backup), /relation "graphyard_schema" does not exist|migrated/);
  await restored.init();
  // A migrated target is empty except at the checkpoints the migration seeds; those are
  // replaced by the backup's rows rather than refused as occupied state.
  assert.deepEqual(ledgerSeeded, ['flow_projection']);
  assert.deepEqual((await snapshot(restored)).flowCheckpoint.map(r => [r.id, Number(r.last_event)]), [[1, 0]], 'the migration seeds the projection checkpoint');
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
  // Proof authority is the restored ledger, not the environment: the release's bootstrap
  // seed finds every producer materialized, the revoked pattern stays revoked, the grant
  // that existed only in the database still authorizes, and new history appends after
  // the restored history instead of colliding with it.
  const grants = new ProofGrants(restored, principals);
  assert.deepEqual(await grants.seed(), [], 'restart after restore does not re-seed the environment allowlist');
  await restored.transaction(async db => {
    assert.equal(await authorizedForProof(db, auditor, 'manual:audit'), false);
    assert.equal(await authorizedForProof(db, builder, 'unit:after'), true);
  });
  assert.deepEqual((await grants.history(operator, auditor.id)).map(h => [h.seq, h.kind, h.effective]), [[3, 'seed', ['manual:audit']], [7, 'revoke', []]]);
  const regranted = await grants.grant(operator, auditor.id, { patterns: ['manual:audit'], reason: 'Audit authority restored after the exercise', expectedRevision: 2 }, id());
  assert.equal(regranted.revision, 3);
  assert.deepEqual((await grants.history(operator, auditor.id)).map(h => h.seq), [3, 7, 8]);
  await source.close(); await restored.close();
});

test('a target the release already started against refuses a restore, because its seeded proof authority would sit beside the backup\'s', async () => {
  const source = new Store(url('authority')); await source.init();
  await populate(source);
  const backup = await createBackup(source.pool);
  const seeded = new Store(url('seeded')); await seeded.init();
  // What `graphyard serve` does on first boot with producers in GRAPHYARD_PRINCIPALS.
  assert.equal((await new ProofGrants(seeded, principals).seed()).length, 5);
  await assert.rejects(restoreBackup(seeded.pool, backup), /proof_grants already holds 5 row\(s\).*graphyard db migrate/);
  assert.deepEqual((await ledgerCounts(seeded.pool)).work_items, 0, 'the refused restore wrote nothing');
  await source.close(); await seeded.close();
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
