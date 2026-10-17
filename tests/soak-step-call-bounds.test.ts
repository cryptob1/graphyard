import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hour, minute } from './helpers/soak-world.js';
import { basePlan, coordinatorRoot, soakConfig, soakControlPlanes } from './helpers/soak-plane.js';
import { assertLaunchesConfined, simulateDay } from './helpers/soak-simulation.js';

/**
 * GY-1774 at system scale: the shared step bound (src/daemon/step-budget.ts) over a simulated day
 * whose approver, decision and session calls all answer slower than the per-call bound — pane
 * closes, approver launches, re-prompts, decisions and observation wakes, across every item at
 * once — so each bounded step carries calls to the next cycle, which joins the call still in
 * flight or consumes its kept answer. The bound itself is unit-proven (tests/step-call-bounds.test.ts);
 * the day proves the loop around it: every cycle stays inside the run interval, a carried call is no
 * fault, calls are carried and then settle, every item is still delivered, and every system
 * invariant holds, cycle-p90 included.
 */
soakControlPlanes('soak-step-call-bounds', 443);

const carried = /per-(?:decision|call) bound passed|step's budget passed/;

test('unit:soak-invariants-hold — a day of approver, decision and session calls slower than the per-call bound keeps every cycle inside the interval, files no fault for a carried call, carries and settles the calls, and holds every invariant, cycle-p90 included', { timeout: 600_000 }, async () => {
  // From half an hour in, every bounded call answers in 15 s — past the 10 s per-call bound — so each
  // step cuts it, leaves its work owed with the carried attempt recorded, and the next cycle retries it.
  // GY-1865 review: the day also holds the docs-conflict item's readings late (GY-1537), so its rework
  // waits and the decisions step wakes its observation job — a wake the window slows past the per-call
  // bound and carries, on an item whose wakes answer with nothing, so it is decided without another
  // wake and the row it carried must settle instead of waiting forever.
  const day = await simulateDay({ hours: 5, lateReading: true, slowCalls: { from: 30 * minute, to: 150 * minute, ms: 15_000 }, plan: basePlan });
  assertLaunchesConfined(day, coordinatorRoot!);
  const { violations, failures, lost, final, state, observed, budgetDay, items, wakes } = day;
  assert.deepEqual(violations, [], 'every system invariant holds while calls answer slower than the bound and once the plane is fast');
  assert.ok(observed.has('cycle-p90'), 'cycle-p90 is judged on measured cycles, not vacuously');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'every item is delivered');
  // The bound's economy: the window slowed calls of more than one step, and every cycle it touched stays inside the run interval.
  assert.ok(budgetDay.slowCalls, 'the window slowed the steps\' calls');
  assert.ok(Object.keys(budgetDay.slowed).length >= 2, `calls of several kinds were slowed: ${JSON.stringify(budgetDay.slowed)}`);
  // Round 3: the steps' other external calls — reads, records, probes — are slowed and carried like their approver, decision and session calls.
  const sessionCalls = ['closeSession', 'approver', 'decide', 'promptSession', 'wakeObservation', 'decideScope', 'widenScope', 'withdrawReview', 'endSession'];
  assert.ok(Object.keys(budgetDay.slowed).some(name => !sessionCalls.includes(name)), `calls beyond the approver, decision and session ones were slowed: ${JSON.stringify(budgetDay.slowed)}`);
  // GY-1865 review: the window demonstrably carried a decisions-step observation wake — the conflicted
  // item's rework wake, cut by the per-call bound — and the item is decided without another wake: its
  // wakes answer with nothing, so none was ever sent for it, and the row its carry recorded still
  // settles, which the nothing-stays-carried assertion below proves: no orphaned row remains.
  assert.ok((budgetDay.slowed.wakeObservation ?? 0) >= 1, `the slow window carried a decisions-step observation wake: ${JSON.stringify(budgetDay.slowed)}`);
  const conflicted = items[basePlan.docsConflict.item - 1];
  assert.ok(budgetDay.wakeRows.some(row => row.key === `wake:observation:${conflicted.id}`), `the conflicted item's observation wake ran: ${JSON.stringify(budgetDay.wakeRows)}`);
  assert.deepEqual(wakes.filter(wake => wake.key === conflicted.key).map(wake => wake.key), [], 'the item was decided without another wake: no wake was ever sent for it');
  assert.equal(final.find(entry => entry.key === conflicted.key)!.stage, 'done', 'the item the carried wake served is delivered');
  const intervalMs = soakConfig.run.intervalSeconds * 1000;
  assert.deepEqual(budgetDay.cycles.filter(entry => entry.spentMs > intervalMs).map(entry => `cycle ${entry.cycle}: ${entry.spentMs}ms, ${entry.slow} slow calls`), [], 'every cycle stays within the interval');
  // Calls were carried while the plane was slow, and none stays carried once it is fast again: each was joined or its answer consumed, and its work settled.
  assert.ok(budgetDay.cycles.some(entry => entry.carried > 0), 'the slow window carried calls to the next cycle');
  assert.equal(budgetDay.cycles.at(-1)!.carried, 0, `nothing stays carried at the end of the day: ${JSON.stringify(Object.entries(state.actions).filter(([, row]) => row.state === 'waiting' && carried.test(row.detail)))}`);
  // A carried call judged nothing: no fault carries a bound message, however often the bound fired.
  assert.deepEqual(state.faults.instances.filter(instance => carried.test(instance.text)), [], 'no fault is filed for a carried call');
});

test('unit:soak-invariants-hold — goals drafted, judged and planned while the acceptance and planner calls answer slower than the bound carry the triage phases, hold no cycle past the interval, and are all delivered', { timeout: 900_000 }, async () => {
  const day = await simulateDay({ hours: 14, acceptance: true, planner: true, slowCalls: { from: 20 * minute, to: 60 * minute, ms: 15_000 }, plan: { ...basePlan, deploys: [2 * hour + 30 * minute, 5 * hour, 9 * hour, 11 * hour, 13 * hour] } });
  const { violations, failures, lost, state, budgetDay } = day;
  assert.deepEqual(violations, [], 'every system invariant holds while the nested phases are slow');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  assert.ok(Object.keys(budgetDay.slowed).some(name => /^(?:acceptance|planner)\./.test(name)), `the acceptance and planner calls were slowed: ${JSON.stringify(budgetDay.slowed)}`);
  const intervalMs = soakConfig.run.intervalSeconds * 1000;
  assert.deepEqual(budgetDay.cycles.filter(entry => entry.spentMs > intervalMs).map(entry => `cycle ${entry.cycle}: ${entry.spentMs}ms`), [], 'every cycle stays within the interval');
  assert.ok(Object.keys(state.actions).some(key => /^carried:triage:(?:acceptance|planner)$/.test(key)), 'a slow nested phase was carried to the next cycle');
  assert.equal(budgetDay.cycles.at(-1)!.carried, 0, `no phase stays carried at the end of the day: ${JSON.stringify(Object.entries(state.actions).filter(([, row]) => row.state === 'waiting' && carried.test(row.detail)))}`);
  assert.deepEqual(state.faults.instances.filter(instance => carried.test(instance.text)), [], 'no fault is filed for a carried phase');
});
