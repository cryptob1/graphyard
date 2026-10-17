import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { Validation } from '../src/validation.js';
import { readFile } from 'node:fs/promises';
import { Delivery } from '../src/delivery.js';
import { server } from '../src/server.js';
import { deliveryOutcome, deliveryLabel, shortShas } from '../src/model/format.js';
import type { Principal, Work, Observation } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { recordLegacyMerger } from './helpers/legacy-merger.js';

/**
 * GY-1861: a producer records a deployment observation by the commit an environment serves, and
 * every delivered item whose merge that commit contains moves from awaiting deployment to deployed.
 * The digest-based observe path is unchanged.
 */
const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const ci: Principal = { id: 'ci', role: 'producer', proofs: ['integration:claim-safety'] };
const observer: Principal = { id: 'observer', role: 'producer' };
const reader: Principal = { id: 'auditor', role: 'reader' };
const principals = [operator, worker, ci, observer, reader];
const token = (p: Principal) => `${p.id}-token-${'x'.repeat(32)}`;
const head = 'a'.repeat(40), base = 'b'.repeat(40);
const digestOf = (label: string) => `sha256:${label.repeat(64).slice(0, 64)}`;
let pg: EmbeddedPostgres, store: Store, engine: Engine, validation: Validation, delivery: Delivery;
let http: ReturnType<typeof server>, url: string;
let serial = 0;
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1861;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('delivery-observe-sha'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('observe_sha_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/observe_sha_test`); await store.init(); await recordLegacyMerger(store);
  engine = new Engine(store, [15368], 120, 'test/repository'); validation = new Validation(engine, principals, 'test/repository'); delivery = new Delivery(validation);
  http = server(engine, principals.map(p => ({ ...p, token: token(p) })));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (pg) await pg.stop(); });
const id = () => randomUUID();
const reload = async (w: Work) => (await engine.store.workItem(w.id))!;
const sha = (label: string) => label.repeat(40).slice(0, 40);
const post = (actor: Principal, path: string, body: unknown, key = id()) => fetch(`${url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token(actor)}`, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });
const observation = (observed: string, overrides: Record<string, unknown> = {}) => ({ environment: 'production', sha: observed, services: ['web'], observedAt: new Date().toISOString(), ...overrides });
/** Smoke-required policy, so the label names how far production has carried the merge. */
const smoked = (w: Work): Work => ({ ...w, policy: { ...w.policy, deploySmoke: true } });

/** Delivered work the way production reaches it: an authorized, verified, independently observed merge. */
async function delivered(mergeSha: string) {
  let w = await engine.execute(operator, 'create', null, { title: `Delivered change ${++serial}`, criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:claim-safety'] }] }, id());
  w = await engine.execute(operator, 'ready', w.id, {}, id()); w = await engine.execute(worker, 'claim', w.id, {}, id());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/observe-sha-${serial}`, branch: `graphyard/observe-sha-${serial}` }, id());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: serial }, id());
  const observed = (): Observation => ({ clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr: serial, branch: `graphyard/observe-sha-${serial}`, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'reviewer', sha: head, state: 'APPROVED' }],
    protected: true, mergeable: true, merged: false, mergeSha: null, files: [], scopeFiles: [], at: new Date().toISOString() });
  w = await engine.observe(w.id, w.revision, observed());
  w = await engine.execute(ci, 'evidence', w.id, { proof: 'integration:claim-safety', sha: head, baseSha: base, policyRevision: 1, result: 'pass', executed: 5, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } }, id());
  w = await engine.observe(w.id, (await reload(w)).revision, observed());
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  w = await engine.observe(w.id, (await reload(w)).revision, { ...observed(), merged: true, mergedAt, mergeSha });
  assert.equal(w.stage, 'done'); assert.equal(w.delivery?.mergeSha, mergeSha);
  return w;
}

test('unit:sha-observation-marks-deployed — a producer sha observation is idempotent and marks deployed exactly the delivered items it contains', async () => {
  const exact = await delivered(sha('1')), ancestor = await delivered(sha('2')), elsewhere = await delivered(sha('3'));
  const served = sha('4');

  // Every non-producer credential is refused, and nothing is recorded or marked.
  for (const actor of [reader, worker, operator]) {
    const refused = await post(actor, '/api/delivery/observe-sha', observation(served));
    assert.equal(refused.status, 403, `${actor.role} is refused`);
    assert.match(await refused.text(), /A producer credential is required to record a deployment observation by commit/);
  }
  assert.equal((await store.pool.query(`SELECT count(*)::int AS n FROM events WHERE kind='delivery.sha-observed'`)).rows[0].n, 0);

  // Over HTTP with no GitHub configured, containment is equality alone: only the exact merge is marked.
  const response = await post(observer, '/api/delivery/observe-sha', observation(exact.delivery!.mergeSha));
  assert.equal(response.status, 200, await response.clone().text());
  const exactResult = await response.json();
  assert.deepEqual(exactResult.deployed, [exact.key]);
  assert.equal((await reload(exact)).delivery!.deployment!.covers, 'exact');
  assert.equal((await reload(ancestor)).delivery!.deployment, undefined, 'an unconfirmed ancestry is left awaiting deployment');

  // A producer observation of a descendant marks the items it contains and only those.
  const contains = async (merge: string, descendant: string) => descendant === served && merge === ancestor.delivery!.mergeSha;
  const input = observation(served), key = id();
  const result = await delivery.observeSha(observer, input, key, contains);
  assert.equal(result.duplicate, false);
  assert.deepEqual(result.deployed, [ancestor.key]);
  assert.ok(result.awaiting.some(row => row.key === elsewhere.key && /does not contain merge/.test(row.reason)), JSON.stringify(result.awaiting));
  const marked = (await reload(ancestor)).delivery!.deployment!;
  assert.deepEqual({ sha: marked.sha, mergeSha: marked.mergeSha, covers: marked.covers, observer: marked.observer, observedAt: marked.observedAt },
    { sha: served, mergeSha: ancestor.delivery!.mergeSha, covers: 'descendant', observer: observer.id, observedAt: new Date(input.observedAt).toISOString() });
  assert.equal((await reload(elsewhere)).delivery!.deployment, undefined, 'an item the observed sha does not contain stays awaiting deployment');
  assert.equal((await reload(exact)).delivery!.deployment!.sha, exact.delivery!.mergeSha, 'an already recorded deployment is never moved');

  // Idempotent: the same key replays its result, another key for the same environment and sha returns the one recorded observation.
  assert.deepEqual(await delivery.observeSha(observer, input, key, contains), result);
  await assert.rejects(delivery.observeSha(observer, observation(served, { services: ['api'] }), key, contains), /Idempotency key reused with different input/);
  const repeat = await delivery.observeSha(observer, observation(served, { observedAt: new Date(Date.now() - 1000).toISOString() }), id(), contains);
  assert.equal(repeat.duplicate, true); assert.equal(repeat.id, result.id); assert.equal(repeat.observedAt, result.observedAt);
  assert.deepEqual(repeat.deployed, []);
  assert.equal((await store.pool.query(`SELECT count(*)::int AS n FROM events WHERE kind='delivery.sha-observed' AND payload->>'sha'=$1`, [served])).rows[0].n, 1);
  assert.equal((await reload(ancestor)).delivery!.deployment!.at, marked.at, 'a repeat does not refresh the record');

  // The documented request is one the schema accepts.
  const guide = await readFile(new URL('../docs/delivery.md', import.meta.url), 'utf8');
  const documented = [...guide.matchAll(/```json\n([\s\S]*?)```/g)].map(match => JSON.parse(match[1])).filter(block => 'sha' in block && 'environment' in block && !('snapshotId' in block));
  // Imported where used, so the file still loads (and its cases fail) against a base without the schema.
  const { shaObservationSchema } = await import('../src/delivery.js') as any;
  assert.equal(documented.length, 1); shaObservationSchema.parse(documented[0]);
});

test('unit:sha-observation-completion-states — a sha observation gives the deployed label and a digest observe behaves as before', async () => {
  const w = await delivered(sha('5')), untouched = await delivered(sha('6'));
  assert.equal(deliveryOutcome(smoked(w)), deliveryLabel['awaiting-deployment']);

  // Digest-based observe: unchanged, it records an observation and marks no delivered item deployed.
  const env = { id: 'digest-env', revision: 1 };
  await validation.define(operator, { kind: 'environment', id: env.id, expectedRevision: 0, repository: 'test/repository', url: 'https://production.example.test', instance: 'instance-digest', immutable: true, services: ['api'], resources: ['account-digest'] }, id());
  const registration = { id: 'digest-observer', revision: 1 };
  await validation.define(operator, { kind: 'registration', id: registration.id, expectedRevision: 0, principalId: observer.id, role: 'observer', environment: env, adapterVersion: 'test-v1', proofs: [], enabled: true, services: ['api'] }, id());
  const { epoch } = await delivery.lease(observer, { registration });
  const now = Date.now(), at = (s: number) => new Date(now + s * 1000).toISOString();
  const digestInput = { registration, epoch, environment: env, expectedGeneration: 0, snapshotId: 'digest-snapshot-1', observedAt: at(0), validFrom: at(-60), validTo: at(0),
    services: [{ service: 'api', complete: true, instances: [{ instance: 'api-1', digest: digestOf('1'), measurement: 'provider', healthy: true }] }] };
  await assert.rejects(delivery.observe(reader, digestInput, id()), /A deployment observer credential is required/);
  const digest = await delivery.observe(observer, digestInput, id());
  assert.equal(digest.duplicate, false);
  assert.equal((await delivery.observe(observer, digestInput, id())).duplicate, true, 'a repeated snapshot is still a duplicate');
  assert.equal((await delivery.observations(env.id)).observations.length, 1);
  assert.equal((await reload(w)).delivery!.deployment, undefined);
  assert.equal(deliveryOutcome(smoked(await reload(w))), deliveryLabel['awaiting-deployment'], 'the digest path moves no completion state');

  // The sha observation marks it deployed: the deployed label, naming the serving release.
  const result = await delivery.observeSha(observer, observation(w.delivery!.mergeSha), id());
  assert.deepEqual(result.deployed, [w.key]);
  const after = await reload(w);
  assert.equal(deliveryOutcome(smoked(after)), `${deliveryLabel['awaiting-smoke']} — release ${shortShas(w.delivery!.mergeSha)} serving it`);
  assert.equal(deliveryLabel['awaiting-smoke'], 'Deployed, awaiting verification');
  assert.equal(deliveryOutcome(smoked(await reload(untouched))), deliveryLabel['awaiting-deployment'], 'an item the sha does not contain keeps its label');
});
