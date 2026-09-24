import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthCheckQueryGraceMs, healthCheckWaitMs, healthRoutes } from '../src/server/routes/health.js';

// On a fresh process the reconciliation step can hold every pooled connection for minutes; an
// unbounded SELECT 1 then failed the deploy's health check. The probe is bounded like the resource checks.
/**
 * A pool as pg-pool presents it to the probe: `queued` puts the probe's request behind a full pool
 * (no idle client, the waiting count rises when it asks), and `handedAt` hands it a client that long
 * after it asked, when the probe leaves the queue and runs `query` on that client.
 */
function probe(query: () => Promise<unknown>, options: { queued?: boolean; handedAt?: number } = { queued: true }) {
  let waiting = 0;
  const client = { query, release: () => {} };
  const pool = {
    get waitingCount() { return waiting; }, idleCount: options.queued ? 0 : 1,
    connect: () => {
      if (!options.queued) return Promise.resolve(client);
      waiting++;
      return new Promise(resolve => { if (options.handedAt !== undefined) setTimeout(() => { waiting--; resolve(client); }, options.handedAt).unref(); });
    },
  };
  const services = { engine: { store: { pool } }, github: null, build: { commit: 'c'.repeat(40), protocol: 1 } } as any;
  const context = { services, url: new URL('http://plane/healthz'), send: () => { throw new Error('the busy pool is not a 503'); } } as any;
  return healthRoutes.routes[0].handle(context, []);
}

test('unit:healthz-select-bounded — /healthz answers within its bound while the pool is busy, naming the busy pool as the cause', async () => {
  const started = Date.now();
  const body = await probe(() => new Promise(() => {})) as any;
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= healthCheckWaitMs - 50 && elapsed < healthCheckWaitMs + 1000, `answered in ${elapsed} ms`);
  assert.equal(body.ok, true);
  assert.equal(body.writable, null);
  assert.equal(body.resources, null);
  assert.deepEqual(body.causes, [`database probe did not finish within ${healthCheckWaitMs} ms; the pool is busy`]);
  assert.equal(body.commit, 'c'.repeat(40));
});

test('unit:healthz-select-bounded — a database the process cannot reach still fails the probe', async () => {
  await assert.rejects(probe(() => Promise.reject(new Error('connect ECONNREFUSED')), { queued: false }), /ECONNREFUSED/);
});

test('unit:healthz-select-bounded — a probe that held a connection the database never answered fails within the bound', async () => {
  const started = Date.now();
  // Not queued behind a full pool (nothing waiting for a client): a blackholed connection, not a busy pool.
  await assert.rejects(probe(() => new Promise(() => {}), { queued: false }), /database is unreachable/);
  assert.ok(Date.now() - started < healthCheckWaitMs + 1000);
});

test('unit:healthz-select-bounded — a probe queued behind the busy pool and handed a client just before the bound is still the busy pool, not an unreachable database', async () => {
  // The waiting count is back to zero at the deadline; the probe's own queueing is what counts.
  const body = await probe(() => new Promise(() => {}), { queued: true, handedAt: healthCheckWaitMs - 100 }) as any;
  assert.equal(body.ok, true);
  assert.deepEqual(body.causes, [`database probe did not finish within ${healthCheckWaitMs} ms; the pool is busy`]);
});

test('unit:healthz-select-bounded — a probe that queued briefly, then held its client for most of the bound without an answer, fails as an unreachable database', async () => {
  // Having queued once is not a pass: the probe owned a connection the database never answered on.
  const handedAt = healthCheckWaitMs - healthCheckQueryGraceMs - 1000;
  await assert.rejects(probe(() => new Promise(() => {}), { queued: true, handedAt }), /held its pooled connection for \d+ ms without an answer; the database is unreachable/);
});

test('unit:healthz-select-bounded — a probe abandoned on an unanswered connection fails the next probe at once, without taking another pool slot', async () => {
  // A blackholed network: the first probe opens a connection that never answers. Were the next probes
  // to ask the pool too, their abandoned attempts would fill it and later probes would queue and read as the busy pool.
  let connects = 0, waiting = 0;
  const pool = {
    get waitingCount() { return waiting; }, get idleCount() { return connects === 0 ? 1 : 0; },
    connect: () => { connects++; return new Promise(() => {}); },
  };
  const services = { engine: { store: { pool } }, github: null, build: { commit: 'c'.repeat(40), protocol: 1 } } as any;
  const context = { services, url: new URL('http://plane/healthz'), send: () => { throw new Error('not a 503'); } } as any;
  await assert.rejects(healthRoutes.routes[0].handle(context, []), /was not waiting for a pooled connection; the database is unreachable/);
  const started = Date.now();
  await assert.rejects(healthRoutes.routes[0].handle(context, []), /1 earlier database probe is still waiting on a connection the database has not answered; the database is unreachable/);
  assert.ok(Date.now() - started < 100);
  assert.equal(connects, 1);
});
