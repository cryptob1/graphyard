import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minute } from './helpers/soak-world.js';
import { basePlan, coordinatorRoot, soakConfig, soakControlPlanes } from './helpers/soak-plane.js';
import { assertLaunchesConfined, simulateDay } from './helpers/soak-simulation.js';

/**
 * The decisions step's per-decision bound (GY-1766) at system scale: a simulated day whose decision
 * calls answer slower than the bound, over several items owing rework, attest and merge decisions —
 * so the decision an item owes changes while an older call is still unanswered. The bound itself is
 * unit-proven (tests/decisions-step-bound.test.ts: a call past it returns the step, the decision
 * stays owed and its retry joins the call it belongs to); the day proves the loop around it: every
 * cycle stays inside the run interval, a carried call is no fault, and every system invariant
 * holds, cycle-p90 included.
 */
soakControlPlanes('soak-decisions-call-bound', 438);

const carried = /per-decision bound passed|step's budget passed/;

test('unit:soak-invariants-hold — a day of decision calls slower than the per-decision bound keeps every cycle inside the interval, files no fault for a carried call and holds every invariant, cycle-p90 included', { timeout: 600_000 }, async () => {
  // From half an hour in, every decision call answers in 15 s — past the 10 s per-decision bound,
  // so the step cuts it, leaves the decision owed and retries it next cycle, while the rest of the
  // cycle keeps its share of the interval.
  const day = await simulateDay({ hours: 5, slowDecisions: { from: 30 * minute, to: 150 * minute, ms: 15_000 }, plan: basePlan });
  assertLaunchesConfined(day, coordinatorRoot!);
  const { violations, failures, lost, final, state, decideCalls, observed, budgetDay } = day;
  assert.deepEqual(violations, [], 'every system invariant holds while calls answer slower than the bound and once the plane is fast');
  assert.ok(observed.has('cycle-p90'), 'cycle-p90 is judged on measured cycles, not vacuously');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'every item is delivered');
  // The bound's economy: the window slowed the step's calls, and every cycle it touched stays inside the run interval.
  assert.ok(budgetDay.slowCalls, 'the window slowed the decisions step\'s calls');
  const intervalMs = soakConfig.run.intervalSeconds * 1000;
  assert.deepEqual(budgetDay.cycles.filter(entry => entry.spentMs > intervalMs).map(entry => `cycle ${entry.cycle}: ${entry.spentMs}ms, ${entry.slow} slow calls`), [], 'every cycle stays within the interval');
  // A carried call judged nothing: no decision fault carries a bound message, however often the bound fired.
  assert.deepEqual(state.faults.instances.filter(instance => carried.test(instance.text)), [], 'no fault is filed for a carried call');
  // Changing decisions: more than one item owes a rework across the day, and each owes it against the head it stood on when the request went out.
  const reworkKeys = new Set(decideCalls.filter(call => call.action === 'rework').map(call => call.key));
  assert.ok(reworkKeys.size >= 2, `several items owe rework decisions across the day: ${JSON.stringify([...reworkKeys])}`);
});
