import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapGate, gateBoundMs, gateCeilingMs, gateLimitMs, runGate, type GatePorts, type GateRecord } from '../src/batch-gate.js';

// GY-3507: on vishrog on 2026-11-18 a batch gate ran from 07:12 with a 16.7-hour trial timeout on a
// cool host: its bound was 1.5x the diagnostics' catalog time, a wall-clock figure that waits and
// slow runs had inflated. The bound is now twice the median own execution time of the last verified
// runs, never under the 45-minute cold-start limit nor over 90 minutes.

const verified = 'a'.repeat(40), tip = 'b'.repeat(40);
const minute = 60_000;
const runs = (...minutes: number[]) => minutes.map((ms, index) => ({ ms: ms * minute, at: `2026-11-1${index}T08:00:00Z` }));

/** One gate over a batch whose single trial run waits `waitMs` for a slot, then works `workMs`, and passes. */
async function gate(record: GateRecord, workMs: number, waitMs = 0) {
  let clock = Date.parse('2026-11-18T08:00:00Z'), waiting = false;
  const limits: number[] = [];
  const ports: GatePorts = {
    now: () => clock, fetch: async () => tip, landings: async () => [], files: async () => ['src/a.ts'], catalog: async () => [], core: async () => [],
    run: async (_commit, _checks, _files, timeoutMs) => {
      limits.push(timeoutMs);
      if (waitMs) { waiting = true; clock += waitMs; await new Promise(resolve => setTimeout(resolve, 1300)); waiting = false; }
      clock += workMs; return [];
    },
    waiting: () => waiting, revert: async () => { throw new Error('unused'); }, file: async () => ({ item: null }),
  };
  return { outcome: await runGate(ports, record), limits };
}

test('integration:batch-gate-median-bound — recorded verified runs set the bound at twice their median: a slow outlier, a huge diagnostics catalog time and the ceiling cannot stretch it', () => {
  assert.equal(gateBoundMs({ verifiedRuns: runs(20, 22, 25, 28, 30) }), 50 * minute, 'twice the 25-minute median');
  assert.equal(gateBoundMs({ verifiedRuns: runs(30, 32, 35, 38, 400) }), 70 * minute, 'one 400-minute outlier moves nothing');
  assert.equal(gateBoundMs({ verifiedRuns: runs(30, 40) }), 70 * minute, 'an even count takes the middle two');
  assert.equal(gateBoundMs({ verifiedRuns: runs(61, 70, 80, 95, 110) }), gateCeilingMs, 'slow verified runs still stop at 90 minutes');
  assert.equal(gateBoundMs({ verifiedRuns: runs(5, 6, 7) }), gateLimitMs, 'a fast history never bounds a larger batch under 45 minutes');
  const inflated = { ...bootstrapGate('owner/project', verified), catalogMs: 222 * minute, gateRuns: runs(300, 400) };
  assert.equal(gateBoundMs(inflated), gateLimitMs, 'cold start: with no verified run the 45-minute limit, whatever the catalog measured');
  assert.equal(gateCeilingMs, 90 * minute);
});

test('integration:batch-gate-median-bound — a verified run samples its own time without its waits; repeated slow timeouts sample nothing, so the bound stays put', async () => {
  const record = { ...bootstrapGate('owner/project', verified), verifiedRuns: runs(30, 32, 35, 38) };
  const waited = await gate(record, 34 * minute, 60 * minute);
  assert.equal(waited.outcome.outcome, 'verified', '60 minutes waiting for a slot plus 34 of work is inside the 67-minute bound');
  assert.equal(record.verifiedRuns!.at(-1)!.ms, 34 * minute, 'the sample is the run\'s own time, its wait left out');
  assert.equal(gateBoundMs(record), 68 * minute);

  record.verified = verified;
  for (let attempt = 0; attempt < 4; attempt++) {
    const slow = await gate(record, 200 * minute);
    assert.equal(slow.outcome.outcome, 'timeout');
    assert.equal(slow.outcome.outcome === 'timeout' && slow.outcome.boundMs, 68 * minute, 'each slow unverified attempt meets the same bound');
    assert.ok(slow.limits[0]! <= 3 * 68 * minute, `the trial gets the bound plus a two-bound backstop, never hours more (${slow.limits[0]} ms)`);
  }
  assert.equal(record.verifiedRuns!.length, 5, 'no timeout became a sample');
  assert.equal(gateBoundMs(record), 68 * minute);
});

test('integration:batch-gate-median-bound — cold start is bounded: no verified run gives a 45-minute bound that a 46-minute run meets', async () => {
  const cold = await gate({ ...bootstrapGate('owner/project', verified), catalogMs: 222 * minute }, 46 * minute);
  assert.equal(cold.outcome.outcome, 'timeout');
  assert.equal(cold.outcome.outcome === 'timeout' && cold.outcome.boundMs, gateLimitMs);
  assert.equal(cold.limits[0], 3 * gateLimitMs, 'the trial gets the 45 minutes plus a backstop of two bounds; the gate\'s own clock stops it');
});
