import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minute, hour } from './helpers/soak-world.js';
import { blockerPlan, coordinatorRoot, soakControlPlanes } from './helpers/soak-plane.js';
import { assertLaunchesConfined, simulateDay } from './helpers/soak-simulation.js';

/**
 * GY-1758 (manual:fault-class-stalled-gate): the real loop (runCycle) over a simulated day while a
 * plane-wide timeout of the blocker-probe record and a dispatch refused for a human-only park
 * repeat every cycle for hours, across the day's items. Both are waits, so neither files a
 * stalled-gate instance or a stalled action, every system invariant holds, no cycle fails, and
 * the waits resolve: the items are delivered once the window closes.
 */
soakControlPlanes('soak-stalled-gate-waits', 418);

test('unit:soak-invariants-hold — repeated plane-wide timeouts of the blocker record and human-only dispatch refusals file no stalled-gate instance, retries stay bounded, and the items still deliver with every invariant holding', { timeout: 900_000 }, async () => {
  const day = await simulateDay({
    hours: 5, blockers: true, waits: { from: 20 * minute, to: 150 * minute },
    plan: { items: blockerPlan.items, releaseEveryMs: 5 * minute, leftovers: 2, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, outOfQueue: { item: 9, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 9 } },
  });
  assertLaunchesConfined(day, coordinatorRoot!);
  const { violations, failures, state, waitsDay, cycles, items, final } = day;
  assert.deepEqual(violations, [], 'every system invariant holds');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.ok(waitsDay.parked >= 10, `dispatch was refused as a human-only park across many cycles and items: ${waitsDay.parked}`);
  assert.ok(waitsDay.parked <= cycles * items.length, `the refusals stay bounded by one per item per cycle: ${waitsDay.parked}`);
  // The day's designed blockers file their own stalled-gate instances; what the waits would add is read by their text.
  const wait = /aborted due to timeout|human-only decision/;
  assert.ok(waitsDay.timeouts > 0, `the blocker record timed out: ${waitsDay.timeouts}`);
  assert.deepEqual(state.faults.instances.filter(instance => instance.faultClass === 'stalled-gate' && wait.test(instance.text)).map(instance => instance.id), [], 'the waits file no stalled-gate instance');
  assert.deepEqual(state.faults.instances.filter(instance => instance.kind === 'stalled-action' && wait.test(instance.text)).map(instance => instance.id), [], 'the waits file no stalled-action instance');
  assert.deepEqual(Object.entries(state.actions).filter(([, action]) => action.faultClass === 'stalled-gate' && wait.test(action.detail)).map(([key]) => key), [], 'no stored wait action is classed a stalled gate');
  assert.deepEqual(final.filter(item => !['done'].includes(item.stage) && !item.blocker).map(item => `${item.key} ${item.stage}`), [], 'every item that is not held by a designed blocker is delivered once the waits resolve');
});
