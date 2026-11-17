import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapGate, gateLimitMs, runGate, type GatePorts, type GateRecord } from '../src/batch-gate.js';

// GY-3444 AC-4: on vishrog on 2026-11-17 the full catalog measured 61 minutes against a fixed
// 45-minute gate bound, so no gate run could finish. The bound now follows the catalog: at least
// 1.5x the last measured full catalog time, never under the 45 minutes.

const verified = 'a'.repeat(40), tip = 'b'.repeat(40);
const minute = 60_000;

/** One gate over a batch whose single trial run takes `runMs` of the gate's clock and passes. */
async function gate(record: GateRecord, runMs: number) {
  let clock = Date.parse('2026-11-17T08:00:00Z');
  const limits: number[] = [];
  const ports: GatePorts = {
    now: () => clock, fetch: async () => tip, landings: async () => [], files: async () => ['src/a.ts'], catalog: async () => [], core: async () => [],
    run: async (_commit, _checks, _files, timeoutMs) => { limits.push(timeoutMs); clock += runMs; return []; },
    revert: async () => { throw new Error('unused'); }, file: async () => ({ item: null }),
  };
  return { outcome: await runGate(ports, record), limits };
}

test('integration:batch-gate-bound-follows-catalog — with a 61-minute measured catalog the gate bound is 1.5x it, so a 70-minute run on a loaded host finishes and verifies instead of timing out', async () => {
  const catalogMs = 61 * minute;
  const { outcome, limits } = await gate({ ...bootstrapGate('owner/project', verified), catalogMs }, 70 * minute);
  assert.equal(outcome.outcome, 'verified', 'a run longer than 45 minutes but inside 1.5x the catalog is not timed out');
  assert.ok(limits[0]! >= 1.5 * catalogMs, `the trial is bounded by at least 1.5x the catalog (${limits[0]} ms)`);
});

test('integration:batch-gate-bound-follows-catalog — past 1.5x the catalog the run still times out, naming its bound; with no measured catalog the 45-minute limit stands', async () => {
  const slow = await gate({ ...bootstrapGate('owner/project', verified), catalogMs: 61 * minute }, 92 * minute);
  assert.equal(slow.outcome.outcome, 'timeout');
  assert.equal(slow.outcome.outcome === 'timeout' && slow.outcome.boundMs, Math.ceil(1.5 * 61 * minute));
  const unmeasured = await gate(bootstrapGate('owner/project', verified), 46 * minute);
  assert.equal(unmeasured.outcome.outcome, 'timeout', 'no catalog measured: the 45-minute limit');
  assert.equal(unmeasured.limits[0], gateLimitMs);
  const fast = await gate({ ...bootstrapGate('owner/project', verified), catalogMs: 10 * minute }, 46 * minute);
  assert.equal(fast.outcome.outcome, 'timeout', 'a short catalog never lowers the bound under 45 minutes, nor raises it');
});
