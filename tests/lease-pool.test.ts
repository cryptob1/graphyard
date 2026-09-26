import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine, LeaseHealth, RenewalFault, heartbeatLatencyAttentionMs, leaseHealthWindowMs, renewalFaultEvent } from '../src/engine.js';
import { server } from '../src/server.js';
import { leaseCommands, leasePoolConnections } from '../src/store/pools.js';
import { isConfirmedCoordinationRefusal } from '../src/quarantine.js';
import { renewalGraceMs, supervise } from '../src/supervisor.js';
import { leaseHealthStatus } from '../src/cli/lease-health-attention.js';
import { standingEscalations, type Principal, type Work } from '../src/model.js';

// GY-558: lease renewals timed out waiting for a connection behind slow report and observation
// queries, and live workers lost their leases. Each test is named for the proof it produces.
const operator: Principal = { id: 'lease-pool-operator', role: 'admin', sessionKind: 'human' };
const engineer: Principal = { id: 'lease-pool-worker', role: 'worker', sessionKind: 'ai' };
const rival: Principal = { id: 'lease-pool-rival', role: 'worker', sessionKind: 'ai' };
const tokens: Record<string, string> = { [operator.id]: `operator-token-${'o'.repeat(32)}`, [engineer.id]: `worker-token-${'w'.repeat(32)}`, [rival.id]: `rival-token-${'r'.repeat(32)}` };
const credentials = [operator, engineer, rival].map(principal => ({ ...principal, token: tokens[principal.id] }));
let database: EmbeddedPostgres, connection: string;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 196;
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-lease-pool-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('lease_pool');
  connection = `postgres://graphyard:testing-only@127.0.0.1:${port}/lease_pool`;
  const store = new Store(connection); await store.init(); await store.close();
});
after(async () => { if (database) await database.stop(); });

function engineOn(store: Store, leaseSeconds = 120) {
  const engine = new Engine(store, [15368], leaseSeconds, 'owner/project');
  engine.principals = [operator, engineer, rival];
  engine.submissionObserver = null;
  return engine;
}
async function ready(engine: Engine, title: string) {
  const work = await engine.execute(operator, 'create', null, { title, plannedFiles: [`src/${title}.ts`], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }] }, randomUUID());
  return engine.execute(operator, 'ready', work.id, {}, randomUUID());
}
async function claimed(engine: Engine, title: string, actor = engineer) {
  const work = await engine.execute(actor, 'claim', (await ready(engine, title)).id, {}, randomUUID());
  return engine.execute(actor, 'workspace', work.id, { epoch: work.epoch, host: 'lease-pool-host', path: `/tmp/lease-pool/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, randomUUID());
}
async function listening(engine: Engine) {
  const http: Server = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const post = async (actor: Principal, path: string, body: unknown) => {
    const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${tokens[actor.id]}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    return { status: response.status, body: await response.json() };
  };
  const get = async (actor: Principal, path: string) => {
    const response = await fetch(`${url}/api/${path}`, { headers: { Authorization: `Bearer ${tokens[actor.id]}` }, signal: AbortSignal.timeout(15_000) });
    return { status: response.status, body: await response.json() };
  };
  const close = async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); };
  return { post, get, close };
}
/** Hold every connection a pool may open, so nothing else can get one from it. */
async function exhaust(pool: pg.Pool) {
  const max = (pool as unknown as { options: { max: number } }).options.max;
  const held = await Promise.all(Array.from({ length: max }, () => pool.connect()));
  assert.equal(pool.totalCount, max); assert.equal(pool.idleCount, 0);
  return held;
}
/** Sleep until a wall-clock instant. */
const wait = (at: number) => delay(Math.max(0, at - Date.now()));
const timed = async <T>(run: () => Promise<T>) => { const started = performance.now(); const value = await run(); return { value, ms: performance.now() - started }; };

test('unit:lease-pool-isolated — renewal, claim, complete and blocked obtain a connection within 2 s while every other pool is exhausted', async () => {
  assert.ok(leasePoolConnections >= 2, 'the product default gives lease commands more than one connection');
  assert.deepEqual([...leaseCommands].sort(), ['blocked', 'claim', 'heartbeat', 'submit'], 'renewal, claim, complete (submit) and blocked are the lease commands');
  const store = new Store(connection, { max: 2 });
  assert.equal((store.leasePool as unknown as { options: { max: number } }).options.max, leasePoolConnections, 'the lease pool is sized by the product default in store/pools.ts');
  const engine = engineOn(store);
  const http = await listening(engine);
  try {
    const work = await claimed(engine, 'isolated-renewal');
    const open = await ready(engine, 'isolated-claim');
    // Every pool but the lease pool — the general pool, and the report pool where the store has one —
    // is held to its last connection, as slow report and observation queries held it in production.
    const others = Object.entries(store).filter((entry): entry is [string, pg.Pool] => entry[1] instanceof pg.Pool && entry[1] !== store.leasePool);
    assert.ok(others.some(([name]) => name === 'pool'), 'the general pool is among the pools exhausted');
    const held = (await Promise.all(others.map(([, pool]) => exhaust(pool)))).flat();
    try {
      const renewal = await timed(() => http.post(engineer, `work/${work.id}/heartbeat`, { epoch: work.epoch }));
      assert.equal(renewal.value.status, 200, JSON.stringify(renewal.value.body));
      assert.ok(renewal.ms < 2000, `the heartbeat, authentication included, completed in ${Math.round(renewal.ms)} ms`);
      const blocked = await timed(() => http.post(engineer, `work/${work.id}/blocked`, { epoch: work.epoch, reason: 'waiting on a fixture' }));
      assert.equal(blocked.value.status, 200, JSON.stringify(blocked.value.body)); assert.ok(blocked.ms < 2000, `blocked completed in ${Math.round(blocked.ms)} ms`);
      await http.post(engineer, `work/${work.id}/blocked`, { epoch: work.epoch, reason: null });
      const claim = await timed(() => http.post(rival, `work/${open.id}/claim`, {}));
      assert.equal(claim.value.status, 200, JSON.stringify(claim.value.body)); assert.ok(claim.ms < 2000, `claim completed in ${Math.round(claim.ms)} ms`);
      const complete = await timed(() => http.post(engineer, `work/${work.id}/submit`, { epoch: work.epoch, pr: 558 }));
      assert.equal(complete.value.status, 200, JSON.stringify(complete.value.body)); assert.ok(complete.ms < 2000, `complete completed in ${Math.round(complete.ms)} ms`);
      assert.equal(complete.value.body.submission.pr, 558);
    } finally { for (const client of held) client.release(); }
    // The other way round: with every lease connection held, status and reconciliation still run,
    // because neither ever takes a lease connection.
    const leases = await exhaust(store.leasePool);
    try {
      const status = await timed(() => http.get(operator, 'status'));
      assert.equal(status.value.status, 200); assert.ok(status.ms < 5000, `status answered in ${Math.round(status.ms)} ms without a lease connection`);
      await engine.reconcile();
    } finally { for (const client of leases) client.release(); }
  } finally { await http.close(); await store.close(); }
});

test('unit:server-fault-keeps-lease — a renewal that failed server-side keeps its lease for one more period; a lease nobody renews still expires', async () => {
  const leaseSeconds = 3;
  const store = new Store(connection);
  const engine = engineOn(store, leaseSeconds);
  // A renewal fails server-side the way the incident's did: the transaction cannot get a connection.
  const failNext = () => {
    const transaction = store.transaction.bind(store);
    store.transaction = (async () => { store.transaction = transaction; throw new Error('timeout exceeded when trying to connect'); }) as Store['transaction'];
  };
  const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;

  // Kept: the fault is recorded with its time, and the lease outlives its expiry by one period from it.
  const kept = await claimed(engine, 'fault-kept');
  const claimedAt = Date.parse(kept.lease!.expiresAt) - leaseSeconds * 1000;
  await wait(claimedAt + 2000);
  failNext();
  const refusal = await engine.execute(engineer, 'heartbeat', kept.id, { epoch: kept.epoch }, randomUUID()).then(() => null, error => error);
  assert.ok(refusal instanceof RenewalFault, `the failed renewal is answered as a server-side fault: ${refusal}`);
  assert.equal(refusal.status, 503);
  assert.ok(refusal.grace, 'the fault was recorded');
  const faults = (await store.events(kept.id)).filter(event => event.kind === renewalFaultEvent);
  assert.equal(faults.length, 1, 'the server records the failed attempt');
  assert.equal(faults[0].payload.owner, engineer.id); assert.equal(faults[0].payload.epoch, kept.epoch);
  const faultAt = Date.parse(faults[0].payload.at);
  assert.equal(refusal.grace!.at, faults[0].payload.at, 'the record carries the time the renewal arrived');
  assert.equal(Date.parse(refusal.grace!.graceUntil), faultAt + leaseSeconds * 1000, 'the grace is one lease period from the failure');
  assert.equal(renewalGraceMs(Object.assign(new Error(JSON.stringify({ error: refusal.message, renewalFault: refusal.grace }))))! > 0, true, 'the supervisor reads the grace from the 503 body');
  // Past the lease's own expiry, reconciliation keeps it, and nobody else can claim it.
  await wait(claimedAt + leaseSeconds * 1000 + 300);
  await engine.reconcile();
  let stored = await reload(kept);
  assert.ok(stored.lease, 'the lease survived its expiry');
  assert.equal(Date.parse(stored.lease!.expiresAt), faultAt + leaseSeconds * 1000);
  assert.equal((stored.lease as { renewalFault?: { at: string } }).renewalFault?.at, faults[0].payload.at);
  await assert.rejects(engine.execute(rival, 'claim', kept.id, {}, randomUUID()), /active owner/);
  // A second failure before a successful renewal earns nothing more: one further period, once.
  failNext();
  const again = await engine.execute(engineer, 'heartbeat', kept.id, { epoch: kept.epoch }, randomUUID()).then(() => null, error => error);
  assert.ok(again instanceof RenewalFault);
  assert.equal(Date.parse(again.grace!.graceUntil), faultAt + leaseSeconds * 1000, 'a repeated failure does not extend the grace');
  // The supervisor kept retrying; its next renewal succeeds and the lease is ordinary again.
  const renewed = await engine.execute(engineer, 'heartbeat', kept.id, { epoch: kept.epoch }, randomUUID());
  assert.ok(Date.parse(renewed.lease!.expiresAt) > faultAt + leaseSeconds * 1000, 'a successful renewal extends the lease as usual');
  assert.equal((renewed.lease as { renewalFault?: unknown }).renewalFault, undefined, 'and clears the fault');

  // Lapsed after the grace: a fault extends by one period only, and then the lease is lost.
  const graced = await claimed(engine, 'fault-lapses');
  const gracedAt = Date.parse(graced.lease!.expiresAt) - leaseSeconds * 1000;
  await wait(gracedAt + 500);
  failNext();
  await assert.rejects(engine.execute(engineer, 'heartbeat', graced.id, { epoch: graced.epoch }, randomUUID()), RenewalFault);
  const gracedFault = Date.parse((await store.events(graced.id)).find(event => event.kind === renewalFaultEvent)!.payload.at);
  await wait(gracedFault + leaseSeconds * 1000 + 300);
  await engine.reconcile();
  stored = await reload(graced);
  assert.equal(stored.lease, null, 'the lease is lost one period after the failure without a renewal');

  // Stopped renewing: no failure recorded, and the lease expires exactly as before.
  const silent = await claimed(engine, 'stopped-renewing');
  await wait(Date.parse(silent.lease!.expiresAt) + 300);
  await engine.reconcile();
  stored = await reload(silent);
  assert.equal(stored.lease, null, 'a lease nobody renews still expires');
  assert.ok(standingEscalations(stored).some(entry => entry.trigger === 'lease-loss'), 'and its loss escalates as today');
  await store.close();
});

test('unit:server-fault-keeps-lease — the supervisor keeps renewing through a recorded server-side failure past its local deadline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'graphyard-lease-pool-')); const marker = join(dir, 'done');
  const leaseMs = 1500;
  let calls = 0, renewedAfterDeadline = false;
  const started = performance.now();
  const fault = () => {
    const now = new Date();
    return Object.assign(new Error(JSON.stringify({ error: 'Lease renewal failed server-side', renewalFault: { at: now.toISOString(), graceUntil: new Date(now.getTime() + leaseMs).toISOString(), now: now.toISOString() } })), { confirmedRefusal: isConfirmedCoordinationRefusal(503, { error: 'x' }) });
  };
  const supervising = supervise(process.execPath, ['-e', `const fs = require('node:fs'); setInterval(() => { if (fs.existsSync(${JSON.stringify(marker)})) process.exit(0); }, 20);`], 1, async () => {
    calls++;
    const elapsed = performance.now() - started;
    // The launch renewal succeeds; every renewal fails server-side until well past the local deadline.
    if (calls > 1 && elapsed < leaseMs + 700) throw fault();
    if (calls > 1) renewedAfterDeadline = true;
    return { updatedAt: new Date().toISOString(), lease: { epoch: 1, expiresAt: new Date(Date.now() + leaseMs).toISOString() } };
  }, { intervalMs: 100, retryMs: 50, retryMaxMs: 150, safetyMarginMs: 300, graceMs: 50, session: { visible: () => null, unconsented: () => null } });
  let settled = false; void supervising.then(() => { settled = true; }, () => { settled = true; });
  const until = performance.now() + 10_000;
  while (!renewedAfterDeadline && !settled && performance.now() < until) await delay(20);
  await delay(200);
  assert.equal(settled, false, 'the worker was not stopped at its local deadline');
  assert.ok(renewedAfterDeadline, `renewal was retried past the original ${leaseMs} ms deadline and succeeded (${calls} calls)`);
  await writeFile(marker, '');
  assert.equal(await supervising, 0);
  // Without a recorded grace the failure is no reason to outlive the lease.
  assert.equal(renewalGraceMs(new Error(JSON.stringify({ error: 'Internal error; consult server logs' }))), null);
  assert.equal(renewalGraceMs(new TypeError('fetch failed')), null);
  await rm(dir, { recursive: true, force: true });
});

test('unit:heartbeat-latency-reported — status reports heartbeat p50/p95 and failed or refused renewals, and master status raises p95 over 5 s', async () => {
  // The window and percentiles, on a controlled clock.
  const health = new LeaseHealth();
  const now = Date.now();
  health.record('renewed', 99_999, now - leaseHealthWindowMs - 1);
  for (let n = 1; n <= 100; n++) health.record(n === 100 ? 'failed' : n % 10 === 0 ? 'refused' : 'renewed', n * 10, now);
  let report = health.report(now);
  assert.equal(report.renewals, 100, 'a renewal older than ten minutes is not counted');
  assert.equal(report.p50Ms, 500); assert.equal(report.p95Ms, 950);
  assert.equal(report.failed, 1); assert.equal(report.refused, 9);
  assert.equal(report.attention, null, 'no attention while p95 is within 5 s');
  for (let n = 0; n < 20; n++) health.record('renewed', heartbeatLatencyAttentionMs + 1000, now);
  report = health.report(now);
  assert.ok(report.p95Ms! > heartbeatLatencyAttentionMs);
  assert.match(report.attention!, /heartbeat p95 \d+ ms .*exceeds 5000 ms/);
  const master = leaseHealthStatus({ leaseHealth: report });
  assert.equal(master.attention.length, 1, 'master status raises one attention item');
  assert.equal(master.attention[0].subject, 'leases');
  assert.deepEqual(master.report, { p50Ms: report.p50Ms, p95Ms: report.p95Ms, renewals: report.renewals, refused: 9, failed: 1, windowMs: leaseHealthWindowMs });
  assert.deepEqual(leaseHealthStatus({ leaseHealth: { ...report, p95Ms: 100, attention: null } }).attention, []);
  assert.deepEqual(leaseHealthStatus(null), { report: null, attention: [] }, 'a server that predates the report raises nothing');

  // The server counts its own renewals, refusals and server-side failures, and GET /api/status carries them.
  const store = new Store(connection);
  const engine = engineOn(store);
  const http = await listening(engine);
  try {
    const work = await claimed(engine, 'latency-reported');
    for (let n = 0; n < 3; n++) assert.equal((await http.post(engineer, `work/${work.id}/heartbeat`, { epoch: work.epoch })).status, 200);
    assert.equal((await http.post(engineer, `work/${work.id}/heartbeat`, { epoch: work.epoch + 1 })).status, 409, 'a renewal for another epoch is refused');
    const transaction = store.transaction.bind(store);
    store.transaction = (async () => { store.transaction = transaction; throw new Error('canceling statement due to statement timeout'); }) as Store['transaction'];
    const failed = await http.post(engineer, `work/${work.id}/heartbeat`, { epoch: work.epoch });
    assert.equal(failed.status, 503);
    assert.ok(failed.body.renewalFault?.graceUntil, 'the 503 names the grace its recorded fault earned');
    const status = await http.get(operator, 'status');
    assert.equal(status.status, 200);
    const served = status.body.leaseHealth;
    assert.equal(served.renewals, 5); assert.equal(served.refused, 1); assert.equal(served.failed, 1);
    assert.ok(typeof served.p50Ms === 'number' && typeof served.p95Ms === 'number' && served.p95Ms >= served.p50Ms);
    assert.equal(served.attention, null);
  } finally { await http.close(); await store.close(); }

  // The operations reference states the lease pool and the rule.
  const docs = await readFile(new URL('../docs/operations-reference.md', import.meta.url), 'utf8');
  assert.match(docs, /lease pool/i); assert.match(docs, /p95/); assert.match(docs, /one more lease period|one further lease period/);
});
