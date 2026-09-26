import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileBatchMs } from '../src/server/main.js';

// 2026-09-26: at ~700 items each 250 ms reconcile batch re-read the whole fleet, ticks took ~30 s and
// every request queued behind them; installations need to tune the batch without a code change.
test('unit:reconcile-batch-configurable — GRAPHYARD_RECONCILE_BATCH_MS sets the reconcile batch within 100..5000 ms, and anything else keeps 250', () => {
  assert.equal(reconcileBatchMs(undefined), 250);
  assert.equal(reconcileBatchMs('1000'), 1000);
  assert.equal(reconcileBatchMs('100'), 100);
  assert.equal(reconcileBatchMs('5000'), 5000);
  for (const bad of ['99', '5001', 'abc', '', '1.5', '-1']) assert.equal(reconcileBatchMs(bad), 250, bad);
});
