import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileBatchMs, serverPoolSizes } from '../src/server/main.js';

// 2026-09-26: at ~700 items each 250 ms reconcile batch re-read the whole fleet, ticks took ~30 s and
// every request queued behind them; installations need to tune the batch without a code change.
test('unit:reconcile-batch-configurable — GRAPHYARD_RECONCILE_BATCH_MS sets the reconcile batch within 100..5000 ms, and anything else keeps 250', () => {
  assert.equal(reconcileBatchMs(undefined), 250);
  assert.equal(reconcileBatchMs('1000'), 1000);
  assert.equal(reconcileBatchMs('100'), 100);
  assert.equal(reconcileBatchMs('5000'), 5000);
  for (const bad of ['99', '5001', 'abc', '', '1.5', '-1']) assert.equal(reconcileBatchMs(bad), 250, bad);
});

// 2026-10-02: a fixed 12-connection pool, half lent to reconciliation and up to half to observation
// workers, starved webhooks, heartbeats and claims while Postgres allowed 500 connections.
test('unit:server-pool-sizes-configurable — the server database pools default to 30/6/4 and each is set by its own variable within range', () => {
  assert.deepEqual(serverPoolSizes({}), { max: 30, leaseMax: 6, reportMax: 4 });
  assert.deepEqual(serverPoolSizes({ GRAPHYARD_DB_POOL_MAX: '60', GRAPHYARD_DB_LEASE_POOL_MAX: '8', GRAPHYARD_DB_REPORT_POOL_MAX: '5' }), { max: 60, leaseMax: 8, reportMax: 5 });
  for (const bad of ['1', '201', 'abc', '', '2.5', '-4']) assert.equal(serverPoolSizes({ GRAPHYARD_DB_POOL_MAX: bad }).max, 30, bad);
  assert.equal(serverPoolSizes({ GRAPHYARD_DB_LEASE_POOL_MAX: '51' }).leaseMax, 6);
});
