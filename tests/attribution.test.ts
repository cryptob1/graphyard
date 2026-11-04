import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import EmbeddedPostgres from './helpers/warm-postgres.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { Validation, type ValidationCandidate, type ValidationRequest } from '../src/validation.js';
import { Delivery, type Release } from '../src/delivery.js';
import { defineScenario } from '../src/scenarios.js';
import { currentEvidence, type Observation, type Principal } from '../src/model.js';
import { server } from '../src/server.js';
import { candidateManifest, compatibilitySignature, digestHash, signatureDifferences, targetIdentity, type AttributionRecord } from '../src/attribution.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { localRequest } from './helpers/local-request.js';
import { defaultRepositoryPolicy, setRepositoryPolicy } from '../src/model/repository-policy.js';
// GY-2965: the fixtures create items carrying e2e: proofs, so this process declares the serve the trial would use.
setRepositoryPolicy({ ...defaultRepositoryPolicy, e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

import { deliverThroughLedger } from './helpers/ledger-delivery.js';

/**
 * GY-39: candidate/deployment attribution integrity, safe re-anchoring and analytics. One
 * node:test case per integration proof, named after it. Every case runs against a disposable
 * real Postgres; observers, promoters, builders and collectors are distinct principals, and
 * nothing here talks to a provider — what is under test is what Graphyard does with what
 * authenticated identities report, and what it refuses to do with anything else.
 */
const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const coordinator: Principal = { id: 'master', role: 'coordinator' };
const runner: Principal = { id: 'runner', role: 'worker' };
const collector: Principal = { id: 'collector', role: 'producer', proofs: ['integration:claim-safety'] };
const builder: Principal = { id: 'builder', role: 'producer' };
const observer: Principal = { id: 'observer', role: 'producer' };
const secondObserver: Principal = { id: 'observer-2', role: 'producer' };
const promoter: Principal = { id: 'promoter', role: 'producer' };
const reader: Principal = { id: 'auditor', role: 'reader' };
const principals = [operator, worker, coordinator, runner, collector, builder, observer, secondObserver, promoter, reader];
const attestationPublicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
const sha = 'a'.repeat(40), base = 'b'.repeat(40), otherSha = '9'.repeat(40);
const d = (label: string) => `sha256:${label.repeat(64).slice(0, 64)}`;
const A = { api: d('1'), web: d('2') }, B = { api: d('3'), web: d('4') }, C = { api: d('5'), web: d('6') };
const inputs = d('d'), bundleDigest = d('c'), runnerImage = d('e');
const artifactsOf = (m: Record<string, string>) => Object.entries(m).map(([service, digest]) => ({ service, digest }));
let pg: EmbeddedPostgres, store: Store, engine: Engine, validation: Validation, delivery: Delivery;
let http: ReturnType<typeof server>, url: string;
let serial = 0;
const tokens = Object.fromEntries(principals.map(p => [p.id, `${p.id}-token-${'x'.repeat(32)}`]));
before(async () => {
  const port = Number(process.env.GRAPHYARD_ATTRIBUTION_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 15);
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('attribution'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('attribution_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/attribution_test`); await store.init();
  engine = new Engine(store, 120, 'test/repository'); validation = new Validation(engine, principals, 'test/repository'); delivery = new Delivery(validation);
  const configured = process.env.GRAPHYARD_MAX_REVIEWERS; process.env.GRAPHYARD_MAX_REVIEWERS = '8';
  try { http = server(engine, principals.map(p => ({ ...p, token: tokens[p.id] }))); }
  finally { if (configured === undefined) delete process.env.GRAPHYARD_MAX_REVIEWERS; else process.env.GRAPHYARD_MAX_REVIEWERS = configured; }
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (pg) await pg.stop(); });
const id = () => randomUUID();
const at = (offsetSeconds: number, from = Date.now()) => new Date(from + offsetSeconds * 1000).toISOString();
async function current(workId: string) { return (await store.list()).find(w => w.id === workId)!; }
async function request(requestId: string): Promise<ValidationRequest> { return (await store.pool.query('SELECT document FROM validation_requests WHERE id=$1', [requestId])).rows[0].document; }
async function candidate(candidateId: string): Promise<ValidationCandidate> { return (await store.pool.query('SELECT document FROM validation_candidates WHERE id=$1', [candidateId])).rows[0].document; }
async function records(workId: string, kind?: string): Promise<AttributionRecord[]> {
  return (await store.pool.query('SELECT * FROM attribution_records WHERE work_id=$1 AND ($2::text IS NULL OR kind=$2) ORDER BY seq', [workId, kind ?? null])).rows.map(r => ({ id: r.id, seq: Number(r.seq), workId: r.work_id, workKey: r.work_key, proof: r.proof, environmentId: r.environment_id, candidateId: r.candidate_id, requestId: r.request_id, attemptId: r.attempt_id, kind: r.kind, recordedAt: r.recorded_at.toISOString(), dedupe: r.dedupe, details: r.details }));
}
async function api(path: string, token = tokens.operator, init: RequestInit = {}) {
  const response = await fetch(`${url}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': id(), ...(init.headers ?? {}) } });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** An environment with two services and every identity the attribution path needs, plus one candidate and one queued request bound to manifest A. */
async function fixture(options: { immutable?: boolean; artifacts?: Record<string, string>; request?: boolean } = {}) {
  const n = ++serial, environment = { id: `env-${n}`, revision: 1 }, proof = `e2e:scenario-${n}`;
  const refs = { runner: { id: `runner-${n}`, revision: 1 }, collector: { id: `collector-${n}`, revision: 1 }, builder: { id: `builder-${n}`, revision: 1 }, observer: { id: `observer-${n}`, revision: 1 }, secondObserver: { id: `observer2-${n}`, revision: 1 }, promoter: { id: `promoter-${n}`, revision: 1 }, bundle: { id: `bundle-${n}`, revision: 1 } };
  collector.proofs!.push(proof);
  const scenario = await defineScenario(store, operator, { id: `scenario-${n}`, title: 'Behavior', purpose: 'Prove behavior', steps: ['Execute'], expected: ['Correct'], environment: environment.id, runner: 'playwright', testPath: 'tests/behavior.spec.ts' }, id());
  await validation.define(operator, { kind: 'environment', id: environment.id, expectedRevision: 0, repository: 'test/repository', url: 'https://target.example.test', instance: `instance-${n}`, immutable: options.immutable ?? true, services: ['api', 'web'], resources: [`account-${n}`] }, id());
  const define = (ref: { id: string }, actor: Principal, role: string, extra: Record<string, unknown> = {}) => validation.define(operator, { kind: 'registration', id: ref.id, expectedRevision: 0, principalId: actor.id, role, environment, adapterVersion: 'test-v1', proofs: role === 'collector' ? [proof] : [], enabled: true, ...extra }, id());
  await define(refs.runner, runner, 'runner', { executionHost: 'unix:///var/run/docker.sock', attestationPublicKey, executionNetwork: 'gy-isolated' });
  await define(refs.collector, collector, 'collector'); await define(refs.builder, builder, 'builder');
  await define(refs.observer, observer, 'observer', { services: ['api', 'web'] }); await define(refs.secondObserver, secondObserver, 'observer', { services: ['api', 'web'] }); await define(refs.promoter, promoter, 'promoter', { services: ['api', 'web'] });
  await validation.define(operator, { kind: 'bundle', id: refs.bundle.id, expectedRevision: 0, scenario: scenario.id, scenarioRevision: scenario.revision, scenarioHash: scenario.hash, digest: bundleDigest, runnerImageDigest: runnerImage }, id());
  let w = await engine.execute(operator, 'create', null, { type: 'chore',  title: `Attribution fixture ${n}`, criteria: [{ id: 'AC-1', text: 'Behavior is proven', proofs: [proof, 'e2e:fixture'] }] }, id());
  w = await engine.execute(operator, 'ready', w.id, {}, id()); w = await engine.execute(worker, 'claim', w.id, {}, id());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/attribution-${n}`, branch: `graphyard/attribution-${n}` }, id());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: n }, id());
  w = await engine.observe(w.id, w.revision, { candidate: { sha, baseSha: base, pr: n, branch: `graphyard/attribution-${n}`, author: 'implementer' }, checks: [{ name: 'test', appId: 15368, result: 'success' }, { name: 'typecheck', appId: 15368, result: 'success' }], reviews: [{ reviewer: 'other', sha, state: 'APPROVED' }], merged: false, mergeSha: null, protected: true, mergeable: true, files: [], scopeFiles: [], at: new Date().toISOString() });
  const f = { n, w, proof, environment, refs, scenario, epoch: (await delivery.lease(observer, { registration: refs.observer })).epoch, secondEpoch: (await delivery.lease(secondObserver, { registration: refs.secondObserver })).epoch,
    build: null as any, c: null as unknown as ValidationCandidate, r: null as unknown as ValidationRequest };
  f.build = await attest(f, options.artifacts ?? A);
  f.c = await validation.createCandidate(operator, candidateInput(f, f.build.id), id()) as ValidationCandidate;
  if (options.request !== false) f.r = await validation.createRequest(operator, await requestInput(f, f.c.id), id()) as ValidationRequest;
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const candidateInput = (f: Fixture, buildAttestationId: string) => ({ workId: f.w.id, expectedWorkRevision: f.w.revision, proof: f.proof, environment: f.environment, bundle: f.refs.bundle, buildAttestationId, requiredArtifacts: ['report'], artifactStorage: 'external' as const });
async function requestInput(f: Fixture, candidateId: string) { return { candidateId, expectedWorkRevision: (await current(f.w.id)).revision, runner: f.refs.runner, collector: f.refs.collector, deadline: at(600), maxAttempts: 3 }; }
async function attest(f: Fixture, artifacts: Record<string, string>, buildInputsDigest = inputs): Promise<any> {
  const w = await current(f.w.id);
  return validation.attestBuild(builder, { registration: f.refs.builder, workId: w.id, expectedWorkRevision: w.revision, sourceSha: sha, baseSha: base, buildInputsDigest, artifacts: artifactsOf(artifacts), provenanceUrl: 'https://ci.example.test/build' }, id());
}
/** A provider snapshot of both services; `measurement` and `complete` shape the trust of each instance. */
function services(digests: Record<string, string | null>, options: { measurement?: 'provider' | 'host-attestation' | 'self-report' | 'unknown'; complete?: boolean; healthy?: boolean } = {}) {
  return Object.entries(digests).map(([service, digest]) => ({ service, complete: options.complete ?? true, instances: [{ instance: `${service}-1`, digest, measurement: options.measurement ?? 'provider', healthy: options.healthy ?? true }] }));
}
/** One observation. Offsets are seconds relative to `now`; the default is a sample valid for the next minute. */
async function observe(f: Fixture, digests: Record<string, string | null>, options: { validFrom?: number; validTo?: number; observedAt?: number; now?: number; measurement?: 'provider' | 'host-attestation' | 'self-report' | 'unknown'; complete?: boolean; actor?: Principal; registration?: { id: string; revision: number }; epoch?: number; snapshotId?: string; via?: Delivery } = {}) {
  const now = options.now ?? Date.now(), validFrom = at(options.validFrom ?? -30, now), validTo = at(options.validTo ?? 60, now), observedAt = at(options.observedAt ?? 0, now);
  return (options.via ?? delivery).observe(options.actor ?? observer, { registration: options.registration ?? f.refs.observer, epoch: options.epoch ?? f.epoch, environment: f.environment, expectedGeneration: 0, snapshotId: options.snapshotId ?? id(), observedAt, validFrom, validTo, services: services(digests, options) }, id());
}
async function start(f: Fixture, r = f.r) {
  const dispatched: any = await validation.dispatch(runner, { registration: f.refs.runner }, id()); assert.equal(dispatched.request?.id, r.id, `dispatch grants ${r.id}: ${dispatched.reason ?? ''}`);
  const command = { requestId: r.id, attemptId: dispatched.attempt.id, epoch: dispatched.attempt.epoch };
  await validation.runnerCommand(runner, 'ack', command, id()); await validation.collectionAuthority(collector, command); return command;
}
function report(f: Fixture, command: { requestId: string; attemptId: string; epoch: number }, artifacts: Record<string, string> = A, target: Record<string, unknown> = {}) {
  return { ...command, execution: 'completed', behavior: 'passed', executed: 2, skipped: 0, inventoryComplete: true, target: { instance: `instance-${f.n}`, artifacts: artifactsOf(artifacts), measurement: 'provider', coversEntireRun: true, attribution: 'matched', ...target }, bundleDigest, runnerImageDigest: runnerImage, artifacts: [{ name: 'report', digest: bundleDigest, url: 'https://private.example.test/report' }], artifactState: 'verified', executionSettled: true, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } };
}
async function cleanup(f: Fixture) {
  for (const r of (await store.pool.query("SELECT document FROM validation_requests WHERE document->>'workId'=$1", [f.w.id])).rows.map(row => row.document as ValidationRequest)) {
    const fresh = await request(r.id);
    if (['queued', 'dispatched', 'running', 'collecting'].includes(fresh.state)) await validation.operatorCommand(operator, 'cancel', { requestId: fresh.id, epoch: fresh.attempts.at(-1)?.epoch ?? 0, reason: 'Test process never launched' }, id());
    const a = (await request(r.id)).attempts.at(-1); if (a && !a.settled) await validation.operatorCommand(operator, 'settle', { requestId: r.id, epoch: a.epoch, reason: 'Fixture has no external process', settlementEvidence: 'https://tests.example.test/no-process' }, id());
  }
}
/** Delivered work the way production reaches it: a candidate passing every gate whose merge GitHub reports, independently observed — release membership is checked against this. */
async function delivered(mergeSha: string) {
  let w = await engine.execute(operator, 'create', null, { type: 'chore',  title: `Delivered change ${++serial}`, criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:claim-safety', 'e2e:fixture'] }] }, id());
  w = await engine.execute(operator, 'ready', w.id, {}, id()); w = await engine.execute(worker, 'claim', w.id, {}, id());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/attribution-delivered-${serial}`, branch: `graphyard/attribution-delivered-${serial}` }, id());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: serial }, id());
  const observation = (): Observation => ({ clockOffset: { min: 0, max: 0 }, candidate: { sha, baseSha: base, pr: serial, branch: `graphyard/attribution-delivered-${serial}`, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'reviewer', sha, state: 'APPROVED' }], protected: true, mergeable: true, merged: false, mergeSha: null, files: [], scopeFiles: [], at: new Date().toISOString() });
  w = await engine.observe(w.id, w.revision, observation());
  w = await engine.execute(collector, 'evidence', w.id, { proof: 'integration:claim-safety', sha, baseSha: base, policyRevision: 1, result: 'pass', executed: 5, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } }, id());
  await engine.store.workItem(w.id);
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  // GY-2010: the merge writer's ledger delivers it, as production does; no GitHub merge is observed.
  w = await deliverThroughLedger(engine, w.id, mergeSha, mergedAt);
  assert.equal(w.stage, 'done'); return w;
}
async function release(f: Fixture, artifacts: Record<string, string>, sourceSha: string, members: { workId: string; mergeSha: string; included?: boolean }[] = [], releaseId = `release-${f.n}-${++serial}`) {
  const build: any = await delivery.attestBuild(builder, { registration: f.refs.builder, sourceSha, buildInputsDigest: inputs, artifacts: artifactsOf(artifacts), provenanceUrl: 'https://ci.example.test/release-build' }, id());
  return delivery.createRelease(operator, { id: releaseId, expectedRevision: 0, environment: f.environment, sourceSha, buildId: build.id, manifest: build.artifacts, members: members.map(m => ({ included: true, ...m })) }, id()) as Promise<Release>;
}

test('integration:release-manifest-attribution', async () => {
  const f = await fixture({ request: false });
  const member = await delivered('e'.repeat(40));
  // Membership is a trusted promotion record checked against independently observed delivery, never a client SHA.
  await assert.rejects(release(f, B, otherSha, [{ workId: member.id, mergeSha: 'f'.repeat(40) }]), /independently observed merge/);
  await assert.rejects(release(f, B, otherSha, [{ workId: f.w.id, mergeSha: sha }]), /delivered work/);
  await assert.rejects(delivery.createRelease(worker, { id: 'worker-release', expectedRevision: 0, environment: f.environment, sourceSha: otherSha, buildId: id(), manifest: artifactsOf(B), members: [] }, id()), /promotion principal/);
  await assert.rejects(delivery.createRelease(observer, { id: 'observer-release', expectedRevision: 0, environment: f.environment, sourceSha: otherSha, buildId: id(), manifest: artifactsOf(B), members: [], delegate: { registration: f.refs.observer, epoch: f.epoch } }, id()), /revoked or principal role/);
  const rel = await release(f, B, otherSha, [{ workId: member.id, mergeSha: 'e'.repeat(40) }, { workId: (await delivered('c'.repeat(40))).id, mergeSha: 'c'.repeat(40), included: false }]);
  await assert.rejects(store.pool.query("UPDATE releases SET document=jsonb_set(document,'{sourceSha}',to_jsonb($2::text)) WHERE id=$1", [rel.id, sha]), /append-only/);
  await assert.rejects(store.pool.query('DELETE FROM releases WHERE id=$1', [rel.id]), /append-only/);
  // A candidate manifest derives from the trusted build attestation the same way; a worker cannot attest one and a mutable self-report establishes nothing.
  const cm = candidateManifest(f.build, f.environment);
  assert.equal(f.c.manifestHash, cm.hash); assert.equal(f.c.digestHash, digestHash(artifactsOf(A)));
  await assert.rejects(validation.attestBuild(worker, { registration: f.refs.builder, workId: f.w.id, expectedWorkRevision: 1, sourceSha: sha, baseSha: base, buildInputsDigest: inputs, artifacts: artifactsOf(A), provenanceUrl: 'https://x.test' }, id()), /separately authorized/);
  await observe(f, B, { measurement: 'self-report' });
  const identity = targetIdentity((await store.pool.query('SELECT document FROM delivery_observations WHERE environment_id=$1', [f.environment.id])).rows.map(r => r.document), A);
  assert.equal(identity.state, 'unknown', 'a self-reported identity neither matches nor mismatches'); assert.equal(identity.digestHash, null);
  assert.match(identity.reasons.join(' '), /self-reported/);
  await cleanup(f);
});

test('integration:exact-target-validation', async () => {
  const f = await fixture();
  // The request binds the exact manifest, signature and target kind at creation.
  assert.equal(f.r.attribution?.manifestHash, f.c.manifestHash); assert.equal(f.r.attribution?.signature, f.c.signature);
  assert.equal(f.r.attribution?.targetKind, 'immutable-preview'); assert.equal(f.r.attribution?.target.state, 'unobserved');
  const created = await records(f.w.id, 'target-checked'); assert.equal(created.at(-1)?.details.phase, 'request');
  // An observer measures manifest A running; the grant pins that identity and the result must hold it for the whole window.
  const seen = await observe(f, A); assert.equal(seen.authoritative, true);
  const command = await start(f);
  const dispatched = await request(f.r.id);
  assert.equal(dispatched.attempts[0].target?.state, 'matched'); assert.deepEqual(dispatched.attempts[0].target?.observationIds, [seen.id]);
  const outcome: any = await validation.result(collector, report(f, command), id());
  assert.equal(outcome.passed, true, outcome.reasons.join('; '));
  const w = await current(f.w.id); const evidence = w.evidence.at(-1)!;
  assert.equal(evidence.attribution?.manifestHash, f.c.manifestHash); assert.equal(evidence.attribution?.signature, f.c.signature);
  assert.equal(evidence.attribution?.targetState, 'matched'); assert.deepEqual(evidence.attribution?.targetObservationIds, [seen.id]);
  assert.equal((await records(f.w.id, 'evidence-bound')).length, 1);
  assert.ok(currentEvidence(w, f.proof), 'the attributed pass is current evidence');
  // A pass is never reused: a fresh request for the same candidate needs fresh execution.
  const again = await validation.createRequest(operator, await requestInput(f, f.c.id), id()) as ValidationRequest;
  assert.equal(currentEvidence(await current(f.w.id), f.proof), undefined, 'the earlier pass does not carry to the new request');
  assert.equal(again.attempts.length, 0);
  await cleanup(f);

  // A known mismatch before creation refuses the request, before any paid execution.
  const g = await fixture({ request: false });
  await observe(g, B);
  await assert.rejects(validation.createRequest(operator, await requestInput(g, g.c.id), id()), /observed running another manifest/);
  const avoided = await records(g.w.id, 'paid-run-avoided'); assert.equal(avoided.length, 1); assert.equal(avoided[0].requestId, null); assert.equal(avoided[0].candidateId, g.c.id);
  assert.equal((await records(g.w.id, 'target-mismatch')).length, 1);

  // A mismatch learned after creation withholds the grant at dispatch.
  const h = await fixture();
  await observe(h, B);
  const poll: any = await validation.dispatch(runner, { registration: h.refs.runner }, id());
  assert.equal(poll.request, null, 'no grant against a target running another manifest');
  assert.equal((await request(h.r.id)).state, 'superseded');
  assert.equal((await records(h.w.id, 'paid-run-avoided')).length, 1);
  await cleanup(h);

  // Shared staging executes only once an observer has measured the candidate manifest running.
  const s = await fixture({ immutable: false });
  assert.equal(s.r.attribution?.targetKind, 'shared-staging');
  const withheld: any = await validation.dispatch(runner, { registration: s.refs.runner }, id());
  assert.equal(withheld.request, null); assert.match(withheld.reason, /shared staging has no measured observation/); assert.equal((await request(s.r.id)).state, 'queued', 'the request waits rather than being superseded');
  assert.equal((await records(s.w.id, 'target-checked')).at(-1)?.details.phase, 'dispatch-withheld');
  await observe(s, A, { measurement: 'self-report' });
  assert.equal(((await validation.dispatch(runner, { registration: s.refs.runner }, id())) as any).request, null, 'a self-report does not open shared staging');
  await observe(s, A);
  const granted = await start(s);
  assert.equal((await request(s.r.id)).attempts[0].target?.state, 'matched');
  const staged: any = await validation.result(collector, report(s, granted), id()); assert.equal(staged.passed, true, staged.reasons.join('; '));
  assert.equal((await current(s.w.id)).evidence.at(-1)?.attribution?.targetKind, 'shared-staging');
  await cleanup(s);
  // Shared staging also needs the observers' record to cover the whole run: a match observed only before the grant is not enough.
  const t = await fixture({ immutable: false });
  await observe(t, A, { validFrom: -2, validTo: -1, observedAt: -1 });
  const briefly = await start(t);
  await delay(5);
  const uncovered: any = await validation.result(collector, report(t, briefly), id());
  assert.equal(uncovered.accepted, true); assert.equal(uncovered.passed, false); assert.match(uncovered.reasons.join(' '), /Shared staging requires independently observed target identity across the entire execution window/);
  await cleanup(t);
});

test('integration:content-address-compatibility', async () => {
  const input = { manifestHash: 'm', sourceSha: sha, baseSha: base, policyRevision: 1, buildInputsDigest: inputs, bundle: { digest: bundleDigest, runnerImageDigest: runnerImage, scenarioHash: 'h'.repeat(64), scenarioRevision: 1 }, environment: { id: 'env', revision: 1 }, requiredArtifacts: ['report'], proof: 'e2e:x' };
  const baseline = compatibilitySignature(input);
  assert.equal(compatibilitySignature({ ...input, requiredArtifacts: ['report'] }).signature, baseline.signature, 'deterministic');
  const variants: [string, Partial<typeof input>][] = [
    ['manifest', { manifestHash: 'other' }], ['build-inputs', { buildInputsDigest: d('9') }], ['test-bundle', { bundle: { ...input.bundle, digest: d('8') } }], ['test-bundle', { bundle: { ...input.bundle, scenarioRevision: 2 } }],
    ['configuration', { environment: { id: 'env', revision: 2 } }], ['source', { sourceSha: otherSha }], ['policy', { policyRevision: 2 }], ['artifacts', { requiredArtifacts: ['report', 'trace'] }],
  ];
  for (const [component, change] of variants) {
    const next = compatibilitySignature({ ...input, ...change });
    assert.notEqual(next.signature, baseline.signature, `${component} change regenerates the signature`);
    assert.deepEqual(signatureDifferences(baseline.components, next.components), [component], `${component} is the named difference`);
  }
  // In the domain: a candidate's signature is derived from trusted records; a build-input change regenerates it and records what changed.
  const f = await fixture();
  const build = f.build;
  assert.equal(f.c.signature, compatibilitySignature({ manifestHash: f.c.manifestHash!, sourceSha: sha, baseSha: base, policyRevision: f.w.policyRevision, buildInputsDigest: build.buildInputsDigest, bundle: { digest: bundleDigest, runnerImageDigest: runnerImage, scenarioHash: f.scenario.hash, scenarioRevision: f.scenario.revision }, environment: f.environment, requiredArtifacts: ['report'], proof: f.proof }).signature);
  const rebuilt = await attest(f, A, d('7'));
  const next = await validation.createCandidate(operator, { ...candidateInput(f, rebuilt.id), expectedWorkRevision: (await current(f.w.id)).revision }, id()) as ValidationCandidate;
  assert.equal(next.manifestHash, f.c.manifestHash, 'same artifacts and source: same manifest'); assert.notEqual(next.signature, f.c.signature, 'different build inputs: different signature');
  const regenerated = await records(f.w.id, 'signature-regenerated'); assert.equal(regenerated.length, 1);
  assert.deepEqual(regenerated[0].details.changed, ['build-inputs']); assert.equal(regenerated[0].details.previousCandidateId, f.c.id);
  // The superseded candidate's request is invalidated; its authority cannot be replayed and no pass on it is accepted.
  assert.equal((await request(f.r.id)).state, 'superseded');
  await assert.rejects(validation.createRequest(operator, await requestInput(f, f.c.id), id()), /superseded/);
  const fresh = await validation.createRequest(operator, await requestInput(f, next.id), id()) as ValidationRequest;
  assert.equal(fresh.attribution?.signature, next.signature);
  await cleanup(f);
});

test('integration:immutable-attribution-history', async () => {
  const f = await fixture();
  await attest(f, B);
  const before = await request(f.r.id);
  const moved = await observe(f, B);
  const superseded = await request(f.r.id);
  // Movement supersedes; it never edits, relabels or retargets the existing record.
  assert.equal(superseded.state, 'superseded'); assert.equal(superseded.candidateId, before.candidateId); assert.deepEqual(superseded.attribution, before.attribution); assert.deepEqual(superseded.attempts, before.attempts);
  const fresh = await request((await current(f.w.id)).validation![f.proof].requestId!);
  assert.notEqual(fresh.id, f.r.id); assert.deepEqual(fresh.attribution?.reanchoredFrom, { requestId: f.r.id, attemptId: null, observationIds: [moved.id], trigger: 'observation' });
  // The ledger, the re-anchor fence and the observations are append-only at the database.
  for (const [table, column] of [['attribution_records', 'recorded_at'], ['attribution_reanchors', 'recorded_at'], ['delivery_observations', 'received_at']]) {
    assert.ok(Number((await store.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n) > 0, `${table} has rows to protect`);
    await assert.rejects(store.pool.query(`UPDATE ${table} SET ${column}=${column}`), /append-only/, `${table} refuses updates`);
    await assert.rejects(store.pool.query(`DELETE FROM ${table}`), /append-only/, `${table} refuses deletes`);
  }
  // Independent identity stays authoritative across delayed, stale, mixed and self-reported observations.
  const observations = async () => (await store.pool.query('SELECT document FROM delivery_observations WHERE environment_id=$1', [f.environment.id])).rows.map(r => r.document);
  const late = await observe(f, A, { observedAt: -20, validFrom: -25, validTo: -15 });
  assert.equal(late.authoritative, true); assert.equal(targetIdentity(await observations(), B).state, 'matched', 'a delayed report of an older state does not override the newer one');
  await observe(f, A, { measurement: 'self-report' });
  assert.equal(targetIdentity(await observations(), B).state, 'unknown', 'the latest sample is only self-reported, so the identity is unknown rather than a match or a rollback');
  await observe(f, B); assert.equal(targetIdentity(await observations(), B).state, 'matched');
  await delivery.lease(observer, { registration: f.refs.observer }); // a new epoch: the old one is stale
  const stale = await observe(f, A, { epoch: f.epoch }); assert.equal(stale.authoritative, false); assert.match(stale.rejection.join(' '), /epoch/);
  assert.equal(targetIdentity(await observations(), B).state, 'matched', 'a stale-epoch observation changes nothing');
  f.epoch = (await delivery.lease(observer, { registration: f.refs.observer })).epoch;
  // Partial-service convergence is visible as such; a rollback observed by measurement is a real movement.
  await observe(f, { api: A.api, web: B.web });
  const partial = targetIdentity(await observations(), B); assert.equal(partial.state, 'mismatched'); assert.equal(partial.partialConvergence, true); assert.equal(partial.matchedServices, 1); assert.equal(partial.digestHash, digestHash([{ service: 'api', digest: A.api }, { service: 'web', digest: B.web }]));
  // Two observers disagreeing over the same instant is ambiguity, not a decision.
  await observe(f, B); await observe(f, A, { actor: secondObserver, registration: f.refs.secondObserver, epoch: f.secondEpoch });
  const contested = targetIdentity(await observations(), B); assert.equal(contested.ambiguous, true); assert.match(contested.reasons.join(' '), /Overlapping observations/);
  // Immutable-preview use is visible on every request; its ledger history is never rewritten.
  assert.equal(fresh.attribution?.targetKind, 'immutable-preview');
  const history = await records(f.w.id);
  assert.ok(history.some(record => record.kind === 'superseded' && record.requestId === f.r.id));
  assert.ok(history.some(record => record.kind === 'rescheduled'));
  await cleanup(f);
});

test('integration:safe-automatic-reanchor', async () => {
  const f = await fixture();
  const buildB = await attest(f, B);
  // The target moves to a manifest a trusted build attestation of this very candidate produced: supersede and mint a fresh request.
  const moved = await observe(f, B);
  let w = await current(f.w.id);
  assert.equal((await request(f.r.id)).state, 'superseded');
  const fresh = await request(w.validation![f.proof].requestId!);
  const freshCandidate = await candidate(fresh.candidateId);
  assert.equal(freshCandidate.buildAttestationId, buildB.id); assert.deepEqual(freshCandidate.reanchoredFrom, { candidateId: f.c.id, requestId: f.r.id });
  assert.equal(fresh.state, 'queued'); assert.equal(fresh.attempts.length, 0, 'fresh execution is required'); assert.equal(fresh.attribution?.target.state, 'matched');
  assert.equal(fresh.createdBy, 'graphyard'); assert.deepEqual(fresh.runner, f.refs.runner); assert.equal(fresh.deadline, f.r.deadline);
  const fence = (await store.pool.query('SELECT * FROM attribution_reanchors WHERE superseded_request_id=$1', [f.r.id])).rows[0];
  assert.equal(fence.fresh_request_id, fresh.id); assert.equal(fence.document.trigger.observationId, moved.id); assert.equal(fence.document.trigger.actor, observer.id);
  assert.deepEqual((await records(f.w.id)).map(r => r.kind).filter(k => ['superseded', 'rescheduled', 'signature-regenerated'].includes(k)), ['superseded', 'signature-regenerated', 'rescheduled']);
  // The fresh request executes and passes against the observed target.
  const command = await start(f, fresh);
  const passed: any = await validation.result(collector, report(f, command, B), id()); assert.equal(passed.passed, true, passed.reasons.join('; '));
  w = await current(f.w.id); assert.ok(currentEvidence(w, f.proof), "currentEvidence(w, f.proof)");
  // A delayed observation of the execution window that measured manifest A undermines the pass; nothing is edited, the pass simply stops counting and the request is re-anchored.
  // The observer's newest sample still shows B, so the delayed one is history about the window, not the current identity.
  await observe(f, B);
  const done = await request(fresh.id), attempt = done.attempts.at(-1)!;
  const dispatchedAt = Date.parse(attempt.dispatchedAt);
  const delayed = await observe(f, A, { now: dispatchedAt, validFrom: 0, validTo: 0.001, observedAt: 0.001 });
  assert.equal(delayed.authoritative, true);
  w = await current(f.w.id);
  assert.equal(currentEvidence(w, f.proof), undefined, 'the undermined pass is no longer current');
  assert.equal(w.evidence.length, 1, 'the evidence record is preserved, not edited or removed'); assert.equal(w.evidence[0].result, 'pass');
  const undermined = await records(f.w.id, 'attribution-undermined'); assert.equal(undermined.length, 1); assert.equal(undermined[0].attemptId, attempt.id); assert.equal(undermined[0].details.evidenceId, w.evidence[0].id);
  assert.equal((await request(fresh.id)).state, 'superseded');
  // The latest identity is still B (the delayed sample is older), so the re-anchor lands on manifest B again with a new request needing fresh execution.
  const third = await request(w.validation![f.proof].requestId!);
  assert.notEqual(third.id, fresh.id); assert.equal(third.attempts.length, 0); assert.equal((await candidate(third.candidateId)).buildAttestationId, buildB.id);
  // Ambiguous membership blocks: manifest C matches no trusted record.
  await observe(f, C);
  w = await current(f.w.id);
  assert.equal((await request(third.id)).state, 'superseded');
  assert.equal(w.validation![f.proof].requestId, undefined); assert.equal(w.validation![f.proof].reanchor?.state, 'blocked'); assert.match(w.validation![f.proof].reanchor!.reasons.join(' '), /matches no trusted build attestation or release manifest/);
  assert.equal((await records(f.w.id, 'reanchor-blocked')).length, 1);
  // A trusted attestation of C for this candidate resolves the ambiguity on the next observation.
  const buildC = await attest(f, C);
  await observe(f, C);
  w = await current(f.w.id);
  assert.equal(w.validation![f.proof].reanchor, undefined); assert.equal((await candidate(w.validation![f.proof].candidateId)).buildAttestationId, buildC.id);
  const fourth = await request(w.validation![f.proof].requestId!); assert.equal(fourth.attribution?.reanchoredFrom?.trigger, 'retry');
  // A moved target that is a trusted release of another source does not contain the change: blocked, with the reason.
  const foreign = { api: d('7'), web: d('8') };
  await release(f, foreign, otherSha);
  await observe(f, foreign);
  w = await current(f.w.id);
  assert.equal(w.validation![f.proof].reanchor?.state, 'blocked'); assert.match(w.validation![f.proof].reanchor!.reasons[0], /does not contain the intended change/);
  assert.equal((await records(f.w.id, 'reanchor-blocked')).at(-1)?.details.contains, false);
  // A trusted release that names the change but has no build attestation of this work item for its manifest cannot mint a candidate: membership stays unresolved, with the reason on record.
  const named = { api: d('9'), web: d('a') };
  const namedRelease = await release(f, named, sha);
  await observe(f, named);
  w = await current(f.w.id);
  assert.equal(w.validation![f.proof].requestId, undefined); assert.equal(w.validation![f.proof].reanchor?.state, 'blocked');
  assert.deepEqual(w.validation![f.proof].reanchor!.reasons, ['A release names the change but no build attestation for this work item covers its manifest']);
  const unattested = (await records(f.w.id, 'reanchor-blocked')).at(-1)!;
  assert.equal(unattested.details.contains, null, 'membership without an attestation is unknown, not a yes'); assert.equal(unattested.details.reason, w.validation![f.proof].reanchor!.reasons[0]); assert.deepEqual(unattested.details.release, { id: namedRelease.id, revision: namedRelease.revision });
  // Once a build attestation of this candidate covers the released manifest, the next observation reschedules through release membership.
  const buildNamed = await attest(f, named);
  await observe(f, named);
  w = await current(f.w.id); assert.equal(w.validation![f.proof].reanchor, undefined); assert.equal((await candidate(w.validation![f.proof].candidateId)).buildAttestationId, buildNamed.id);
  assert.equal((await records(f.w.id, 'rescheduled')).at(-1)?.details.via, 'build-attestation');
  // Rollback to B is a movement like any other: the standing binding is superseded and rescheduled.
  await observe(f, B);
  w = await current(f.w.id); assert.equal(w.validation![f.proof].reanchor, undefined); assert.equal((await candidate(w.validation![f.proof].candidateId)).buildAttestationId, buildB.id);
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM attribution_reanchors WHERE fresh_request_id IN (SELECT id FROM validation_requests WHERE document->>\'workId\'=$1)', [f.w.id])).rows[0].n, 5);
  await cleanup(f);
});

test('integration:reanchor-races', async () => {
  const f = await fixture();
  await attest(f, B);
  const second = new Store(store.pool.options.connectionString!);
  try {
    const replica = new Delivery(new Validation(new Engine(second, 120, 'test/repository'), principals, 'test/repository'));
    // Concurrent observations of the same movement from two observers, through two replicas and a racing dispatch poll: exactly one fresh request.
    const now = Date.now();
    const results = await Promise.all([
      ...Array.from({ length: 4 }, (_, i) => observe(f, B, { now: now + i, via: i % 2 ? replica : delivery })),
      ...Array.from({ length: 4 }, (_, i) => observe(f, B, { now: now + i, actor: secondObserver, registration: f.refs.secondObserver, epoch: f.secondEpoch, via: i % 2 ? replica : delivery })),
      validation.dispatch(runner, { registration: f.refs.runner }, id()), replica.validation.dispatch(runner, { registration: f.refs.runner }, id()),
    ]);
    assert.ok(results.slice(0, 8).every((r: any) => r.authoritative === true), "results.slice(0, 8).every((r: any) => r.authoritative === true)");
    const fences = (await store.pool.query('SELECT * FROM attribution_reanchors WHERE superseded_request_id=$1', [f.r.id])).rows; assert.equal(fences.length, 1);
    const live = (await store.pool.query("SELECT document FROM validation_requests WHERE document->>'workId'=$1 AND document->>'state'<>'superseded'", [f.w.id])).rows.map(r => r.document as ValidationRequest);
    assert.equal(live.length, 1); assert.equal(live[0].id, fences[0].fresh_request_id);
    assert.equal((await records(f.w.id, 'rescheduled')).length, 1); assert.equal((await records(f.w.id, 'superseded')).length, 1);
    // A replayed observation (same snapshot id) is the original receipt and derives nothing new.
    const snapshotId = id(); const first = await observe(f, B, { snapshotId }); const replay = await observe(f, B, { snapshotId });
    assert.equal(replay.duplicate, true); assert.equal(replay.id, first.id);
    const before = (await records(f.w.id)).length; await observe(f, B, { snapshotId, via: replica }); assert.equal((await records(f.w.id)).length, before);
    // A stale lease epoch and a worker credential have no authority to move anything.
    const stale = await observe(f, B, { epoch: f.epoch + 7 }); assert.equal(stale.authoritative, false);
    await assert.rejects(observe(f, C, { actor: worker }), /observer credential/);
    assert.equal(live[0].id, (await current(f.w.id)).validation![f.proof].requestId);
    // Rescheduling carries principal identity and lease epoch: the fence records who observed under which registration.
    assert.equal(typeof fences[0].document.trigger.actor, 'string'); assert.ok([observer.id, secondObserver.id].includes(fences[0].document.trigger.actor), "[observer.id, secondObserver.id].includes(fences[0].document.trigger.actor)");
    // Racing movements A→B→A converge on one live request per movement, each with its own fence, and every superseded record stays.
    const back = await Promise.all([observe(f, A), observe(f, A, { via: replica }), observe(f, A, { actor: secondObserver, registration: f.refs.secondObserver, epoch: f.secondEpoch })]);
    assert.ok(back.every(r => r.authoritative), "back.every(r => r.authoritative)");
    const all = (await store.pool.query("SELECT document FROM validation_requests WHERE document->>'workId'=$1 ORDER BY document->>'createdAt'", [f.w.id])).rows.map(r => r.document as ValidationRequest);
    assert.equal(all.filter(r => r.state === 'superseded').length, 2); assert.equal(all.filter(r => r.state === 'queued').length, 1);
    assert.equal((await candidate(all.find(r => r.state === 'queued')!.candidateId)).buildAttestationId, f.build.id, 'back on manifest A: the fresh request binds the trusted build of A');
    assert.equal((await store.pool.query("SELECT count(*)::int AS n FROM attribution_reanchors WHERE fresh_request_id IN (SELECT id FROM validation_requests WHERE document->>'workId'=$1)", [f.w.id])).rows[0].n, 2);
  } finally { await cleanup(f); await second.close(); }
});

/** Backdate ledger rows for window tests: inserts are the only write the ledger accepts. */
test('integration:attribution-security-regressions', async () => {
  const f = await fixture();
  await attest(f, B);
  // Stale target: an old-epoch observation is retained as non-authoritative and moves nothing.
  await delivery.lease(observer, { registration: f.refs.observer });
  const stale = await observe(f, B, { epoch: f.epoch }); assert.equal(stale.authoritative, false); assert.equal((await request(f.r.id)).state, 'queued');
  f.epoch = (await delivery.lease(observer, { registration: f.refs.observer })).epoch;
  // Mixed A→B→A: each movement supersedes and re-anchors; the sequence is preserved.
  await observe(f, B); const afterB = await current(f.w.id); const rB = await request(afterB.validation![f.proof].requestId!); assert.equal((await candidate(rB.candidateId)).digestHash, digestHash(artifactsOf(B)));
  await observe(f, A); const afterA = await current(f.w.id); const rA = await request(afterA.validation![f.proof].requestId!); assert.equal((await candidate(rA.candidateId)).digestHash, digestHash(artifactsOf(A)));
  assert.deepEqual((await records(f.w.id, 'superseded')).map(r => r.requestId), [f.r.id, rB.id]);
  // Multiple PRs per release, a member excluded, and a rollback: membership decides containment, and an excluded member does not contain the change.
  const one = await delivered('1'.repeat(40)), two = await delivered('2'.repeat(40));
  await release(f, C, otherSha, [{ workId: one.id, mergeSha: '1'.repeat(40) }, { workId: two.id, mergeSha: '2'.repeat(40), included: false }]);
  await observe(f, C); let w = await current(f.w.id); assert.equal(w.validation![f.proof].reanchor?.state, 'blocked'); assert.match(w.validation![f.proof].reanchor!.reasons[0], /does not contain/);
  await observe(f, A); w = await current(f.w.id); assert.equal(w.validation![f.proof].reanchor, undefined, 'rolling back to a containing manifest reschedules');
  // Partial services and mutable self-reports never authorize a grant.
  await observe(f, { api: B.api, web: A.web }); assert.equal(((await validation.dispatch(runner, { registration: f.refs.runner }, id())) as any).request, null);
  w = await current(f.w.id); assert.equal(w.validation![f.proof].reanchor?.state, 'blocked'); assert.match(w.validation![f.proof].reanchor!.reasons[0], /not fully measured|matches no trusted/);
  await observe(f, A, { measurement: 'self-report' }); w = await current(f.w.id); assert.equal(w.validation![f.proof].reanchor?.state, 'blocked', 'a self-report of the right digest does not unblock');
  await observe(f, A); w = await current(f.w.id); assert.equal(w.validation![f.proof].reanchor, undefined);
  const live = await request(w.validation![f.proof].requestId!);
  // Delayed observation, no old-pass fallback: a pass undermined later stops counting, and the fresh request needs fresh execution.
  const command = await start(f, live);
  const passed: any = await validation.result(collector, report(f, command), id()); assert.equal(passed.passed, true, passed.reasons.join('; '));
  const attempt = (await request(live.id)).attempts.at(-1)!;
  await observe(f, B, { now: Date.parse(attempt.dispatchedAt), validFrom: 0, validTo: 0.001, observedAt: 0.001 });
  w = await current(f.w.id); assert.equal(currentEvidence(w, f.proof), undefined);
  const replacement = await request(w.validation![f.proof].requestId!); assert.equal(replacement.attempts.length, 0);
  const late: any = await validation.result(collector, report(f, command), id()); assert.equal(late.accepted, false, 'a late report on the superseded attempt is recorded, never accepted');
  const generic = await engine.execute({ ...collector, proofs: [f.proof] }, 'evidence', w.id, { proof: f.proof, sha, baseSha: base, policyRevision: 1, executed: 1, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 }, result: 'pass', scenarioRevision: 1, environment: f.environment.id }, id());
  assert.equal(currentEvidence(generic, f.proof), undefined, 'generic evidence cannot stand in for the pinned attempt');
  // Idempotent reschedule under a race is covered by integration:reanchor-races; here the fence itself is checked to be one row per superseded request.
  const fences = (await store.pool.query("SELECT superseded_request_id, count(*)::int AS n FROM attribution_reanchors GROUP BY superseded_request_id")).rows; assert.ok(fences.every(row => row.n === 1), "fences.every(row => row.n === 1)");
  // Paid-run avoidance and cost are accounted; signature invalidation and regeneration are ledgered.
  assert.ok((await records(f.w.id, 'paid-run-avoided')).length >= 1, "(await records(f.w.id, 'paid-run-avoided')).length >= 1"); assert.ok((await records(f.w.id, 'signature-regenerated')).length >= 2, "(await records(f.w.id, 'signature-regenerated')).length >= 2");
  // A client-supplied SHA is never target proof, whoever supplies it, and the refusal is ledgered.
  const fresh = await start(f, replacement);
  for (const claim of [{ target: { sourceSha: sha } }, { sourceSha: sha }, { target: { sha } }, { commitSha: sha }]) {
    const claimed = { ...report(f, fresh), ...claim, target: { ...report(f, fresh).target, ...((claim as any).target ?? {}) } };
    await assert.rejects(validation.result(collector, claimed, id()), /not target proof/);
    assert.equal((await api('/api/validation/result', tokens.collector, { method: 'POST', body: JSON.stringify(claimed) })).status, 400);
  }
  assert.ok((await records(f.w.id, 'unsupported-claim-refused')).filter(r => r.details.claim === 'client-supplied-sha').length >= 4, "(await records(f.w.id, 'unsupported-claim-refused')).filter(r => r.details.claim === 'client-supplied-sha').length >= 4");
  await assert.rejects(validation.result(worker, report(f, fresh), id()), /trusted collector/);
  const unmeasured: any = await validation.result(collector, report(f, fresh, B, { measurement: 'unknown' }), id()); assert.equal(unmeasured.passed, false);
  assert.ok((await records(f.w.id, 'unsupported-claim-refused')).some(r => r.details.claim === 'collector-target' && /without a measured identity/.test(r.details.reason)), "(await records(f.w.id, 'unsupported-claim-refused')).some(r => r.details.claim === 'collector-target' && /without a meas");
  // No client-controlled lifecycle-state endpoint exists, and the ledger refuses edits.
  for (const path of ['/api/attribution/reanchor', '/api/attribution/state', '/api/attribution/records', `/api/attribution/work/${f.w.id}`]) assert.equal((await api(path, tokens.operator, { method: 'POST', body: '{"state":"rescheduled"}' })).status, 404, path);
  await assert.rejects(store.pool.query("UPDATE attribution_records SET kind='rescheduled' WHERE kind='reanchor-blocked'"), /append-only/);
  await assert.rejects(store.pool.query('DELETE FROM attribution_reanchors'), /append-only/);
  assert.equal((await api('/api/analytics/attribution?window=7', tokens.implementer)).status, 404);
  assert.equal((await localRequest(url, '/api/analytics/attribution?window=7', { headers: { Host: 'graphyard.example' } })).status, 401);
  await cleanup(f);
});
