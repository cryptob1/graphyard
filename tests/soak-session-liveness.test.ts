import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minute } from './helpers/soak-world.js';
import { basePlan, soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';

/**
 * Session liveness (GY-1561) across the real loop's cycles. One concern of the release-candidate soak
 * (GY-404), split per concern (GY-1363). GY-1525's launches were blocked on a dialog before their
 * runtime started; each ended its session record "the launch failed before the session started" with
 * no pane while its epoch's lease still ran, and master status raised "Assigned worker session is
 * ended" for it on every cycle of that window — one failed launch counted as its dispatch's failure
 * and again as session faults. Here an item's first two launches fail that way and each claim
 * outlives its record by several cycles: every failure is its dispatch's, counted once, no cycle
 * raises a session fault for it, the item is delivered, the workers that genuinely started and died
 * are still session faults, and every system invariant holds after every cycle.
 */
soakControlPlanes('soak-session-liveness', 420);

test('unit:soak-invariants-hold — a launch that failed before its session started, under a lease that outlives it for several cycles, is its dispatch\'s one fault and never a session fault, while a worker that started and died still is, and every invariant holds', { timeout: 600_000 }, async () => {
  const blockedItem = 14, launches = 2, holdMs = 6 * minute;
  const day = await simulateDay({ hours: 5, failedLaunch: { item: blockedItem, launches, holdMs } });
  const { violations, failures, state, items, final, failedLaunches, cycles, dayStart } = day;
  assert.deepEqual(violations, [], 'every system invariant holds');
  assert.deepEqual(failures, [], 'no cycle failed');
  const blocked = items[blockedItem - 1].key;
  assert.equal(failedLaunches.launches.length, launches, `the item's first ${launches} launches failed before their sessions started`);
  assert.deepEqual(failedLaunches.held, [], 'and every claim they left was released');
  assert.ok(cycles >= launches * holdMs / minute, 'the loop cycled through each window the lease outlived its record');
  // The windows each failed launch's claim held its item: from the launch until the claim was released.
  const windows = failedLaunches.launches.map(launch => ({ from: dayStart + launch.at, to: dayStart + launch.at + holdMs }));
  const inWindow = (at: string) => windows.some(window => Date.parse(at) >= window.from && Date.parse(at) <= window.to + minute);
  const instances = state.faults.instances.filter(instance => instance.subject === blocked && inWindow(instance.at));
  assert.deepEqual(instances.filter(instance => instance.kind === 'session'), [], 'no cycle raised a session fault for a launch that never started (the base raised "Assigned worker session is finished")');
  const dispatched = instances.filter(instance => instance.kind === 'action:dispatch');
  assert.ok(dispatched.length >= 1 && dispatched.length <= launches, `each failed launch is its dispatch's fault, counted at most once: ${dispatched.length}`);
  assert.ok(instances.filter(instance => instance.faultClass === 'session-liveness').length <= launches, 'the class counts the incident no more than once per failed launch');
  // A worker that started and then died under its live lease is still the session fault it was.
  const died = [...basePlan.deaths].map(n => items[n - 1].key);
  assert.ok(state.faults.instances.some(instance => instance.kind === 'session' && instance.faultClass === 'session-liveness' && died.includes(instance.subject)),
    `a worker that started and died is still a session-liveness fault: ${JSON.stringify(state.faults.instances.filter(instance => died.includes(instance.subject)).map(instance => instance.kind))}`);
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'every item is delivered, the blocked one on its third launch');
});
