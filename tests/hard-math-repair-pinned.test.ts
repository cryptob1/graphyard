import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { serialReads } from '../benchmarks/hard-math/snapshot.js';

// GY-3422: the batch gate's check test:tests/hard-math-repair.test.ts failed once and passed its
// re-run. The runner's budget watchdog snapshots every 250 ms, and a snapshot taken while one was
// in flight joined it, so the fixture's snapshot after its last merge could return the item
// without that merge and fail `every(w=>w.merge)`.
test('unit:hard-math-repair-pinned — a snapshot requested while another is in flight observes writes made before the request', async () => {
  let merged = false;
  const read = serialReads(async () => { const seen = merged; await delay(20); return seen; });
  const watchdog = read();
  await delay(5);
  merged = true;
  assert.equal(await read(), true, 'the caller sees its own merge, not the in-flight read begun before it');
  assert.equal(await watchdog, false);
});
