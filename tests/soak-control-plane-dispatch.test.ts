import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hour, minute } from './helpers/soak-world.js';
import { type Failover, FailoverWorld, failoverInstalled, soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';

/**
 * GY-1523 AC-6, on the real loop over a simulated day: every worker dispatch goes through
 * `dispatchWork` on a real master root. The control plane is the only merge writer, so no launch
 * mints a push credential, and nothing is read to decide it.
 */
soakControlPlanes('soak-control-plane-dispatch', 419);

const plan = (items: number) => ({ items, releaseEveryMs: 5 * minute, leftovers: 2, slowRecompute: 0, workMs: 15 * minute, rework: new Set<number>(), deaths: new Set<number>(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set<number>(), misread: new Set<number>(), exits: new Set<number>(), spentProducer: 0, lostRuns: 0,
  outOfQueue: { item: items, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: items } });

test('unit:soak-invariants-hold — every real launch of the day mints no push credential, with every invariant holding', { timeout: 300_000 }, async () => {
  const { root, master } = await failoverInstalled();
  const world = new FailoverWorld(new Set());
  const failover: Required<Failover> = { root, master, world, dispatches: [], samples: [], refused: [] };
  const { final, violations, failures, lost } = await simulateDay({ hours: 3, failover, plan: plan(5) });
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'all five items are delivered');
  assert.deepEqual(violations, []); assert.deepEqual(failures, []); assert.deepEqual(lost, []);
  assert.deepEqual(failover.refused, [], 'no launch was refused');
  assert.equal(world.launched, 5);
  for (const dispatched of failover.dispatches) { assert.equal(dispatched.mergeWriter, 'control-plane'); assert.equal(dispatched.pushCredential, 'none', 'no launch carried a push credential'); }
  assert.deepEqual(world.minted, [], 'no push credential was minted all day');
});
