import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hour, minute } from './helpers/soak-world.js';
import { soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';

/**
 * GY-1790 under the real loop for simulated hours: the loop unit's ExecStart a snapshot restart
 * points into the held snapshot, and the pin's lift that returns it, over repeated passes in which the loop unit cannot be rewritten.
 *
 * The coordinator checkout stands dirty from the first hour to the sixth while two deploys are
 * verified. The first snapshot restart meets a read-only unit file for forty minutes: the restart
 * must move the unit's ExecStart from the checkout's launcher to the snapshot's, so every pass of
 * the window withholds it — the restart stays owed, the pin stands,
 * the refusal is recorded once, nothing re-executes — and the first pass after the window moves the
 * unit and restarts. The second deploy moves the loop onto a newer snapshot the same way. Once the
 * operator moves the clean checkout onto the pinned commit, the lift meets the read-only file for
 * forty-five minutes more: the pin is lifted, the loop unit still names
 * the snapshot's launcher, so the record stays and every pass retries until the rewrite goes.
 *
 * One concern of the release-candidate soak (GY-404), in its own file (GY-1363): the world is
 * tests/helpers/soak-world.ts, the control planes tests/helpers/soak-plane.ts, the day
 * tests/helpers/soak-simulation.ts (`unitRefusal`, `dirtyLift`), and the system invariants —
 * among them that the loop never re-executes through a unit naming a launcher other than the one
 * the pin requires — are asserted after every cycle.
 */
soakControlPlanes('soak-snapshot-launcher', 445);

const deploys = [2 * hour, 4 * hour];
const refused = { restart: { from: 2 * hour, to: 2 * hour + 40 * minute }, lift: { from: 6 * hour, to: 6 * hour + 45 * minute } };
const dirty = { from: hour, to: 6 * hour };
type Day = Awaited<ReturnType<typeof simulateDay>>;
type Sample = Day['upgrades']['samples'][number];
const inside = (window: { from: number; to: number }, sample: Sample) => sample.elapsed >= window.from && sample.elapsed < window.to;

test('unit:soak-snapshot-launcher-units — a dirty coordinator checkout upgraded by snapshot across two deploys while the loop unit cannot be rewritten: every pass of the refusal window withholds the restart with the pin standing and the refusal recorded once, the first pass after it points the unit at the snapshot\'s launcher and restarts, a newer snapshot moves the unit again, and the lift removes the pin at once but keeps its record until the loop unit is returned too; the loop never re-executes through a unit naming a launcher the pin does not require', { timeout: 600_000 }, async () => {
  const day = await simulateDay({ hours: 8, dirtyLift: true, unitRefusal: [refused.restart, refused.lift],
    plan: { deploys, dirtyCheckout: dirty, headMove: { from: 99 * hour, to: 100 * hour }, heldClaimRestarts: 0, deaths: new Set() } });
  const { upgrades, state, production, violations, failures, lost, dirtyLift, checkout, dayStart, github } = day;
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle: no re-execution through a stale unit');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  assert.equal(production.deploys.length, deploys.length, 'the day deployed on schedule');
  const samples = upgrades.samples;
  assert.ok(samples.filter(sample => sample.dirty).length >= 20, 'the checkout stood dirty across the window');

  // 1. The first snapshot restart, inside the refusal window: withheld on every pass. The pin is
  //    placed, the loop unit is refused, the
  //    restart stays owed under snapshot-failed, the cursor does not yet name the checkout as left
  //    behind, and the loop never re-executes; the refusal row stands at one attempt all window.
  //    The owed target follows the base tip meanwhile (a dirty checkout holds nothing back), so
  //    the pin is each pass's tip.
  const withheld = samples.filter(sample => inside(refused.restart, sample) && sample.outcome === 'failed');
  assert.ok(withheld.length >= 3, `the restart was withheld across the refusal window (${withheld.length} passes)`);
  for (const sample of withheld) {
    assert.ok(sample.pin && github.commits.has(sample.pin), `+${sample.elapsed / minute} min: the pin is a merged commit`);
    assert.deepEqual({ stall: sample.stall, pending: sample.pending, unit: sample.unit, snapshot: sample.snapshot, unitRow: sample.unitRow, self: sample.self },
      { stall: 'snapshot-failed', pending: sample.pin, unit: 'checkout', snapshot: null, unitRow: { state: 'failed', attempts: withheld[0].unitRow!.attempts }, self: withheld[0].self },
      `+${sample.elapsed / minute} min: the restart is withheld with the pin standing, the loop unit refused, nothing re-executed`);
  }
  assert.equal(withheld[0].unitRow?.attempts, 1, 'the refusal row is the day\'s first unit record');
  assert.equal(failures.length, withheld.length, `the only failed passes of the day are the withheld ones: ${failures.join(' | ')}`);
  assert.ok(failures.every(line => /the held snapshot of [0-9a-f]{12} stands and the launcher is pinned to it, but the loop's supervisor unit could not be pointed at the snapshot's launcher \(upgrade:unit names why\); the restart stays owed and is retried next cycle$/.test(line)), failures.join(' | '));
  assert.ok(samples.filter(sample => inside(refused.restart, sample) && sample.elapsed >= withheld[0].elapsed).every(sample => sample.outcome === 'failed'), 'once owed, every pass of the window retried and was withheld');

  // 2. The first pass after the window: the unit is rewritten to the snapshot's launcher and the
  //    restart goes — the loop through the pointed unit.
  const went = samples.find(sample => sample.elapsed >= refused.restart.to && sample.outcome === 'upgraded');
  assert.ok(went && went.elapsed < refused.restart.to + 10 * minute, `the first pass after the window restarts: ${JSON.stringify(went)}`);
  assert.deepEqual({ unit: went!.unit, self: went!.self, stall: went!.stall, pending: went!.pending, unitRow: went!.unitRow?.state },
    { unit: `snapshot:${went!.pin}`, self: withheld[0].self + 1, stall: null, pending: null, unitRow: 'done' });
  assert.ok(went!.snapshot && went!.snapshot.commit === went!.pin && went!.snapshot.dirty.includes('src/master.ts'), 'the cursor names the checkout left behind once the restart went');

  // 3. While the loop runs a snapshot, its unit names that snapshot, every cycle — through the
  //    second deploy, which moves it onto the newer snapshot.
  const onSnapshot = samples.filter(sample => sample.snapshot && sample.pin && sample.elapsed >= went!.elapsed && sample.elapsed < dirty.to);
  assert.ok(onSnapshot.length >= 10, `the loop ran a snapshot across ${onSnapshot.length} cycles`);
  assert.ok(onSnapshot.every(sample => sample.unit === `snapshot:${sample.pin}` && sample.stall === null), 'the loop unit names the snapshot the pin names, all along');
  const pinned = [...new Set(upgrades.pins.map(entry => entry.commit).filter((commit): commit is string => commit !== null))];
  const moved = samples.find(sample => sample.outcome === 'upgraded' && sample.elapsed >= deploys[1]);
  assert.ok(moved && moved.pin !== went!.pin && moved.unit === `snapshot:${moved.pin}`, `the second deploy's newer snapshot moved the unit with it: ${JSON.stringify(moved)}`);
  assert.equal(pinned.at(-1), moved!.pin, 'the last pin is the second deploy\'s snapshot');

  // 4. The lift, inside its refusal window: the operator moved the clean checkout onto the pinned
  //    commit; the pin is lifted on the first pass, but the loop
  //    unit still names the snapshot's launcher, so the record stays and every pass retries.
  assert.ok(dirtyLift && dirtyLift.at >= dayStart + dirty.to && dirtyLift.to === pinned.at(-1), `the operator moved the checkout onto the pinned commit once done: ${JSON.stringify(dirtyLift)}`);
  const liftHeld = samples.filter(sample => inside(refused.lift, sample) && sample.head === pinned.at(-1));
  assert.ok(liftHeld.length >= 2, `the lift was retried across its window (${liftHeld.length} passes)`);
  for (const sample of liftHeld) {
    assert.deepEqual({ outcome: sample.outcome, pin: sample.pin, unit: sample.unit, record: sample.snapshot?.commit, unitRow: sample.unitRow, self: sample.self, head: sample.head },
      { outcome: 'skipped', pin: null, unit: `snapshot:${pinned.at(-1)}`, record: pinned.at(-1), unitRow: { state: 'failed', attempts: liftHeld[0].unitRow!.attempts }, self: moved!.self, head: pinned.at(-1) },
      `+${sample.elapsed / minute} min: the pin is lifted, the loop unit refused, the record kept`);
  }

  // 5. The first pass after the window lifts for good: the loop unit returns to the checkout's
  //    launcher, the record is cleared, and the day ends with everything on the checkout.
  const lifted = samples.find(sample => sample.elapsed >= refused.lift.to && sample.outcome === 'up-to-date');
  assert.ok(lifted && lifted.elapsed < refused.lift.to + 10 * minute, `the first pass after the window lifts: ${JSON.stringify(lifted)}`);
  assert.deepEqual({ unit: lifted!.unit, pin: lifted!.pin, snapshot: lifted!.snapshot, unitRow: lifted!.unitRow?.state }, { unit: 'checkout', pin: null, snapshot: null, unitRow: 'done' });
  const after = samples.filter(sample => sample.elapsed > lifted!.elapsed);
  assert.ok(after.length >= 6 && after.every(sample => sample.unit === 'checkout' && sample.pin === null && sample.snapshot === null && sample.outcome === 'skipped'), 'nothing moves again for the rest of the day');
  assert.equal(state.upgrade.snapshot, undefined, 'the checkout is no longer recorded as left behind');
  assert.equal(state.release?.commit, checkout.head, 'the loop runs the commit the checkout holds');

  // Bounded: one launcher move per restart that went and one for the lift, for the loop unit; one
  // refusal per withheld pass; one upgrade
  // row per deployed head, the first head's attempts grown per withheld pass and for the pass that
  // went; the unit row ends done.
  const restarts = samples.filter(sample => sample.outcome === 'upgraded').length;
  assert.equal(upgrades.unit.launcherRewrites, restarts + 1, 'the loop unit moved once per restart that went and once back');
  assert.equal(upgrades.unit.refusals, withheld.length + liftHeld.length, 'one refusal per withheld pass, none elsewhere');
  assert.equal(upgrades.self, withheld[0].self + restarts, 'one re-execution per restart that went');
  const rows = Object.keys(state.actions).filter(key => /^upgrade:[0-9a-f]{40}$/.test(key));
  assert.deepEqual(rows.sort(), [...new Set(production.deploys.map(entry => `upgrade:${entry.sha}`))].sort(), 'one upgrade row per deployed head');
  assert.ok(rows.every(key => state.actions[key]!.state === 'done'), 'every upgrade row ends done');
  // Each pass records the snapshot it announces and then its outcome on the deployed head's row: two attempts per withheld pass, two for the pass that went.
  assert.equal(state.actions[`upgrade:${production.deploys[0].sha}`]?.attempts, 2 * (withheld.length + 1), 'the first head\'s row grew by its announcement and its outcome per withheld pass, and for the pass that went');
  assert.equal(state.actions['upgrade:unit']?.state, 'done');
  assert.equal(state.upgrade.stalled, undefined);
});
