import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hour, minute } from './helpers/soak-world.js';
import { basePlan, soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';

/** One concern of the day (GY-1363), in its own file: the world is tests/helpers/soak-world.ts, the control planes tests/helpers/soak-plane.ts, the day tests/helpers/soak-simulation.ts (`blockedHolds`), and the system invariants are asserted after every cycle. */
soakControlPlanes('soak-observation-window', 442);

const items = 5;
const plan = { items, releaseEveryMs: 5 * minute, leftovers: 0, slowRecompute: 0, workMs: 15 * minute, rework: new Set<number>(), deaths: new Set<number>(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set<number>(), misread: new Set<number>(), exits: new Set<number>(), spentProducer: 0, lostRuns: 0,
  outOfQueue: { item: items, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: items }, loopRestarts: [] as number[], dirtyCheckout: { from: 99 * hour, to: 100 * hour }, headMove: { from: 99 * hour, to: 100 * hour }, deploys: basePlan.deploys };

/**
 * GY-1740 under the real loop: three post-deploy follow-ups were each blocked by their first worker on a
 * reading that cannot exist before an instant 6, 14 and 22 hours into the day, as GY-1689, GY-1721 and
 * GY-1724 were. No worker can `defer` them (none holds a lease), so the loop's blocker step holds each
 * on its instant itself (`window`). Every cycle samples each one: held once, out of Blocked from the first
 * cycle with no worker launch, never dispatched or overdue before its instant, and past it left to the
 * loop's reading with no dispatch requested (GY-1762).
 */
test('unit:soak-invariants-hold — over a simulated day of the real loop, blocked unleased post-deploy follow-ups whose blockers name future instants are each held on their instant once, leave Blocked without a worker launch, stay undispatched and not overdue until it, request no dispatch past it while they await the loop\'s reading, and every system invariant holds', { timeout: 600_000 }, async () => {
  const hours = [6, 14, 22];
  const day = await simulateDay({ hours: 26, plan, blockedHolds: { hours } });
  const holds = day.blockedHoldDay!, iso = (ms: number) => new Date(ms).toISOString();
  assert.deepEqual(day.violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(day.failures, [], 'no cycle failed');
  assert.deepEqual(day.lost, [], 'no lease was lost');
  assert.equal(holds.seeded.length, hours.length);
  // Each is held exactly once, on the instant its blocker names, by the loop's first cycle.
  assert.deepEqual(holds.windows.map(entry => [entry.key, entry.notBefore]).sort(), holds.seeded.map(entry => [entry.key, iso(entry.notBefore)]).sort(), `each follow-up was held once: ${JSON.stringify(holds.windows)}`);
  assert.ok(holds.windows.every(entry => entry.at - day.dayStart < 2 * minute), 'on the loop\'s first cycle');
  for (const seeded of holds.seeded) {
    const samples = holds.samples.filter(sample => sample.key === seeded.key);
    const before = samples.filter(sample => Date.parse(sample.at) < seeded.notBefore), after = samples.filter(sample => Date.parse(sample.at) >= seeded.notBefore);
    assert.ok(before.length >= 30, `${seeded.key}: the loop cycled across its held hours: ${before.length} cycles`);
    // The seeded first attempt's own dispatch, requested before the loop's first cycle; every later one is new.
    // GY-1762: the loop requests no further dispatch; at most the seeded first attempt's own is on record.
    const seededDispatches = before[0]!.dispatches;
    assert.ok(seededDispatches.length <= 1, `${seeded.key}: only its seeded first attempt was ever dispatched`);
    const later = (sample: (typeof samples)[number]) => sample.dispatches.slice(seededDispatches.length);
    for (const sample of before) {
      const label = `${seeded.key} at ${sample.at}`;
      assert.deepEqual([sample.blocker, sample.window, sample.stage], [null, iso(seeded.notBefore), 'ready'], `${label}: its blocker is gone and its window holds it`);
      assert.notEqual(sample.group, 'blocked', `${label}: not in the Blocked group`);
      assert.equal(sample.overdue, false, `${label}: not overdue`);
      assert.deepEqual([sample.lease, sample.sessions, later(sample), sample.faults, sample.escalations], [null, 0, [], [], []], `${label}: no lease, no worker launch, no dispatch, no fault, no escalation`);
    }
    assert.ok(after.length > 0, `${seeded.key}: the day ran past its instant`);
    // GY-1762: past its instant the reading is owed to the loop; no worker is dispatched or launched, and no fault is raised.
    assert.deepEqual(after.flatMap(later), [], `${seeded.key}: no dispatch is requested past its instant`);
    assert.equal(Math.max(...after.map(sample => sample.sessions)), 0, `${seeded.key}: no worker session is launched for it`);
    for (const sample of after) assert.deepEqual([sample.faults, sample.blocker, sample.stage], [[], null, 'ready'], `${sample.key} at ${sample.at}: no fault, still released and awaiting the reading`);
    assert.equal(holds.final.find(item => item.key === seeded.key)!.stage, 'ready', `${seeded.key} awaits the loop's reading`);
  }
});
