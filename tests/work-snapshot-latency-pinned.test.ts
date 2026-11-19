import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interleavedSteadyState, percentile } from './helpers/timing.js';

// GY-3546: hot-path-latency-bounded judged GET /api/status against half the full list's time, but
// timed the list in its own three reads before the status reads began, so load that changed between
// the two phases moved the budget (139 ms against 142 ms measured on 9b15d8686f59). Each round now
// times every read once, so a baseline and the reads it bounds see the same load.

test('unit:work-snapshot-latency-pinned — a baseline and the reads it bounds are timed round by round, so load that rises during the run keeps their ratio', async () => {
  let now = 0, calls = 0;
  // A runner that gets busier with every read: the twentieth read costs three times the first.
  const read = (cost: number) => async () => { now += cost * (1 + calls++ / 10); };
  const order: string[] = [];
  const timed = await interleavedSteadyState({
    list: async () => { order.push('list'); await read(200)(); },
    status: async () => { order.push('status'); await read(90)(); },
  }, { warmup: 1, samples: 9, clock: () => now });
  assert.deepEqual(order.slice(0, 4), ['list', 'status', 'list', 'status']);
  assert.equal(timed.list.warmup.length, 1); assert.equal(timed.list.samples.length, 9); assert.equal(timed.status.samples.length, 9);
  const ratio = percentile(timed.status.samples, 0.5) / percentile(timed.list.samples, 0.5);
  assert.ok(ratio < 0.5, `status took ${ratio.toFixed(3)} of the list's time; its own cost is 0.45`);
});
