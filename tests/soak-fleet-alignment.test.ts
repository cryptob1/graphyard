import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hour, minute } from './helpers/soak-world.js';
import { soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';
import { selfUpgradeBoundMs } from '../src/master-resources.js';

/**
 * GY-1619 under the real loop for a simulated day: the fleet report master status builds
 * (executorFleetReport, read with the held-CLI pin and the restart the cursor owes) feeds the
 * loop's own fault step every cycle, while the self-upgrade of soak-release-lag holds each restart
 * until production serves it. The executors run the release their last restart loaded, so every
 * advance leaves them split from the checkout through the hold, the pin, the lifted pin and the
 * completed restart. None of that is a configuration fault; a split the remedy stops fixing — a
 * claim-refused restart standing past the self-upgrade's bound, or a restart reported done that
 * never reached the fleet — is counted, once, however many cycles it stands.
 *
 * One concern of the release-candidate soak (GY-404), in its own file (GY-1363): the world is
 * tests/helpers/soak-world.ts, the control planes tests/helpers/soak-plane.ts, the day
 * tests/helpers/soak-simulation.ts (`releaseLag.fleet`), and the system invariants are asserted
 * after every cycle.
 */
soakControlPlanes('soak-fleet-alignment', 433);

const deploys = [90 * minute, 3 * hour, 4 * hour + 30 * minute, 6 * hour];
const plan = { items: 16, heldClaimRestarts: 0, leftovers: 0, slowRecompute: 0, unstable: 0, attested: 0, workMs: 15 * minute, rework: new Set<number>(), deaths: new Set<number>(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set<number>(), misread: new Set<number>(), exits: new Set<number>(), spentProducer: 0, lostRuns: 0,
  outOfQueue: { item: 16, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 16 }, loopRestarts: [] as number[], dirtyCheckout: { from: 99 * hour, to: 100 * hour }, headMove: { from: 99 * hour, to: 100 * hour }, deploys };

type Day = Awaited<ReturnType<typeof simulateDay>>;
const fleetFaults = (day: Day) => day.state.faults.instances.filter(instance => instance.faultClass === 'configuration' && instance.subject === 'executors');
const elapsedOf = (day: Day, at: string) => Date.parse(at) - day.dayStart;

/**
 * What every fleet day holds until the remedy stops: holds, pins and completed restarts, none of them counted. Returns
 * when the last cycle before it ran: the cycle's fault step records its instant before that cycle's fleet sample.
 */
function assertAlignmentUncounted(day: Day, remedyStops: number) {
  const fleet = day.fleetDay!;
  assert.deepEqual(day.violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(day.failures, [], 'no cycle or self-upgrade failed');
  assert.deepEqual(day.lost, [], 'no lease was lost');
  const before = fleet.samples.filter(sample => sample.elapsed < remedyStops);
  const held = before.filter(sample => sample.split && sample.stall === 'release-lagged');
  assert.ok(held.length >= 20, `the fleet stood split from the checkout through held restarts for ${held.length} cycles, each a configuration fault read against the checkout alone`);
  assert.deepEqual(held.filter(sample => sample.inMotionUntil === null || sample.pin === null).map(sample => sample.elapsed / minute), [], 'every held cycle reads the split in motion, with the CLI pinned to the served release');
  assert.deepEqual(before.filter(sample => sample.split && sample.inMotionUntil === null).map(sample => sample.elapsed / minute), [], 'no split before the remedy stops is read as standing');
  const completed = before.filter((sample, index) => index > 0 && before[index - 1].split && !sample.split);
  assert.ok(completed.length >= 2, `holds lifted and completed the restart: ${completed.map(sample => sample.elapsed / minute)}`);
  assert.ok(completed.every(sample => sample.loaded === sample.coordinator && sample.pin === null && sample.pending === null), 'each completed restart loaded the checkout, unpinned the CLI and settled the owed restart');
  const lastCarried = before.at(-1)!.elapsed;
  assert.deepEqual(fleetFaults(day).filter(instance => elapsedOf(day, instance.at) <= lastCarried).map(instance => instance.at), [], 'no configuration fault on the fleet while the alignment carried it');
  return lastCarried;
}

test('manual:fault-class-configuration — the real loop over a simulated day of held release advances counts no fleet split while its self-upgrade holds, pins, lifts and completes the restart, and counts a claim-refused restart once it stands past the self-upgrade bound, once', { timeout: 600_000 }, async () => {
  const refusedFrom = 5 * hour + 45 * minute;
  const day = await simulateDay({ hours: 7, plan, releaseLag: { cutAgoMs: 30 * minute, fleet: { refuse: { from: refusedFrom, to: 99 * hour } } } });
  const fleet = day.fleetDay!, firstRefusal = fleet.refused[0]?.elapsed;
  assert.ok(firstRefusal !== undefined && fleet.refused.length >= 3, `the restart was refused and retried each pass: ${fleet.refused.map(entry => entry.elapsed / minute)}`);
  const lastCarried = assertAlignmentUncounted(day, firstRefusal + selfUpgradeBoundMs);
  const refusing = fleet.samples.filter(sample => sample.elapsed > firstRefusal && sample.stall === 'executors-refused');
  assert.ok(refusing.some(sample => sample.elapsed < firstRefusal + selfUpgradeBoundMs && sample.inMotionUntil !== null), 'the refused restart retried within the bound is in motion');
  assert.ok(refusing.some(sample => sample.elapsed >= firstRefusal + selfUpgradeBoundMs && sample.split && sample.inMotionUntil === null), 'past the bound the refusal stands though retried each pass');
  const counted = fleetFaults(day);
  assert.equal(counted.length, 1, `the standing split is one configuration fault, not one per cycle: ${counted.map(instance => instance.at)}`);
  assert.ok(elapsedOf(day, counted[0].at) > lastCarried, 'counted once the refusal outlived the bound');
  assert.match(counted[0].text, /executors run a release other than the coordinator's/);
});

test('manual:fault-class-configuration — the real loop over a simulated day counts a split no owed restart names: a restart reported done that never reached the fleet is one configuration fault, once', { timeout: 600_000 }, async () => {
  const strandAt = 5 * hour + 45 * minute;
  const day = await simulateDay({ hours: 7, plan, releaseLag: { cutAgoMs: 30 * minute, fleet: { strandAt } } });
  const fleet = day.fleetDay!;
  const stranded = fleet.samples.find(sample => sample.elapsed >= strandAt && sample.split && sample.pending === null);
  assert.ok(stranded, 'the self-upgrade settled its restart while the fleet stayed on its release');
  const lastCarried = assertAlignmentUncounted(day, stranded.elapsed);
  assert.ok(fleet.samples.filter(sample => sample.elapsed >= stranded.elapsed).every(sample => sample.split && sample.inMotionUntil === null), 'the split nothing owes stands, never in motion');
  const counted = fleetFaults(day);
  assert.equal(counted.length, 1, `the standing split is one configuration fault, not one per cycle: ${counted.map(instance => instance.at)}`);
  assert.ok(elapsedOf(day, counted[0].at) > lastCarried, 'counted once nothing owes the restart');
});
