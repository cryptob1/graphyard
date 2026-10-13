import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hour, minute } from './helpers/soak-world.js';
import { basePlan, soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';

/**
 * GY-1762 under the real loop. Item 1 ships with a 2-hour live post-deploy window; its follow-up is
 * filed as master verify-deployment files it and released at once. The follow-up's criteria are all
 * manual post-deploy proofs, so across the whole day every master cycle must hold the three
 * decisions this item changed: no worker is ever dispatched or launched for it, master status counts
 * it waiting and never ready (before its window closes, and after, until a reading is recorded),
 * and once the window has closed the queue names the reading as owed (an escalation) rather than a
 * dispatch. One concern of the day, in its own file (GY-1363): the world is tests/helpers/soak-world.ts,
 * the control planes tests/helpers/soak-plane.ts, the day tests/helpers/soak-simulation.ts
 * (`observationWindow`), and the system invariants are asserted after every cycle.
 */
soakControlPlanes('soak-post-deploy-observation', 1762);

const items = 5, windowHours = 2;
const plan = { items, releaseEveryMs: 5 * minute, leftovers: 0, slowRecompute: 0, workMs: 15 * minute, rework: new Set<number>(), deaths: new Set<number>(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set<number>(), misread: new Set<number>(), exits: new Set<number>(), spentProducer: 0, lostRuns: 0,
  outOfQueue: { item: items, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: items }, loopRestarts: [] as number[], dirtyCheckout: { from: 99 * hour, to: 100 * hour }, headMove: { from: 99 * hour, to: 100 * hour }, deploys: basePlan.deploys };

test('unit:soak-invariants-hold — over a simulated day of the real loop, an all-manual post-deploy follow-up is never dispatched or given a session, is counted waiting on every cycle before and after its window closes, and past the window the queue names its reading as owed (an escalation), with every system invariant holding', { timeout: 600_000 }, async () => {
  const day = await simulateDay({ hours: 16, plan, observationWindow: { item: 1, windowDays: 1, filedAfterMs: 25 * minute, windowHours } });
  const window = day.observationWindowDay!;
  assert.deepEqual(day.violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(day.failures, [], 'no cycle failed');
  assert.deepEqual(day.lost, [], 'no lease was lost');
  const followUp = window.followUp!, notBefore = Date.parse(followUp.observationWindow!.notBefore);
  const before = window.samples.filter(sample => Date.parse(sample.at) < notBefore), after = window.samples.filter(sample => Date.parse(sample.at) >= notBefore);
  assert.ok(before.length >= 30 && after.length >= 30, `the loop cycled across both sides of the instant: ${before.length} before, ${after.length} after`);
  for (const sample of window.samples) {
    assert.deepEqual([sample.dispatches, sample.lease, sample.sessions, sample.stage, sample.counted], [[], null, 0, 'ready', 'waiting'], `${sample.at}: undispatched, unleased, without a session, ready-stage and counted waiting`);
  }
  assert.ok(before.every(sample => sample.next === null), 'before the instant the queue names nothing for it');
  assert.ok(after.every(sample => sample.next === 'escalate'), 'past the instant the queue names the owed reading, never a dispatch');
  assert.equal(followUp.stage, 'ready', 'it stays open until the loop records the reading');
});
