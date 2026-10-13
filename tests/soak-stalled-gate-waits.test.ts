import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minute } from './helpers/soak-world.js';
import { coordinatorRoot, soakControlPlanes } from './helpers/soak-plane.js';
import { assertLaunchesConfined, simulateDay } from './helpers/soak-simulation.js';

/**
 * GY-1758 (manual:fault-class-stalled-gate): the real loop (runCycle) over a simulated day while a
 * plane-wide failure of a control-plane call repeats every cycle for hours, across the day's
 * items. It is a wait, so it files no stalled-gate instance, every system invariant holds, no
 * cycle fails, the call answers and the items are delivered once the plane does.
 */
soakControlPlanes('soak-stalled-gate-waits', 417);

test('unit:soak-invariants-hold — a registry reconcile refused plane-wide cycle after cycle for hours files no stalled-gate instance and the items still deliver, with every invariant holding', { timeout: 600_000 }, async () => {
  const day = await simulateDay({ hours: 6, readiness: { from: 10 * minute, to: 150 * minute } });
  assertLaunchesConfined(day, coordinatorRoot!);
  const { violations, failures, state, readinessDay, final } = day;
  assert.deepEqual(violations, [], 'every system invariant holds');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.ok(readinessDay.refused >= 20, `the plane refused across many cycles: ${readinessDay.refused}`);
  assert.ok(readinessDay.answered > 0, 'and then answered');
  assert.deepEqual(state.faults.instances.filter(instance => instance.faultClass === 'stalled-gate' && /agent registry|Startup validation|registry/.test(`${instance.subject} ${instance.text}`)), [], 'the wait files no stalled-gate instance');
  assert.ok(!Object.values(state.actions).some(action => action.faultClass === 'stalled-gate' && /Startup validation/.test(action.detail)), 'no stored action classes it as a stalled gate');
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'every item is delivered');
});
