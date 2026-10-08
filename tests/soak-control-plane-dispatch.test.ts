import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAccountStartFailures } from '../src/master/dispatch.js';
import { planeWideFailure } from '../src/model/blocker-class.js';
import { hour, minute } from './helpers/soak-world.js';
import { type Failover, FailoverWorld, failoverInstalled, soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';

/**
 * GY-1523 AC-6, on the real loop over a simulated day: every worker dispatch goes through
 * `dispatchWork` on a real master root, which reads the recorded merger once before it claims
 * anything. Under the control-plane merger no launch mints a push credential; a read the plane
 * fails refuses that launch before any claim, cools no profile and counts toward no blocker, and
 * the item is dispatched again and delivered. The reads are bounded by the launches: one per
 * dispatch, none per cycle, under either merger.
 */
soakControlPlanes('soak-control-plane-dispatch', 419);

const plan = (items: number) => ({ items, releaseEveryMs: 5 * minute, leftovers: 2, slowRecompute: 0, workMs: 15 * minute, rework: new Set<number>(), deaths: new Set<number>(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set<number>(), misread: new Set<number>(), exits: new Set<number>(), spentProducer: 0, lostRuns: 0,
  outOfQueue: { item: items, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: items } });

test('unit:soak-invariants-hold — under the control-plane merger every real launch of the day reads the merger once before claiming and mints no push credential; the one read the plane fails refuses that launch before any claim, cools no profile, counts toward no blocker, and the item is dispatched again and delivered with every invariant holding', { timeout: 300_000 }, async () => {
  const { root, master, profile } = await failoverInstalled();
  // Every account starts; the plane fails the second merger read of the day with a 503.
  const world = new FailoverWorld(new Set(), 'control-plane', new Set([2]));
  const failover: Required<Failover> = { root, master, world, dispatches: [], samples: [], refused: [] };
  const { final, violations, failures, lost, state, sessions, cycles, dayStart } = await simulateDay({ hours: 3, failover, plan: plan(5) });
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'all five items are delivered');
  assert.deepEqual(violations, [], 'every system invariant holds across the real launches');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');

  // The reads are bounded by the dispatches: one per launch attempt, none per cycle.
  assert.equal(world.launched, 6, 'five items, one of them dispatched twice after the refused read');
  assert.equal(world.reads, world.launched, 'the merger is read exactly once per dispatch attempt');
  assert.ok(cycles > world.launched, `the day's ${cycles} cycles read the merger only when they dispatched`);
  assert.equal(world.kinds.length, 5, 'five sessions started');
  assert.equal(failover.dispatches.length, 5);
  for (const dispatched of failover.dispatches) {
    assert.equal(dispatched.mergeWriter, 'control-plane');
    assert.equal(dispatched.pushCredential, 'none', 'no launch carried a push credential');
  }
  assert.deepEqual(world.minted, [], 'no push credential was minted all day');

  // The refused read: refused before the claim with the plane's words, so it spent no epoch and
  // cooled nothing; the same item was dispatched again later and delivered at its first epoch.
  assert.equal(failover.refused.length, 1, JSON.stringify(failover.refused));
  const [refused] = failover.refused;
  assert.match(refused.error, /^the merge writer could not be read from https:\/\/graphyard\.example\/api\/status \(HTTP 503\), so the launch is refused before anything is claimed/);
  assert.ok(planeWideFailure(refused.error), 'the loop reads the refusal as a plane-wide failure');
  assert.deepEqual(state.dispatchFailures, {}, 'a plane-wide refusal counts toward no dispatch-failure run');
  assert.deepEqual(await readAccountStartFailures(master), {}, 'no account was held against for it');
  assert.deepEqual(failover.samples.map(sample => sample.attention.rows[profile.name]?.fallback ?? null), [null, null, null, null, null], 'no launch fell forward');
  const retried = sessions.filter(session => session.key === refused.key);
  assert.equal(retried.length, 1, `${refused.key} was launched once after the refusal: ${JSON.stringify(retried.map(session => session.epoch))}`);
  assert.ok(retried[0].dispatchAt - dayStart > refused.at, 'the launch that delivered it came after the refused one');
  assert.deepEqual(final.map(item => item.epoch), [1, 1, 1, 1, 1], 'no attempt was spent on the refused read');
});

test('unit:soak-invariants-hold — under the github merger every real launch of the day reads the merger once before claiming and mints that attempt\'s push credential, with every invariant holding', { timeout: 300_000 }, async () => {
  const { root, master } = await failoverInstalled();
  const world = new FailoverWorld(new Set(), 'github');
  const failover: Required<Failover> = { root, master, world, dispatches: [], samples: [], refused: [] };
  const { final, violations, failures, lost, sessions, cycles } = await simulateDay({ hours: 3, failover, plan: plan(5) });
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'all five items are delivered');
  assert.deepEqual(violations, []); assert.deepEqual(failures, []); assert.deepEqual(lost, []);
  assert.deepEqual(failover.refused, [], 'no launch was refused');
  assert.equal(world.launched, 5); assert.equal(world.reads, 5, 'one merger read per launch');
  assert.ok(cycles > world.launched, `the day's ${cycles} cycles read the merger only when they dispatched`);
  for (const dispatched of failover.dispatches) { assert.equal(dispatched.mergeWriter, 'github'); assert.equal(dispatched.pushCredential, 'minted'); }
  assert.deepEqual(world.minted.map(entry => `${entry.key}@${entry.epoch}`).sort(), sessions.map(session => `${session.key}@${session.epoch}`).sort(), 'one push credential per launched attempt');
});
