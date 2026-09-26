import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { isConfirmedCoordinationRefusal } from '../src/quarantine.js';
import { definiteRenewalRefusal, supervise } from '../src/supervisor.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Each test is named for the proof it produces (GY-274): a transient renewal failure never stops a
// worker, the first reconcile after boot cannot starve renewals, and a deploy loses no worker.
const renewal = (duration: number) => ({ updatedAt: new Date().toISOString(), lease: { epoch: 1, expiresAt: new Date(Date.now() + duration).toISOString() } });
const refusal = (status: number, error: string) => Object.assign(new Error(JSON.stringify({ error })), { confirmedRefusal: isConfirmedCoordinationRefusal(status, { error }) });
const quiet = { visible: () => null, unconsented: () => null };
/** A worker that runs until the test says it is done, and exits 0 on its own. */
const worker = (marker: string) => [process.execPath, ['-e', `const fs = require('node:fs'); setInterval(() => { if (fs.existsSync(${JSON.stringify(marker)})) process.exit(0); }, 20);`]] as const;
const scratch = () => temporaryDirectory('renewal');

test('unit:renewal-transient-tolerated a renewal that throws twice and then succeeds never stops the worker', async () => {
  const dir = await scratch(); const marker = join(dir, 'done');
  let calls = 0; const failures: number[] = [];
  const [command, args] = worker(marker);
  const supervising = supervise(command, [...args], 1, async () => {
    calls++;
    // The launch renewal succeeds; the next two throw like a server mid-deploy, then it answers.
    if (calls === 2 || calls === 3) { failures.push(calls); throw new TypeError('fetch failed'); }
    return renewal(2000);
  }, { intervalMs: 100, retryMs: 30, retryMaxMs: 100, safetyMarginMs: 300, graceMs: 50, session: quiet });
  let settled = false; void supervising.then(() => { settled = true; }, () => { settled = true; });
  // Bounded, so a supervisor that stops the worker on a failed renewal fails this test, not hangs it.
  const waitUntil = performance.now() + 10_000;
  while (calls < 6 && !settled && performance.now() < waitUntil) await delay(20);
  assert.equal(settled, false, 'the worker is still running after two failed renewals');
  assert.ok(calls >= 6, `renewals continued after the two failures (${calls} calls)`);
  await writeFile(marker, '');
  assert.equal(await supervising, 0, 'the worker exited on its own; the supervisor never stopped it');
  assert.deepEqual(failures, [2, 3]);
  await rm(dir, { recursive: true, force: true });
});

test('unit:renewal-transient-tolerated a definite 409 refusal stops the worker at once', async () => {
  const dir = await scratch(); const marker = join(dir, 'done');
  let calls = 0;
  const [command, args] = worker(marker);
  const started = performance.now();
  const code = await supervise(command, [...args], 1, async () => {
    if (++calls === 1) return renewal(60_000);
    throw refusal(409, 'Lease for epoch 1 is not held by this worker');
  }, { intervalMs: 50, retryMs: 30, safetyMarginMs: 300, graceMs: 50, session: quiet });
  assert.equal(code, 1, 'the supervisor stopped the worker');
  assert.equal(calls, 2, 'a definite refusal is never retried');
  assert.ok(performance.now() - started < 5000, 'stopped long before the 60 s lease would have expired');
  assert.equal(existsSync(marker), false);
  await rm(dir, { recursive: true, force: true });
});

test('unit:renewal-transient-tolerated a renewal that keeps failing stops the worker only after the lease deadline', async () => {
  const dir = await scratch(); const marker = join(dir, 'done');
  const leaseMs = 1500, marginMs = 400;
  let calls = 0; const failedAt: number[] = [];
  const [command, args] = worker(marker);
  const started = performance.now();
  const code = await supervise(command, [...args], 1, async () => {
    if (++calls === 1) return renewal(leaseMs);
    failedAt.push(performance.now() - started);
    throw Object.assign(new Error('Service Unavailable'), { status: 503 });
  }, { intervalMs: 100, retryMs: 50, retryMaxMs: 200, safetyMarginMs: marginMs, graceMs: 50, session: quiet });
  const elapsed = performance.now() - started;
  assert.equal(code, 1);
  assert.ok(elapsed >= leaseMs, `stopped at ${Math.round(elapsed)} ms, not before the ${leaseMs} ms lease expired`);
  assert.ok(failedAt.length > 2, `renewals were retried (${failedAt.length} attempts)`);
  assert.ok(failedAt.at(-1)! <= leaseMs - marginMs + 100, 'retries stop at the safety margin before the deadline');
  await rm(dir, { recursive: true, force: true });
});

test('unit:renewal-transient-tolerated only a server refusal is definite', () => {
  assert.equal(definiteRenewalRefusal(refusal(409, 'epoch superseded')), true);
  assert.equal(definiteRenewalRefusal(refusal(403, 'not the lease owner')), true);
  assert.equal(definiteRenewalRefusal(Object.assign(new Error('x'), { status: 404 })), true);
  assert.equal(definiteRenewalRefusal(refusal(503, 'unavailable')), false);
  assert.equal(definiteRenewalRefusal(refusal(429, 'slow down')), false);
  assert.equal(definiteRenewalRefusal(Object.assign(new Error('x'), { status: 408 })), false);
  assert.equal(definiteRenewalRefusal(new TypeError('fetch failed')), false);
  assert.equal(definiteRenewalRefusal(new SyntaxError('Unexpected token < in JSON')), false, 'a proxy page during a deploy is not an answer');
});

const operator: Principal = { id: 'renewal-operator', role: 'admin', sessionKind: 'human' };
const engineer: Principal = { id: 'renewal-worker', role: 'worker', sessionKind: 'ai' };
const tokens: Record<string, string> = { [operator.id]: `operator-token-${'x'.repeat(32)}`, [engineer.id]: `worker-token-${'y'.repeat(32)}` };
let database: EmbeddedPostgres, connection: string;
before(async () => {
  const port = Number(process.env.GRAPHYARD_RENEWAL_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 274);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('renewal-pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('renewal_test');
  connection = `postgres://graphyard:testing-only@127.0.0.1:${port}/renewal_test`;
  const store = new Store(connection); await store.init(); await store.close();
});
after(async () => { if (database) await database.stop(); });

async function claimed(engine: Engine, title: string) {
  let work = await engine.execute(operator, 'create', null, { title, plannedFiles: [`src/${title}.ts`], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(engineer, 'claim', work.id, {}, randomUUID());
  return engine.execute(engineer, 'workspace', work.id, { epoch: work.epoch, host: 'renewal-host', path: `/tmp/renewal/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, randomUUID());
}

test('integration:renew-not-starved-by-reconcile renewals complete within 2 s throughout a long reconcile on a small, busy pool', async () => {
  const store = new Store(connection, { max: 4 });
  const engine = new Engine(store, [15368], 120, 'owner/project');
  engine.principals = [operator, engineer];
  const items: Work[] = [];
  for (let n = 0; n < 24; n++) items.push(await claimed(engine, `starve-${n}`));
  const held = items.at(-1)!;
  assert.equal(store.background.limit, 2, 'background work may hold at most half of a four-connection pool');
  // The reconcile is made long the way a deploy's first pass is: every item costs real time.
  let slow = false;
  const evaluate = engine.evaluate.bind(engine);
  engine.evaluate = (work, all, now) => { if (slow) { const until = performance.now() + 150; while (performance.now() < until); } return evaluate(work, all, now); };
  // Every other main-pool connection is busy with requests of its own.
  const busy = await Promise.all([store.pool.connect(), store.pool.connect(), store.pool.connect()]);
  slow = true;
  let reconciling = true, peakBackground = 0;
  const started = performance.now();
  const pass = engine.reconcile().finally(() => { reconciling = false; });
  const latencies: number[] = [];
  let lastRenewed = 0;
  try {
    while (reconciling) {
      peakBackground = Math.max(peakBackground, store.background.inUse);
      const renewStarted = performance.now();
      await engine.execute(engineer, 'heartbeat', held.id, { epoch: held.epoch }, randomUUID());
      latencies.push(performance.now() - renewStarted); lastRenewed = Date.now();
      await delay(100);
    }
    await pass;
  } finally { slow = false; for (const client of busy) client.release(); }
  const passMs = performance.now() - started;
  assert.ok(passMs > 3000, `the reconcile ran long (${Math.round(passMs)} ms)`);
  assert.ok(latencies.length >= 5, `renewals ran throughout the reconcile (${latencies.length})`);
  assert.ok(Math.max(...latencies) < 2000, `every renewal completed within 2 s: ${latencies.map(ms => Math.round(ms)).join(', ')} ms`);
  assert.ok(peakBackground <= store.background.limit, `the reconcile held at most ${store.background.limit} connections`);
  // The reconcile's batches re-read the items, so no renewal made while it yielded was overwritten.
  const after = (await store.list()).find(item => item.id === held.id)!;
  assert.ok(Date.parse(after.lease!.expiresAt) >= lastRenewed + 119_000 - 1000, 'the last renewal survived the reconcile');
  await store.close();
});

test('integration:worker-survives-deploy a worker keeps running through a 60 s server restart and renews once the server is back', async () => {
  const dir = await scratch(); const marker = join(dir, 'done');
  const credentials = [operator, engineer].map(principal => ({ ...principal, token: tokens[principal.id] }));
  const boot = async (port = 0) => {
    const store = new Store(connection);
    const engine = new Engine(store, [15368], 120, 'owner/project');
    engine.principals = [operator, engineer];
    const http: Server = server(engine, credentials);
    await new Promise<void>(resolve => http.listen(port, '127.0.0.1', resolve));
    return { store, engine, http, port: (http.address() as { port: number }).port };
  };
  const shutdown = async (running: Awaited<ReturnType<typeof boot>>) => {
    running.http.closeAllConnections();
    await new Promise<void>(resolve => running.http.close(() => resolve()));
    await running.store.close();
  };
  let running = await boot();
  const work = await claimed(running.engine, 'deploy-survivor');
  const url = `http://127.0.0.1:${running.port}`;
  // The CLI's renewal, as `graphyard watch` makes it: a JSON refusal is definite, anything else is not.
  const outcomes: { at: number; ok: boolean }[] = [];
  const renew = async () => {
    try {
      const response = await fetch(`${url}/api/work/${work.id}/heartbeat`, { method: 'POST', headers: { Authorization: `Bearer ${tokens[engineer.id]}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ epoch: work.epoch }), signal: AbortSignal.timeout(30_000) });
      const body = await response.json();
      if (!response.ok) throw Object.assign(new Error(JSON.stringify(body)), { confirmedRefusal: isConfirmedCoordinationRefusal(response.status, body) });
      outcomes.push({ at: performance.now(), ok: true });
      return body;
    } catch (error) { outcomes.push({ at: performance.now(), ok: false }); throw error; }
  };
  const [command, args] = worker(marker);
  // Production timing: a 120 s lease, a 15 s safety margin, backoff capped at 10 s; renewals every 5 s.
  const supervising = supervise(command, [...args], work.epoch, renew, { intervalMs: 5000, graceMs: 200, session: quiet });
  let code: number | undefined; void supervising.then(value => { code = value; });
  await delay(1000);
  // The deploy: the old server goes away, and for 60 s nothing answers on its port.
  const down = performance.now();
  await shutdown(running);
  await delay(60_000);
  assert.equal(code, undefined, 'the worker is still running after 60 s without a server');
  const failed = outcomes.filter(outcome => !outcome.ok && outcome.at >= down).length;
  assert.ok(failed >= 3, `renewals kept failing and were retried during the outage (${failed})`);
  // The new server comes up on the same address.
  running = await boot(running.port);
  const back = performance.now();
  while (!outcomes.some(outcome => outcome.ok && outcome.at >= back) && performance.now() - back < 30_000) await delay(100);
  assert.ok(outcomes.some(outcome => outcome.ok && outcome.at >= back), 'the supervisor renewed once the server was back');
  const renewed = (await running.store.list()).find(item => item.id === work.id)!;
  assert.equal(renewed.lease?.epoch, work.epoch, 'the worker still holds its lease');
  assert.ok(Date.parse(renewed.lease!.expiresAt) > Date.now() + 100_000, 'the lease was extended by the new server');
  assert.equal(code, undefined, 'the worker is still running');
  await writeFile(marker, '');
  assert.equal(await supervising, 0, 'the worker finished on its own');
  await shutdown(running);
  await rm(dir, { recursive: true, force: true });
});
