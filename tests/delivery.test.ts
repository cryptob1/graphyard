import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { Validation } from '../src/validation.js';
import { Delivery, commonInterval, mergeSegments, serviceState, type EnvironmentDelivery, type Release } from '../src/delivery.js';
import { server } from '../src/server.js';
import { queueRef, type QueueSpeculation } from '../src/merge-queue.js';
import type { Principal, Work, Observation } from '../src/model.js';

/**
 * D3 acceptance checks from docs/turnkey-delivery-roadmap.md, one test per check, named
 * "D3-N". Every test runs against a disposable real Postgres database; nothing here talks
 * to a deployment provider, because what is under test is what Graphyard does with what an
 * authenticated adapter reports — and what it refuses to do without one.
 */
const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const coordinator: Principal = { id: 'master', role: 'coordinator' };
const ci: Principal = { id: 'ci', role: 'producer', proofs: ['integration:claim-safety'] };
const builder: Principal = { id: 'builder', role: 'producer' };
const observer: Principal = { id: 'observer', role: 'producer' };
const apiObserver: Principal = { id: 'api-observer', role: 'producer' };
const promoter: Principal = { id: 'promoter', role: 'producer' };
const reader: Principal = { id: 'auditor', role: 'reader' };
const principals = [operator, worker, coordinator, ci, builder, observer, apiObserver, promoter, reader];
const head = 'a'.repeat(40), base = 'b'.repeat(40);
const digestOf = (label: string) => `sha256:${label.repeat(64).slice(0, 64)}`;
const expected = { api: digestOf('1'), web: digestOf('2') }, wrong = digestOf('f'), inputs = digestOf('d');
let pg: EmbeddedPostgres, store: Store, engine: Engine, validation: Validation, delivery: Delivery;
let http: ReturnType<typeof server>, url: string;
let serial = 0;
before(async () => {
  const port = Number(process.env.GRAPHYARD_DELIVERY_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 3);
  pg = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-delivery-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('delivery_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/delivery_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'test/repository'); validation = new Validation(engine, principals, 'test/repository'); delivery = new Delivery(validation);
  http = server(engine, principals.map(p => ({ ...p, token: `${p.id}-token-${'x'.repeat(32)}` })));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (pg) await pg.stop(); });
const id = () => randomUUID();
const at = (offsetSeconds: number, from = Date.now()) => new Date(from + offsetSeconds * 1000).toISOString();
async function reload(w: Work) { return (await store.list()).find(item => item.id === w.id)!; }
async function state(environmentId: string): Promise<EnvironmentDelivery> { return (await delivery.status()).environments.find(e => e.environmentId === environmentId)!; }
async function events(kind: string, workId?: string) { return (await store.events(workId)).filter(e => e.kind === kind); }

/** Delivered work the way production reaches it: an authorized, verified, independently observed merge. */
async function delivered(mergeSha = 'e'.repeat(40)) {
  let w = await engine.execute(operator, 'create', null, { title: `Delivered change ${++serial}`, criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:claim-safety'] }] }, id());
  w = await engine.execute(operator, 'ready', w.id, {}, id()); w = await engine.execute(worker, 'claim', w.id, {}, id());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/delivery-${serial}`, branch: `graphyard/delivery-${serial}` }, id());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: serial }, id());
  await store.pool.query("UPDATE work_items SET document=document-'queue' WHERE id<>$1 AND document->>'stage'<>'done'", [w.id]);
  const observation = (): Observation => ({ clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr: serial, branch: `graphyard/delivery-${serial}`, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'reviewer', sha: head, state: 'APPROVED' }],
    protected: true, mergeable: true, merged: false, mergeSha: null, files: [], at: new Date().toISOString() });
  w = await engine.observe(w.id, w.revision, observation());
  w = await engine.execute(ci, 'evidence', w.id, { proof: 'integration:claim-safety', sha: head, baseSha: base, policyRevision: 1, result: 'pass', executed: 5, skipped: 0 }, id());
  const speculation: QueueSpeculation = { ref: queueRef(w.key), tip: head, base, baseTree: '7e'.repeat(20), predecessors: [], policyRevision: w.policyRevision, publishedAt: new Date().toISOString() };
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{queue,speculation}',$2::jsonb) WHERE id=$1", [w.id, JSON.stringify(speculation)]);
  w = await engine.observe(w.id, (await reload(w)).revision, observation());
  const granted = await engine.acquireMerge(coordinator, w.id, { expectedRevision: w.revision, sha: head, baseSha: base, policyRevision: w.policyRevision }, id());
  const verified = await engine.verifyMerge(coordinator, w.id, { executionId: granted.execution.id }, { ...observation(), prState: 'open', draft: false }, id());
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  w = await engine.observe(w.id, verified.revision, { ...observation(), merged: true, mergedAt, mergeSha });
  assert.equal(w.stage, 'done'); assert.equal(w.delivery?.mergeSha, mergeSha);
  return w;
}
/** An environment with two services, a builder, a whole-environment observer, an api-only observer and a promoter. */
async function environment(policy?: { freshnessSeconds: number; approvalRequired: boolean }) {
  const n = ++serial, env = { id: `production-${n}`, revision: 1 };
  await validation.define(operator, { kind: 'environment', id: env.id, expectedRevision: 0, repository: 'test/repository', url: 'https://production.example.test', instance: `instance-${n}`, immutable: true, services: ['api', 'web'], resources: [`account-${n}`], ...(policy ? { delivery: policy } : {}) }, id());
  const registrations = { builder: { id: `builder-${n}`, revision: 1 }, observer: { id: `observer-${n}`, revision: 1 }, apiObserver: { id: `api-observer-${n}`, revision: 1 }, promoter: { id: `promoter-${n}`, revision: 1 } };
  await validation.define(operator, { kind: 'registration', id: registrations.builder.id, expectedRevision: 0, principalId: builder.id, role: 'builder', environment: env, adapterVersion: 'test-v1', proofs: [], enabled: true }, id());
  await validation.define(operator, { kind: 'registration', id: registrations.observer.id, expectedRevision: 0, principalId: observer.id, role: 'observer', environment: env, adapterVersion: 'test-v1', proofs: [], enabled: true, services: ['api', 'web'] }, id());
  await validation.define(operator, { kind: 'registration', id: registrations.apiObserver.id, expectedRevision: 0, principalId: apiObserver.id, role: 'observer', environment: env, adapterVersion: 'test-v1', proofs: [], enabled: true, services: ['api'] }, id());
  await validation.define(operator, { kind: 'registration', id: registrations.promoter.id, expectedRevision: 0, principalId: promoter.id, role: 'promoter', environment: env, adapterVersion: 'test-v1', proofs: [], enabled: true, services: ['api', 'web'] }, id());
  const lease = await delivery.lease(observer, { registration: registrations.observer });
  return { n, env, registrations, epoch: lease.epoch };
}
type Env = Awaited<ReturnType<typeof environment>>;
async function release(f: Env, members: { workId: string; mergeSha: string; included?: boolean }[] = [], overrides: Record<string, unknown> = {}, releaseId = `release-${f.n}-${++serial}`) {
  const build: any = await delivery.attestBuild(builder, { registration: f.registrations.builder, sourceSha: head, buildInputsDigest: inputs, artifacts: [{ service: 'api', digest: expected.api }, { service: 'web', digest: expected.web }], provenanceUrl: 'https://ci.example.test/build/1' }, id());
  return delivery.createRelease(operator, { id: releaseId, expectedRevision: 0, environment: f.env, sourceSha: head, buildId: build.id, manifest: build.artifacts, members: members.map(m => ({ included: true, ...m })), ...overrides }, id()) as Promise<Release>;
}
async function select(f: Env, r: Release, expectedGeneration = 0) {
  const approval = await delivery.approve(operator, { release: { id: r.id, revision: r.revision }, environment: f.env }, id());
  return delivery.select(operator, { environment: f.env, release: { id: r.id, revision: r.revision }, expectedGeneration, approvalId: approval.id }, id());
}
/** A whole-environment provider snapshot that matches the expected manifest unless overridden. */
function snapshot(f: Env, generation: number, overrides: Record<string, unknown> = {}, services: Record<string, unknown>[] = [
  { service: 'api', complete: true, instances: [{ instance: 'api-1', digest: expected.api, measurement: 'provider', healthy: true }], deployment: { id: 'dep-api', status: 'success', deployedAt: at(-120) } },
  { service: 'web', complete: true, instances: [{ instance: 'web-1', digest: expected.web, measurement: 'provider', healthy: true }], deployment: { id: 'dep-web', status: 'success', deployedAt: at(-120) } },
]) {
  return { registration: f.registrations.observer, epoch: f.epoch, environment: f.env, expectedGeneration: generation, snapshotId: `snapshot-${++serial}`, observedAt: at(0), validFrom: at(-60), validTo: at(0), services, ...overrides };
}
const service = (name: 'api' | 'web', instances: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({ service: name, complete: true, instances, ...extra });
const instance = (name: string, digest: string | null, measurement = 'provider', healthy = true) => ({ instance: name, digest, measurement, healthy });
async function observe(input: unknown, actor: Principal = observer) { return delivery.observe(actor, input, id()); }

test('interval arithmetic merges touching coverage and only overlapping coverage is common', () => {
  const t = (s: number) => new Date(s * 1000).toISOString();
  assert.deepEqual(mergeSegments([{ from: t(10), to: t(20) }, { from: t(0), to: t(10) }, { from: t(30), to: t(40) }]), [{ from: t(0), to: t(20) }, { from: t(30), to: t(40) }]);
  assert.equal(commonInterval([[{ from: t(0), to: t(10) }], [{ from: t(12), to: t(20) }]]), null, 'A before B is never common');
  assert.deepEqual(commonInterval([[{ from: t(0), to: t(10) }, { from: t(30), to: t(50) }], [{ from: t(5), to: t(40) }]]), { from: t(30), to: t(40) }, 'the latest common range wins');
  assert.deepEqual(commonInterval([[{ from: t(5), to: t(5) }], [{ from: t(0), to: t(10) }]]), { from: t(5), to: t(5) }, 'an atomic snapshot inside another coverage is a common instant');
  assert.equal(serviceState({ service: 'api', complete: true, instances: [instance('a', expected.api, 'self-report')] } as any, expected.api).state, 'unknown');
  assert.equal(serviceState({ service: 'api', complete: true, instances: [instance('a', expected.api), instance('b', wrong)] } as any, expected.api).state, 'mismatched');
  assert.equal(serviceState({ service: 'api', complete: false, instances: [instance('a', expected.api)] } as any, expected.api).state, 'incomplete');
});

test('D3-1 a mixed-version deployment does not pass expected-service verification', async () => {
  const f = await environment(); const r = await release(f); await select(f, r);
  await observe(snapshot(f, 1, {}, [service('api', [instance('api-1', expected.api)]), service('web', [instance('web-1', expected.web), instance('web-2', wrong)])]));
  await delivery.sweep();
  const s = await state(f.env.id);
  assert.equal(s.verification.status, 'mismatched'); assert.equal(s.verification.verifiedAt, null);
  assert.match(s.verification.reasons.join('\n'), /web-2 of web runs sha256:f+ instead of/);
  assert.equal(s.coverage.api.latest?.state, 'matched'); assert.equal(s.coverage.web.latest?.state, 'mismatched');
  // A rolling deployment that later converges verifies from the converged observation on.
  await observe(snapshot(f, 1)); await delivery.sweep();
  assert.equal((await state(f.env.id)).verification.status, 'verified');
});

test('D3-2 staggered, missing, gapped and stale observations refuse; a common interval over the whole manifest verifies', async () => {
  const f = await environment({ freshnessSeconds: 120, approvalRequired: true }); const r = await release(f); await select(f, r);
  // Only api observed: web has no observation at all.
  await observe(snapshot(f, 1, { validFrom: at(-300), validTo: at(-200), observedAt: at(-200) }, [service('api', [instance('api-1', expected.api)])])); await delivery.sweep();
  assert.equal((await state(f.env.id)).verification.status, 'unobserved');
  // A matched only before B matched: api [-300,-200], web [-190,-100]. Never simultaneous.
  await observe(snapshot(f, 1, { validFrom: at(-190), validTo: at(-100), observedAt: at(-100) }, [service('web', [instance('web-1', expected.web)])])); await delivery.sweep();
  let s = await state(f.env.id); assert.equal(s.verification.status, 'no-common-interval'); assert.equal(s.verification.interval, null);
  // A missing instance listing (provider page truncated) is incomplete, not a pass.
  await observe(snapshot(f, 1, { validFrom: at(-100), validTo: at(-90), observedAt: at(-90) }, [service('api', [instance('api-1', expected.api)], { complete: false }), service('web', [instance('web-1', expected.web)])])); await delivery.sweep();
  s = await state(f.env.id); assert.equal(s.verification.status, 'incomplete'); assert.match(s.verification.reasons.join(), /listing for api is incomplete/);
  // A common interval that exists but ended beyond the freshness bound is stale.
  const g = await environment({ freshnessSeconds: 120, approvalRequired: true }); await select(g, await release(g));
  await observe(snapshot(g, 1, { validFrom: at(-400), validTo: at(-300), observedAt: at(-300) })); await delivery.sweep();
  const stale = await state(g.env.id); assert.equal(stale.verification.status, 'stale'); assert.equal(stale.verification.verifiedAt, null);
  assert.deepEqual(stale.verification.interval && [stale.verification.interval.from.slice(0, 16), stale.verification.interval.to.slice(0, 16)], [at(-400).slice(0, 16), at(-300).slice(0, 16)]);
  // Overlapping, fresh coverage of both services verifies and records the common interval.
  await observe(snapshot(f, 1, { validFrom: at(-30), validTo: at(0), observedAt: at(0) }, [service('api', [instance('api-1', expected.api)])]));
  await observe(snapshot(f, 1, { validFrom: at(-20), validTo: at(-5), observedAt: at(-5) }, [service('web', [instance('web-1', expected.web)])])); await delivery.sweep();
  s = await state(f.env.id); assert.equal(s.verification.status, 'verified'); assert.ok(s.verification.verifiedAt);
  assert.ok(s.verification.interval && Date.parse(s.verification.interval.from) >= Date.now() - 21_000 && Date.parse(s.verification.interval.to) <= Date.now() - 4_000, 'the interval is the intersection, not either observation');
  assert.equal(s.history.at(-1)?.outcome, 'verified');
});

test('D3-3 wrong-scope, superseded-lease, stale-generation and webhook inputs never change runtime state; duplicates are idempotent', async () => {
  const f = await environment(); const r = await release(f); await select(f, r);
  const apiLease = await delivery.lease(apiObserver, { registration: f.registrations.apiObserver });
  // Wrong scope: the api observer reports web. Authenticated, so retained as non-authoritative history.
  const outside: any = await observe({ ...snapshot(f, 1), registration: f.registrations.apiObserver, epoch: apiLease.epoch }, apiObserver);
  assert.equal(outside.authoritative, false); assert.match(outside.rejection.join(), /outside this observer's scope: web/);
  // Wrong principal for the registration is refused outright.
  await assert.rejects(observe(snapshot(f, 1), apiObserver), /Wrong observer principal/);
  await assert.rejects(observe(snapshot(f, 1), worker), /observer credential/);
  // Superseded lease epoch: a new acquisition supersedes the old one.
  const superseded = f.epoch; f.epoch = (await delivery.lease(observer, { registration: f.registrations.observer })).epoch; assert.notEqual(f.epoch, superseded);
  const stale: any = await observe(snapshot(f, 1, { epoch: superseded })); assert.equal(stale.authoritative, false); assert.match(stale.rejection.join(), /lease epoch/);
  // Stale generation.
  const old: any = await observe(snapshot(f, 0)); assert.equal(old.authoritative, false); assert.match(old.rejection.join(), /generation 0 is superseded by 1/);
  // A raw webhook is recorded and changes nothing.
  const notified = await delivery.notify(reader, { environment: f.env.id, provider: 'railway', payload: { status: 'SUCCESS', deployment: 'dep-web', image: expected.web } });
  assert.equal(notified.authoritative, false);
  await delivery.sweep();
  let s = await state(f.env.id); assert.equal(s.verification.status, 'unobserved'); assert.deepEqual(s.coverage, {}); assert.ok(s.lastNotification);
  assert.equal((await events('delivery.observation-rejected')).length >= 3, true);
  // Duplicate snapshot: the original receipt, not a refreshed observation time.
  const input = snapshot(f, 1); const first: any = await observe(input); await delay(5);
  const again: any = await observe({ ...input, observedAt: at(0), validTo: at(0) });
  assert.equal(again.duplicate, true); assert.equal(again.id, first.id); assert.equal(again.receivedAt, first.receivedAt);
  const key = id(); const replayed = await delivery.observe(observer, snapshot(f, 1), key); assert.deepEqual(await delivery.observe(observer, snapshot(f, 1, { snapshotId: 'different' }), key).catch(e => e.message), 'Idempotency key reused with different input');
  assert.deepEqual(await delivery.observe(observer, JSON.parse(JSON.stringify(input)), key).catch(e => e.message), 'Idempotency key reused with different input');
  void replayed;
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM delivery_observations WHERE registration_id=$1 AND snapshot_id=$2', [f.registrations.observer.id, input.snapshotId])).rows[0].n, 1);
  await delivery.sweep(); s = await state(f.env.id); assert.equal(s.verification.status, 'verified');
  assert.equal((await events('delivery.verified')).filter(e => e.payload.environment === f.env.id).length, 1, 'duplicates do not verify twice');
});

test('D3-4 workers and observers cannot define or select releases; generation fencing, stale delegates and changed manifests refuse', async () => {
  const f = await environment(); const r = await release(f);
  const build: any = await delivery.attestBuild(builder, { registration: f.registrations.builder, sourceSha: head, buildInputsDigest: inputs, artifacts: r.manifest, provenanceUrl: 'https://ci.example.test/build/2' }, id());
  const definition = { id: `unauthorized-${f.n}`, expectedRevision: 0, environment: f.env, sourceSha: head, buildId: build.id, manifest: r.manifest, members: [] };
  await assert.rejects(delivery.createRelease(worker, definition, id()), /promotion principal/);
  await assert.rejects(delivery.createRelease(observer, { ...definition, delegate: { registration: f.registrations.observer, epoch: f.epoch } }, id()), /not authorized|Registration revoked/);
  await assert.rejects(delivery.attestBuild(worker, {}, id()), /build producer/);
  await assert.rejects(delivery.attestBuild(observer, { registration: f.registrations.builder, sourceSha: head, buildInputsDigest: inputs, artifacts: r.manifest, provenanceUrl: 'https://ci.example.test/build/3' }, id()), /Wrong build principal/);
  const approval = await delivery.approve(operator, { release: { id: r.id, revision: 1 }, environment: f.env }, id());
  await assert.rejects(delivery.approve(promoter, { release: { id: r.id, revision: 1 }, environment: f.env }, id()), /Operator/);
  const selection = { environment: f.env, release: { id: r.id, revision: 1 }, expectedGeneration: 0, approvalId: approval.id };
  await assert.rejects(delivery.select(worker, selection, id()), /promotion principal/);
  await assert.rejects(delivery.select(observer, { ...selection, delegate: { registration: f.registrations.observer, epoch: f.epoch } }, id()), /not authorized|Registration revoked/);
  // Concurrent promotions fence on the expected generation: exactly one lands.
  const lease = await delivery.lease(promoter, { registration: f.registrations.promoter });
  const outcomes = await Promise.allSettled([delivery.select(operator, selection, id()), delivery.select(promoter, { ...selection, delegate: { registration: f.registrations.promoter, epoch: lease.epoch } }, id())]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1); assert.match((outcomes.find(o => o.status === 'rejected') as PromiseRejectedResult).reason.message, /generation changed/);
  assert.equal((await state(f.env.id)).generation, 1);
  // A stale delegate: its lease epoch was superseded by a fresh acquisition.
  const fresh = await delivery.lease(promoter, { registration: f.registrations.promoter }); assert.notEqual(fresh.epoch, lease.epoch);
  await assert.rejects(delivery.select(promoter, { ...selection, expectedGeneration: 1, delegate: { registration: f.registrations.promoter, epoch: lease.epoch } }, id()), /Promoter lease epoch/);
  const renewed = await delivery.lease(promoter, { registration: f.registrations.promoter, epoch: fresh.epoch }); assert.equal(renewed.epoch, fresh.epoch); assert.equal(renewed.renewed, true);
  // The approval binds release revision 1; a revised manifest is a new revision it does not cover.
  const changed: any = await delivery.attestBuild(builder, { registration: f.registrations.builder, sourceSha: head, buildInputsDigest: inputs, artifacts: [{ service: 'api', digest: wrong }, { service: 'web', digest: expected.web }], provenanceUrl: 'https://ci.example.test/build/4' }, id());
  const revised = await delivery.createRelease(promoter, { id: r.id, expectedRevision: 1, environment: f.env, sourceSha: head, buildId: changed.id, manifest: changed.artifacts, members: [], delegate: { registration: f.registrations.promoter, epoch: fresh.epoch } }, id()) as Release;
  assert.equal(revised.revision, 2); assert.notEqual(revised.manifestHash, r.manifestHash);
  await assert.rejects(delivery.select(promoter, { environment: f.env, release: { id: r.id, revision: 2 }, expectedGeneration: 1, approvalId: approval.id, delegate: { registration: f.registrations.promoter, epoch: fresh.epoch } }, id()), /Approval does not bind/);
  await assert.rejects(delivery.select(operator, { environment: f.env, release: { id: r.id, revision: 2 }, expectedGeneration: 1 }, id()), /requires an operator approval/);
  // A manifest that differs from the attested build, or omits a service, cannot become a release.
  await assert.rejects(delivery.createRelease(operator, { ...definition, id: `forged-${f.n}`, manifest: [{ service: 'api', digest: wrong }, { service: 'web', digest: expected.web }] }, id()), /differs from the attested build/);
  await assert.rejects(delivery.createRelease(operator, { ...definition, id: `forged-${f.n}`, sourceSha: 'c'.repeat(40) }, id()), /mismatched trusted build provenance/);
  // Membership must cite the merge GitHub reported for delivered work.
  const done = await delivered();
  await assert.rejects(delivery.createRelease(operator, { ...definition, id: `forged-${f.n}`, members: [{ workId: done.id, mergeSha: 'c'.repeat(40), included: true }] }, id()), /independently observed merge/);
  const open = await engine.execute(operator, 'create', null, { title: 'Open work', criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:claim-safety'] }] }, id());
  await assert.rejects(delivery.createRelease(operator, { ...definition, id: `forged-${f.n}`, members: [{ workId: open.id, mergeSha: 'e'.repeat(40), included: true }] }, id()), /delivered work/);
});

test('D3-5 a green deployment job with unknown runtime identity remains unverified', async () => {
  const f = await environment(); const r = await release(f); await select(f, r);
  await observe(snapshot(f, 1, {}, [service('api', [instance('api-1', null, 'unknown')], { deployment: { id: 'dep-api', status: 'success', deployedAt: at(-120) } }), service('web', [instance('web-1', expected.web)], { deployment: { id: 'dep-web', status: 'success', deployedAt: at(-120) } })]));
  await delivery.sweep();
  const s = await state(f.env.id); assert.equal(s.verification.status, 'unknown'); assert.equal(s.verification.verifiedAt, null);
  assert.match(s.verification.reasons.join(), /Runtime identity of instance api-1 of api is unknown/);
  // Provider-reported deployment failure is unhealthy, and a build in progress is incomplete.
  await observe(snapshot(f, 1, {}, [service('api', [instance('api-1', expected.api)], { deployment: { id: 'dep-api', status: 'failed', deployedAt: at(-60) } }), service('web', [instance('web-1', expected.web)])])); await delivery.sweep();
  assert.equal((await state(f.env.id)).verification.status, 'unhealthy');
  await observe(snapshot(f, 1, {}, [service('api', [instance('api-1', expected.api)], { deployment: { id: 'dep-api', status: 'building', deployedAt: null } }), service('web', [instance('web-1', expected.web)])])); await delivery.sweep();
  assert.equal((await state(f.env.id)).verification.status, 'incomplete');
});

test('D3-6 a wrong artifact that self-reports the expected digest cannot pass; only measured instance identity can', async () => {
  const f = await environment(); const r = await release(f); await select(f, r);
  await observe(snapshot(f, 1, {}, [service('api', [instance('api-1', expected.api, 'self-report')]), service('web', [instance('web-1', expected.web)])])); await delivery.sweep();
  let s = await state(f.env.id); assert.equal(s.verification.status, 'unknown'); assert.match(s.verification.reasons.join(), /only self-reported.*proves nothing/);
  await observe(snapshot(f, 1, {}, [service('api', [instance('api-1', expected.api, 'host-attestation')]), service('web', [instance('web-1', expected.web)])])); await delivery.sweep();
  s = await state(f.env.id); assert.equal(s.verification.status, 'verified');
});

test('D3-7 a dropped webhook is recovered by the observer sweep without manual lifecycle changes', async () => {
  const f = await environment(); const r = await release(f); await select(f, r);
  // No notification ever arrives. The adapter's periodic read reports what is running and the
  // control plane's bounded sweep verifies it: no operator command is involved.
  const before = (await store.events()).length;
  await observe(snapshot(f, 1)); await delivery.sweep();
  const s = await state(f.env.id); assert.equal(s.verification.status, 'verified'); assert.equal(s.lastNotification, undefined);
  const kinds = (await store.events()).slice(0, (await store.events()).length - before).map(e => e.kind);
  assert.deepEqual([...new Set(kinds)].sort(), ['delivery.observed', 'delivery.verified']);
  assert.ok(kinds.every(kind => !kind.startsWith('delivery.select')), 'nothing about desired state changed');
});

test('D3-8 a release containing multiple PRs attributes all applicable work once, with visible membership', async () => {
  const f = await environment(); const first = await delivered('1'.repeat(40)), second = await delivered('2'.repeat(40)), reverted = await delivered('3'.repeat(40));
  const r = await release(f, [{ workId: first.id, mergeSha: '1'.repeat(40) }, { workId: second.id, mergeSha: '2'.repeat(40) }, { workId: reverted.id, mergeSha: '3'.repeat(40), included: false }]);
  assert.deepEqual(r.members.map(m => [m.key, m.included]), [[first.key, true], [second.key, true], [reverted.key, false]]);
  assert.equal((await events('delivery.release-member', reverted.id)).length, 1, 'a reverted member is visible on its own work item');
  await select(f, r); await observe(snapshot(f, 1)); await delivery.sweep();
  for (const w of [first, second]) {
    const item = await reload(w); assert.equal(item.releaseDeliveries?.length, 1); assert.equal(item.releaseDeliveries![0].releaseId, r.id); assert.equal(item.releaseDeliveries![0].environment, f.env.id);
    assert.equal(item.stage, 'done'); assert.equal((await events('delivery.verified', w.id)).length, 1);
  }
  assert.equal((await reload(reverted)).releaseDeliveries, undefined, 'a reverted change is not attributed');
  // A later release carrying the same changes plus one more attributes only the new one.
  const third = await delivered('4'.repeat(40));
  const next = await release(f, [{ workId: first.id, mergeSha: '1'.repeat(40) }, { workId: second.id, mergeSha: '2'.repeat(40) }, { workId: third.id, mergeSha: '4'.repeat(40) }]);
  await select(f, next, 1); await observe(snapshot(f, 2)); await delivery.sweep();
  assert.equal((await state(f.env.id)).verification.status, 'verified');
  assert.equal((await reload(first)).releaseDeliveries?.length, 1); assert.equal((await reload(first)).releaseDeliveries![0].releaseId, r.id);
  assert.equal((await reload(third)).releaseDeliveries?.[0].releaseId, next.id);
  const status = await delivery.status();
  assert.deepEqual(status.releases.find(x => x.id === next.id)?.members.map(m => m.key), [first.key, second.key, third.key]);
  const history = (await state(f.env.id)).history; assert.equal(history[0].outcome, 'verified'); assert.ok(history[0].supersededAt); assert.equal(history[1].outcome, 'verified');
});

test('D3-9 a sweep interrupted at its bound resumes without silently omitting history', async () => {
  const f = await environment(); const r = await release(f); await select(f, r);
  // 24 api-only observations, then the single web observation that makes the manifest complete.
  for (let i = 0; i < 24; i++) await observe(snapshot(f, 1, { validFrom: at(-30 - i), validTo: at(-i), observedAt: at(-i) }, [service('api', [instance('api-1', expected.api)])]));
  await observe(snapshot(f, 1, { validFrom: at(-30), validTo: at(0) }, [service('web', [instance('web-1', expected.web)])]));
  const first = await delivery.sweep(10); assert.deepEqual([first.applied, first.complete], [10, false]);
  let s = await state(f.env.id); assert.equal(s.verification.status, 'unobserved'); const cursor = s.cursor;
  // "Interrupted": a different process, with its own pool, continues from the persisted cursor.
  const replicaStore = new Store(store.pool.options.connectionString!);
  try {
    const replica = new Delivery(new Validation(new Engine(replicaStore, [15368], 120, 'test/repository'), principals, 'test/repository'));
    const second = await replica.sweep(10); assert.deepEqual([second.applied, second.complete], [10, false]);
    s = await state(f.env.id); assert.equal(s.cursor, cursor + 10); assert.equal(s.verification.status, 'unobserved');
    const third = await replica.sweep(10); assert.deepEqual([third.applied, third.complete], [5, true]);
  } finally { await replicaStore.close(); }
  s = await state(f.env.id); assert.equal(s.verification.status, 'verified');
  assert.equal(s.cursor, (await store.pool.query('SELECT max(seq)::int AS seq FROM delivery_observations WHERE environment_id=$1', [f.env.id])).rows[0].seq);
  assert.equal(s.coverage.api.segments.length, 1, 'every api observation was folded into one continuous coverage');
  const idle = await delivery.sweep(10); assert.deepEqual([idle.applied, idle.complete], [0, true]);
});

test('D3-10 later failures create a visible incident without erasing evidence or rewriting the authorization', async () => {
  const f = await environment(); const w = await delivered('5'.repeat(40));
  const r = await release(f, [{ workId: w.id, mergeSha: '5'.repeat(40) }]); await select(f, r);
  await observe(snapshot(f, 1)); await delivery.sweep();
  const verified = await state(f.env.id); assert.equal(verified.verification.status, 'verified');
  await observe(snapshot(f, 1, { validFrom: at(0), validTo: at(5), observedAt: at(5) }, [service('api', [instance('api-1', wrong)]), service('web', [instance('web-1', expected.web)])])); await delivery.sweep();
  const degraded = await state(f.env.id);
  assert.equal(degraded.verification.status, 'degraded'); assert.equal(degraded.verification.verifiedAt, verified.verification.verifiedAt);
  assert.deepEqual(degraded.verification.interval, verified.verification.interval, 'the historical interval is kept');
  assert.equal(degraded.incidents.length, 1); assert.match(degraded.incidents[0].reasons.join(), /api-1 of api runs/);
  assert.equal(degraded.history.at(-1)?.outcome, 'verified');
  assert.equal((await reload(w)).releaseDeliveries?.length, 1, 'attribution is not withdrawn');
  assert.equal((await events('delivery.incident')).filter(e => e.payload.environment === f.env.id).length, 1);
  await delivery.sweep(); assert.equal((await state(f.env.id)).incidents.length, 1, 'an incident is recorded once per observation');
  // Superseding with a new release is different from the old one being unhealthy.
  const next = await release(f); await select(f, next, 1);
  const superseded = await state(f.env.id);
  assert.equal(superseded.history[0].outcome, 'verified'); assert.ok(superseded.history[0].supersededAt); assert.equal(superseded.history[1].outcome, 'selected');
  assert.equal(superseded.verification.status, 'unobserved'); assert.equal(superseded.incidents.length, 1, 'incident history survives the selection');
  const third = await release(f); await select(f, third, 2);
  assert.equal((await state(f.env.id)).history[1].outcome, 'skipped', 'a never-verified release that was superseded is skipped, not failed');
});

test('deployment identity registrations are service-scoped and carry no execution or proof authority', async () => {
  const f = await environment();
  const definition = { kind: 'registration', id: `bad-${f.n}`, expectedRevision: 0, principalId: observer.id, role: 'observer', environment: f.env, adapterVersion: 'test-v1', proofs: [], enabled: true };
  await assert.rejects(validation.define(operator, { ...definition, services: ['database'] }, id()), /services of their environment/);
  await assert.rejects(validation.define(operator, definition, id()), /services of their environment/);
  await assert.rejects(validation.define(operator, { ...definition, services: ['api'], proofs: ['e2e:x'] }, id()), /no proof scope/);
  await assert.rejects(validation.define(operator, { ...definition, services: ['api'], executionNetwork: 'gy' }, id()), /Only runner registrations/);
  await assert.rejects(validation.define(operator, { ...definition, role: 'builder', services: ['api'] }, id()), /Only observer and promoter/);
  await assert.rejects(validation.define(operator, { ...definition, services: ['api'], principalId: worker.id }, id()), /appropriate separate role/);
  await assert.rejects(delivery.lease(observer, { registration: f.registrations.builder }), /not an enabled deployment identity/);
  await assert.rejects(delivery.lease(observer, { registration: f.registrations.apiObserver }), /not an enabled deployment identity/);
  await assert.rejects(delivery.lease(worker, { registration: f.registrations.observer }), /deployment identity credential/);
  // Revoking the registration supersedes its observation authority: later reports are non-authoritative.
  const r = await release(f); await select(f, r);
  await validation.define(operator, { kind: 'registration', id: f.registrations.observer.id, expectedRevision: 1, principalId: observer.id, role: 'observer', environment: f.env, adapterVersion: 'test-v1', proofs: [], enabled: false, services: ['api', 'web'] }, id());
  const late: any = await observe(snapshot(f, 1)); assert.equal(late.authoritative, false); assert.match(late.rejection.join(), /revoked or superseded/);
  await delivery.sweep(); assert.equal((await state(f.env.id)).verification.status, 'unobserved');
});

test('HTTP delivery routes derive authority from the credential', async () => {
  const f = await environment(); const r = await release(f); await select(f, r);
  const call = async (path: string, actor: Principal | null, data?: unknown) => {
    const response = await fetch(`${url}/api/${path}`, { method: data === undefined ? 'GET' : 'POST', headers: { ...(actor ? { Authorization: `Bearer ${actor.id}-token-${'x'.repeat(32)}` } : {}), 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await call('delivery', null)).status, 401);
  const status = await call('delivery', reader); assert.equal(status.status, 200); assert.ok(status.body.environments.some((e: EnvironmentDelivery) => e.environmentId === f.env.id)); assert.ok(status.body.releases.some((x: Release) => x.id === r.id));
  assert.equal((await call('delivery/release', worker, {})).status, 400);
  assert.equal((await call('delivery/select', worker, { environment: f.env, release: { id: r.id, revision: 1 }, expectedGeneration: 1 })).status, 403);
  assert.equal((await call('delivery/sweep', worker, {})).status, 403);
  assert.equal((await call('delivery/observe', worker, snapshot(f, 1))).status, 403);
  const observed = await call('delivery/observe', observer, snapshot(f, 1)); assert.equal(observed.status, 200); assert.equal(observed.body.authoritative, true);
  const swept = await call('delivery/sweep', operator, {}); assert.equal(swept.status, 200); assert.ok(swept.body.applied >= 1);
  const page = await call(`delivery/observations?environment=${f.env.id}`, reader); assert.equal(page.status, 200); assert.equal(page.body.observations.length, 1); assert.equal(page.body.nextCursor, null);
  assert.equal((await call('delivery/notify', worker, { environment: f.env.id, provider: 'railway' })).status, 403);
  assert.equal((await call('delivery/notify', reader, { environment: f.env.id, provider: 'railway' })).status, 200);
  assert.equal((await call('delivery/notify', reader, { environment: 'nowhere', provider: 'railway' })).status, 404);
  assert.equal((await state(f.env.id)).verification.status, 'verified');
});
