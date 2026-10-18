import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
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
import { deliverThroughLedger } from './helpers/ledger-delivery.js';

/**
 * GY-1861: a producer records a deployment observation by the commit production serves, and
 * every delivered item whose merge that commit contains moves from awaiting deployment to deployed.
 * It needs production at its current revision and every one of its services; the digest-based
 * observe path is unchanged.
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
const production = { id: 'production', revision: 1 }, uat = { id: 'uat', revision: 1 };
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1861;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('delivery-observe-sha'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('observe_sha_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/observe_sha_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'test/repository'); validation = new Validation(engine, principals, 'test/repository'); delivery = new Delivery(validation);
  http = server(engine, principals.map(p => ({ ...p, token: token(p) })));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
  for (const [env, services] of [[production, ['api', 'web']], [uat, ['api', 'web']]] as const)
    await validation.define(operator, { kind: 'environment', id: env.id, expectedRevision: 0, repository: 'test/repository', url: `https://${env.id}.example.test`, instance: `instance-${env.id}`, immutable: true, services: [...services], resources: [`account-${env.id}`] }, id());
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (pg) await pg.stop(); });
const id = () => randomUUID();
const reload = async (w: Work) => (await engine.store.workItem(w.id))!;
const sha = (label: string) => label.repeat(40).slice(0, 40);
const post = (actor: Principal, path: string, body: unknown, key = id()) => fetch(`${url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token(actor)}`, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });
const observation = (observed: string, overrides: Record<string, unknown> = {}) => ({ environment: production, sha: observed, services: ['api', 'web'], observedAt: new Date().toISOString(), ...overrides });
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
  // GY-2010: the merge writer's ledger delivers it, as production does; no GitHub merge is observed.
  w = await deliverThroughLedger(engine, w.id, mergeSha, mergedAt);
  assert.equal(w.stage, 'done'); assert.equal(w.delivery?.mergeSha, mergeSha);
  return w;
}

/** Copies of a delivered item, written straight to the store, so a scan can be tested beyond one page. */
async function copies(template: Work, count: number, mergeSha: string, mergedAt: (n: number) => string) {
  const documents = Array.from({ length: count }, (_, n) => ({ ...structuredClone(template), id: randomUUID(), key: `COPY-${++serial}`, delivery: { ...structuredClone(template.delivery!), mergeSha, mergedAt: mergedAt(n) } }));
  await store.pool.query('INSERT INTO work_items(id,document) SELECT * FROM unnest($1::uuid[],$2::jsonb[])', [documents.map(d => d.id), documents.map(d => JSON.stringify(d))]);
  return documents.map(d => d.key);
}

test('unit:sha-observation-marks-deployed — a producer sha observation is idempotent and marks deployed exactly the delivered items it contains', async () => {
  const exact = await delivered(sha('1')), ancestor = await delivered(sha('2')), elsewhere = await delivered(sha('3'));
  const served = sha('4');

  // Every non-producer credential is refused, and nothing is recorded or marked.
  for (const actor of [reader, worker, operator]) {
    const refused = await post(actor, '/api/delivery/observe-sha', observation(exact.delivery!.mergeSha));
    assert.equal(refused.status, 403, `${actor.role} is refused`);
    assert.match(await refused.text(), /A producer credential is required to record a deployment observation by commit/);
  }
  // A non-production environment, or a stale revision of production, never moves the production deployment record.
  await assert.rejects(delivery.observeSha(observer, observation(exact.delivery!.mergeSha, { environment: uat }), id()), /Only the production environment \('production'\) records a deployment by commit; 'uat' is not it/);
  await assert.rejects(delivery.observeSha(observer, observation(exact.delivery!.mergeSha, { environment: { ...production, revision: 2 } }), id()));
  // A reading of some services only leaves the item's other services unobserved, so it is refused; so is a service production lacks.
  await assert.rejects(delivery.observeSha(observer, observation(exact.delivery!.mergeSha, { services: ['web'] }), id()), /must cover every service of 'production'; missing: api/);
  await assert.rejects(delivery.observeSha(observer, observation(exact.delivery!.mergeSha, { services: ['api', 'web', 'worker'] }), id()), /Services that 'production' does not define: worker/);
  assert.equal((await reload(exact)).delivery!.deployment, undefined);
  assert.equal((await store.pool.query(`SELECT count(*)::int AS n FROM events WHERE kind='delivery.sha-observed'`)).rows[0].n, 0);

  // Over HTTP, any producer credential records it — an ordinary proof collector with no observer registration or lease.
  // With no GitHub configured, containment is equality alone: only the exact merge is marked.
  const response = await post(ci, '/api/delivery/observe-sha', observation(exact.delivery!.mergeSha));
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
  await assert.rejects(delivery.observeSha(observer, observation(served, { services: ['web', 'api'] }), key, contains), /Idempotency key reused with different input/);
  const repeat = await delivery.observeSha(observer, observation(served, { observedAt: new Date(Date.now() - 1000).toISOString() }), id(), contains);
  assert.equal(repeat.duplicate, true); assert.equal(repeat.id, result.id); assert.equal(repeat.observedAt, result.observedAt);
  assert.deepEqual(repeat.deployed, []);
  assert.equal((await store.pool.query(`SELECT count(*)::int AS n FROM events WHERE kind='delivery.sha-observed' AND payload->>'sha'=$1`, [served])).rows[0].n, 1);
  assert.equal((await reload(ancestor)).delivery!.deployment!.at, marked.at, 'a repeat does not refresh the record');

  // Beyond one page: more contained items than a page holds, behind more newer items the sha does not contain, are all reached.
  const older = sha('7'), newer = sha('8'), release = sha('9'), mergedAt = Date.parse(elsewhere.delivery!.mergedAt);
  const reached = await copies(elsewhere, 201, older, n => new Date(mergedAt - 3_600_000 - n * 1000).toISOString());
  const ahead = await copies(elsewhere, 201, newer, n => new Date(mergedAt + 1000 + n).toISOString());
  const drained = await delivery.observeSha(observer, observation(release), id(), async merge => merge === older);
  assert.deepEqual([...drained.deployed].sort(), [...reached].sort());
  assert.deepEqual(new Set(drained.awaiting.map(row => row.key)), new Set([...ahead, elsewhere.key]));
  assert.equal(drained.complete, true); assert.equal(drained.next, null);

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

test('unit:sha-observation-bounded-replay — a request does bounded provider work and continues by cursor, replays its receipt after production changes, and re-reads the production selection', async () => {
  // Bounded: more distinct merges than one request compares are reached by continuing from `next`, and a failed comparison stops the batch before it.
  const template = await delivered(sha('c')), served = sha('d');
  const merges = Array.from({ length: 60 }, () => randomBytes(20).toString('hex')), mergedAt = Date.parse(template.delivery!.mergedAt);
  const keys = (await Promise.all(merges.map((merge, n) => copies(template, 1, merge, () => new Date(mergedAt - 7_200_000 - n * 1000).toISOString())))).flat();
  const wanted = new Set(merges);
  let failed = false, passes = 0, after: unknown = undefined;
  const deployed: string[] = [];
  for (;;) {
    let calls = 0;
    const result = await delivery.observeSha(observer, observation(served, after ? { after } : {}), id(), async merge => {
      calls++;
      if (!failed && merge === merges[3]) { failed = true; throw new Error('provider rate limited'); }
      return wanted.has(merge);
    });
    passes++; deployed.push(...result.deployed);
    assert.ok(calls <= 50, `one request made ${calls} provider comparisons`);
    if (result.providerError) { assert.match(result.providerError, /provider rate limited/); assert.equal(result.complete, false); assert.ok(!result.awaiting.some(row => row.key === keys[3]), 'the item whose comparison failed is left for the continuation'); }
    if (result.complete) { assert.equal(result.next, null); break; }
    assert.ok(result.next); after = result.next;
    assert.ok(passes < 20, 'the continuation makes progress');
  }
  assert.ok(failed && passes >= 3, `passes ${passes}`);
  assert.deepEqual(new Set(keys.filter(key => deployed.includes(key))), new Set(keys), 'every contained delivery is reached across continuations');

  // A replayed key returns its receipt even after production's revision advances; a new key at the old revision is refused.
  const replayed = await delivered(sha('e')), input = observation(replayed.delivery!.mergeSha), key = id();
  const first = await delivery.observeSha(observer, input, key);
  assert.deepEqual(first.deployed, [replayed.key]);
  await validation.define(operator, { kind: 'environment', id: production.id, expectedRevision: 1, repository: 'test/repository', url: 'https://production.example.test', instance: 'instance-production', immutable: true, services: ['api', 'web'], resources: ['account-production'] }, id());
  assert.deepEqual(await delivery.observeSha(observer, input, key), first);
  await assert.rejects(delivery.observeSha(observer, observation(sha('f')), id()));

  // The production selection is re-read inside the transaction: one published during the provider scan refuses the stale environment.
  const raced = await delivered(sha('0'));
  const select = (environment: string) => store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [operator.id, 'production.environment', JSON.stringify({ environment })]);
  let switched = false;
  await assert.rejects(delivery.observeSha(observer, observation(served, { environment: { ...production, revision: 2 } }), id(), async () => { if (!switched) { switched = true; await select('uat'); } return true; }),
    /Only the production environment \('uat'\) records a deployment by commit; 'production' is not it/);
  assert.ok(switched);
  assert.equal((await reload(raced)).delivery!.deployment, undefined, 'nothing is recorded against the stale selection');
  await select('production');
});
