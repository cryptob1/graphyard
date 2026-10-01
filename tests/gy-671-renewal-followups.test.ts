import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { z } from 'zod';
import { Store } from '../src/store.js';
import { Engine, LeaseHealth, RenewalFault, heartbeatLatencyAttentionMs, renewalFaultEvent, renewalFaultOf } from '../src/engine.js';
import { Refusal } from '../src/model/refusal.js';
import { renewalGraceMs } from '../src/supervisor.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-671: follow-ups from the approved review of GY-558 (PR #299). Each test is named for the proof
// it produces and pins one behaviour the review asked for: the fault record no longer rides the
// lease pool whose exhaustion caused the failure, the 503 carries its grace before the record has
// landed, leaseHealth names the one process that measured it, and only the server's trouble —
// never a programming error — earns a grace. Strip the src/engine.ts change and every case here
// fails, so the manual proof exercises its criterion.
const operator: Principal = { id: 'gy671-operator', role: 'admin', sessionKind: 'human' };
const engineer: Principal = { id: 'gy671-worker', role: 'worker', sessionKind: 'ai' };
let database: EmbeddedPostgres, connection: string;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 890;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('gy671'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('gy671_followups');
  connection = `postgres://graphyard:testing-only@127.0.0.1:${port}/gy671_followups`;
  const store = new Store(connection); await store.init(); await store.close();
});
after(async () => { if (database) await database.stop(); });

function engineOn(store: Store, leaseSeconds = 120) {
  const engine = new Engine(store, [15368], leaseSeconds, 'owner/project');
  engine.principals = [operator, engineer];
  engine.submissionObserver = null;
  return engine;
}
async function ready(engine: Engine, title: string) {
  const work = await engine.execute(operator, 'create', null, { title, plannedFiles: [`src/${title}.ts`], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }] }, randomUUID());
  return engine.execute(operator, 'ready', work.id, {}, randomUUID());
}
async function claimed(engine: Engine, title: string) {
  const work = await engine.execute(engineer, 'claim', (await ready(engine, title)).id, {}, randomUUID());
  return engine.execute(engineer, 'workspace', work.id, { epoch: work.epoch, host: 'gy671-host', path: `/tmp/gy671/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, randomUUID());
}
/** Hold every connection the lease pool may open, so nothing else can get one from it. */
async function exhaust(pool: pg.Pool) {
  const max = (pool as unknown as { options: { max: number } }).options.max;
  const held = await Promise.all(Array.from({ length: max }, () => pool.connect()));
  assert.equal(pool.totalCount, max); assert.equal(pool.idleCount, 0);
  return held;
}
/** Sleep until a wall-clock instant. */
const wait = (at: number) => delay(Math.max(0, at - Date.now()));
/** Fail the next coordination transaction the way the incident's did: no connection. */
const failNext = (store: Store) => {
  const transaction = store.transaction.bind(store);
  store.transaction = (async () => { store.transaction = transaction; throw new Error('timeout exceeded when trying to connect'); }) as Store['transaction'];
};
const faultsOf = async (store: Store, work: Work) => (await store.events(work.id)).filter(event => event.kind === renewalFaultEvent);

test('manual:review-followups-triaged GY-671.1: renewalFaultOf blames only the server — connection errnos and messages, the database server-error SQLSTATE classes and 5xx refusals earn a fault; client SQLSTATE classes, ZodError, sub-500 refusals and programming errors earn nothing', () => {
  const coded = (code: string, message: string) => Object.assign(new Error(message), { code });
  let zodError: unknown;
  try { z.object({}).parse(42); } catch (error) { zodError = error; }
  assert.ok(zodError instanceof z.ZodError, 'the fixture is a real ZodError');

  // The server's trouble: lost or timed-out connections, resource limits, statement timeouts.
  assert.ok(renewalFaultOf(coded('ECONNRESET', 'Connection terminated unexpectedly')));
  assert.ok(renewalFaultOf(coded('ETIMEDOUT', 'connect ETIMEDOUT 10.0.0.1:5432')));
  assert.ok(renewalFaultOf(new Error('timeout exceeded when trying to connect')));
  assert.ok(renewalFaultOf(new Error('Connection terminated unexpectedly')));
  assert.match(renewalFaultOf(coded('57014', 'canceling statement due to statement timeout'))!, /^SQLSTATE 57014:/);
  assert.match(renewalFaultOf(coded('08006', 'connection failure'))!, /^SQLSTATE 08006:/);
  assert.match(renewalFaultOf(coded('53300', 'sorry, too many clients already'))!, /^SQLSTATE 53300:/);
  assert.match(renewalFaultOf(new RenewalFault('server busy', null))!, /^HTTP 503:/, 'a 5xx refusal is the server too');

  // Everything else is not: the client's own classes, schema errors, a bug, a plain string.
  assert.equal(renewalFaultOf(coded('23505', 'duplicate key value violates unique constraint')), null);
  assert.equal(renewalFaultOf(coded('42501', 'permission denied for table work_items')), null);
  assert.equal(renewalFaultOf(coded('40001', 'could not serialize access due to concurrent update')), null);
  assert.equal(renewalFaultOf(new Error('relation "work_items" does not exist')), null);
  assert.equal(renewalFaultOf(zodError), null, 'a bad request is not a server fault');
  assert.equal(renewalFaultOf(new Refusal('not yours', 403)), null, 'a sub-500 refusal earns nothing');
  assert.equal(renewalFaultOf(new TypeError('Cannot read properties of undefined (reading id)')), null, 'a programming error earns no grace');
  assert.equal(renewalFaultOf('boom'), null);
});

test('manual:review-followups-triaged GY-671.2: the leaseHealth report names the one process that measured it, and its attention item says a multi-replica deployment reports each replica separately', () => {
  const now = Date.now();
  const health = new LeaseHealth();
  for (let n = 0; n < 20; n++) health.record('renewed', heartbeatLatencyAttentionMs + 1000, now);
  const report = health.report(now);
  assert.equal(report.scope, 'process', 'the report names its scope');
  assert.equal(report.process, `${hostname()}/${process.pid}`, 'the report names the host and process that measured it');
  assert.ok(report.attention);
  assert.match(report.attention, /one server process's own/);
  assert.match(report.attention, /each replica separately/);
  assert.ok(report.attention.includes(report.process!), 'the attention item names the process it measured');

  const quiet = new LeaseHealth();
  quiet.record('renewed', 12, now);
  const calm = quiet.report(now);
  assert.equal(calm.attention, null, 'nothing raised while p95 is within the threshold');
  assert.equal(calm.scope, 'process');
  assert.equal(calm.process, `${hostname()}/${process.pid}`, 'every report says what measured it, raised or not');
});

test('manual:review-followups-triaged GY-671.3: the fault record is written on the main pool, so a lease pool with no connection to give still records the failure and grants the grace', async () => {
  const store = new Store(connection);
  const engine = engineOn(store, 3);
  const work = await claimed(engine, 'gy671-main-pool');
  const claimedAt = Date.parse(work.lease!.expiresAt) - 3000;
  await wait(claimedAt + 2000);
  failNext(store);
  const held = await exhaust(store.leasePool);
  try {
    const refusal = await engine.execute(engineer, 'heartbeat', work.id, { epoch: work.epoch }, randomUUID()).then(() => null, error => error);
    assert.ok(refusal instanceof RenewalFault, `the failed renewal is answered as a server-side fault: ${refusal}`);
    assert.equal(refusal.status, 503);
    assert.ok(refusal.grace, 'the record landed without a lease-pool connection');
    const faults = await faultsOf(store, work);
    assert.equal(faults.length, 1, 'the failure is recorded off the lease pool');
    assert.equal(refusal.grace!.at, faults[0].payload.at, 'the record carries the time the renewal arrived');
    assert.equal(Date.parse(refusal.grace!.graceUntil), Date.parse(faults[0].payload.at) + 3000, 'the grace is one lease period from the failure');
  } finally { for (const client of held) client.release(); }
  await store.close();
});

test('manual:review-followups-triaged GY-671.4: the 503 carries the grace before the record has landed, so the supervisor extends its deadline as far as the server keeps the lease, and the retried record carries the same instant', async () => {
  const store = new Store(connection);
  const engine = engineOn(store, 3);
  const work = await claimed(engine, 'gy671-provisional-grace');
  const claimedAt = Date.parse(work.lease!.expiresAt) - 3000;
  await wait(claimedAt + 2000);
  failNext(store);
  // The record's own write fails too: nothing has landed when the refusal is raised.
  const realPool = store.pool;
  (store as unknown as { pool: pg.Pool }).pool = { query: async () => { throw new Error('timeout exceeded when trying to connect'); } } as unknown as pg.Pool;
  const refusal = await engine.execute(engineer, 'heartbeat', work.id, { epoch: work.epoch }, randomUUID()).then(() => null, error => error);
  (store as unknown as { pool: pg.Pool }).pool = realPool;
  assert.ok(refusal instanceof RenewalFault, `the failed renewal is answered as a server-side fault: ${refusal}`);
  assert.ok(refusal.grace, 'the 503 carries the grace even though the record has not landed');
  assert.match(refusal.message, /the record is being retried/);
  const at = Date.parse(refusal.grace!.at);
  assert.equal(Date.parse(refusal.grace!.graceUntil), at + 3000, 'the provisional grace is the one lease period the record will earn');
  assert.ok(renewalGraceMs(Object.assign(new Error(JSON.stringify({ error: refusal.message, renewalFault: refusal.grace }))))! > 0, 'the supervisor reads the provisional grace from the 503 body');
  assert.equal((await faultsOf(store, work)).length, 0, 'nothing is recorded yet');
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && (await faultsOf(store, work)).length === 0) await delay(100);
  const faults = await faultsOf(store, work);
  assert.equal(faults.length, 1, 'the background retry lands the record on the main pool');
  assert.equal(Date.parse(faults[0].payload.at), at, 'the landed record carries the time the renewal arrived');
  await store.close();
});

test('manual:review-followups-triaged GY-671.5: a programming error in a heartbeat earns no grace and no record — it surfaces as the bug it is and the lease is untouched', async () => {
  const store = new Store(connection);
  const engine = engineOn(store, 3);
  const work = await claimed(engine, 'gy671-programming-error');
  const expiresAt = work.lease!.expiresAt;
  const transaction = store.transaction.bind(store);
  store.transaction = (async () => { store.transaction = transaction; throw new TypeError('Cannot read properties of undefined (reading id)'); }) as Store['transaction'];
  await assert.rejects(engine.execute(engineer, 'heartbeat', work.id, { epoch: work.epoch }, randomUUID()), TypeError, 'the bug surfaces as itself, not as a server-side fault');
  assert.equal((await faultsOf(store, work)).length, 0, 'no fault record for a bug');
  const stored = (await store.list()).find(item => item.id === work.id)!;
  assert.equal(stored.lease!.expiresAt, expiresAt, 'the lease is neither extended nor faulted');
  await store.close();
});
