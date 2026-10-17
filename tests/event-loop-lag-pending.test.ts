import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventLoopLag } from '../src/engine.js';

// GY-1886: the sampler records a sample only when its 10 ms timer callback runs, so a hold of the
// loop that ended just before read() — the callback that elapsed during the hold still queued
// behind the caller's own work — went unrecorded, and the tick read no lag at all: run 39014555162
// saw `a 200 ms hold of the loop shows as lag: {"p50":0,"max":0}` pass on a rerun. read() now
// counts the overrun the next callback is still owed when the window is read, so a block is seen
// however the event loop orders the read against the timers phase.

test('unit:event-loop-lag-counts-pending-overrun — a block that ends just before the window is read, before any timer callback can run, is the lag the read reports', async () => {
  // start(), the hold and the read run in one synchronous stretch, so no timer callback can run
  // between them: the sampler's own history is empty, and only the overrun still pending at the
  // read can tell the block happened.
  const starved = new EventLoopLag();
  starved.start();
  const until = performance.now() + 200;
  while (performance.now() < until) { /* hold the loop: the block the read must still see */ }
  const lag = starved.read();
  starved.stop();
  assert.ok(lag && lag.max >= 150, `a 200 ms hold of the loop ending just before the read shows as lag: ${JSON.stringify(lag)}`);

  // A window read with no block holds the timer's ordinary overruns only.
  const quiet = new EventLoopLag();
  quiet.start();
  await new Promise(resolve => setTimeout(resolve, 120));
  const calm = quiet.read();
  quiet.stop();
  assert.ok(calm && calm.max < 50, `a window read with no block reads no starvation: ${JSON.stringify(calm)}`);
});
