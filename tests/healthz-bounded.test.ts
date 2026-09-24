import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthCheckWaitMs, healthRoutes } from '../src/server/routes/health.js';

// On a fresh process the reconciliation step can hold every pooled connection for minutes; an
// unbounded SELECT 1 then failed the deploy's health check. The probe is bounded like the resource checks.
function probe(query: () => Promise<unknown>) {
  const services = { engine: { store: { pool: { query } } }, github: null, build: { commit: 'c'.repeat(40), protocol: 1 } } as any;
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
  await assert.rejects(probe(() => Promise.reject(new Error('connect ECONNREFUSED'))), /ECONNREFUSED/);
});
