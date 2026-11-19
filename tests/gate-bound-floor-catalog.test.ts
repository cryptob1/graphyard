import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapGate, gateBoundMs, gateCeilingMs, gateLimitMs, runGate, type GatePorts } from '../src/batch-gate.js';

// GY-3523: with no verified run the bound stayed at the 45-minute floor, so a 55-minute catalog
// timed out every time and never earned a sample. The floor is now 1.5 times the recorded
// whole-catalog time when that is longer, within the 90-minute ceiling.

const verified = 'a'.repeat(40), tip = 'b'.repeat(40), minute = 60_000;
const runs = (...minutes: number[]) => minutes.map((ms, index) => ({ ms: ms * minute, at: `2026-11-1${index}T08:00:00Z` }));

test('unit:gate-bound-floor-catalog — the floor is 1.5 times the recorded catalog time, within the ceiling', () => {
  assert.equal(gateBoundMs({ verifiedRuns: [], catalogMs: 55 * minute }), 82.5 * minute, 'no samples, a 55-minute catalog: about 83 minutes');
  assert.equal(gateBoundMs({ verifiedRuns: runs(20, 22, 25), catalogMs: 55 * minute }), 82.5 * minute, 'verified runs shorter than the catalog do not lower it');
  assert.equal(gateBoundMs({ verifiedRuns: runs(44, 45, 46), catalogMs: 55 * minute }), gateCeilingMs, 'a longer verified median still wins, at most the ceiling');
  assert.equal(gateBoundMs({ verifiedRuns: [], catalogMs: 70 * minute }), gateCeilingMs, '1.5 times a 70-minute catalog stops at 90 minutes');
  assert.equal(gateBoundMs({ verifiedRuns: [], catalogMs: 222 * minute }), gateLimitMs, 'a catalog time above the ceiling is not trusted');
  assert.equal(gateBoundMs({ verifiedRuns: [], catalogMs: 20 * minute }), gateLimitMs, 'a short catalog never lowers the 45-minute floor');
  assert.equal(gateBoundMs({ verifiedRuns: [], catalogMs: null }), gateLimitMs);
});

test('e2e:gate-bound-floor-catalog — a gate longer than 45 minutes and shorter than 1.5 times its catalog verifies', async () => {
  let clock = Date.parse('2026-11-18T08:00:00Z');
  const limits: number[] = [];
  const ports: GatePorts = {
    now: () => clock, fetch: async () => tip, landings: async () => [], files: async () => ['src/a.ts'], catalog: async () => [], core: async () => [],
    run: async (_commit, _checks, _files, timeoutMs) => { limits.push(timeoutMs); clock += 60 * minute; return []; },
    waiting: () => false, revert: async () => { throw new Error('unused'); }, file: async () => ({ item: null }),
  };
  const record = { ...bootstrapGate('owner/project', verified), catalogMs: 55 * minute };
  const outcome = await runGate(ports, record);
  assert.equal(outcome.outcome, 'verified', 'a 60-minute run fits the 82.5-minute bound');
  assert.equal(limits[0], 82.5 * minute, 'the trial gets the catalog-based bound');
  assert.equal(record.verifiedRuns!.at(-1)!.ms, 60 * minute, 'the run becomes the first verified sample');
});
