import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hour, minute } from './helpers/soak-world.js';
import { basePlan, soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';

/**
 * GY-1794 under the real loop. The windowed follow-up's passing reading is recorded and the control
 * plane then refuses its delivered-observation close for six hours. The loop must not ask on every
 * cycle: the close is paced on its own failure backoff under its stable idempotency key, and once the
 * refusal ends it lands exactly once, with every system invariant holding after every cycle.
 */
soakControlPlanes('soak-recorded-pass-close-refused', 1794);

const items = 5, windowHours = 2, closeRefusedHours = 6;
const plan = { items, releaseEveryMs: 5 * minute, leftovers: 0, slowRecompute: 0, workMs: 15 * minute, rework: new Set<number>(), deaths: new Set<number>(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set<number>(), misread: new Set<number>(), exits: new Set<number>(), spentProducer: 0, lostRuns: 0,
  outOfQueue: { item: items, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: items }, loopRestarts: [] as number[], dirtyCheckout: { from: 99 * hour, to: 100 * hour }, headMove: { from: 99 * hour, to: 100 * hour }, deploys: basePlan.deploys };

test('unit:soak-invariants-hold — over a simulated day of the real loop, a recorded passing reading whose delivered-observation close the plane refuses for six hours is asked once per widening backoff step on one idempotency key, never once per cycle, then closes once when the refusal ends, with every system invariant holding', { timeout: 600_000 }, async () => {
  const day = await simulateDay({ hours: 24, plan, observationWindow: { item: 1, windowDays: 1, filedAfterMs: 25 * minute, windowHours, closeRefusedHours } });
  const window = day.observationWindowDay!, reading = day.readingDay!;
  assert.deepEqual(day.violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(day.failures, [], 'no cycle failed');
  assert.deepEqual(day.lost, [], 'no lease was lost');
  assert.ok(reading.passFrom !== null, 'the report began a streak that meets the window');
  const followUp = window.followUp!;
  assert.equal(followUp.stage, 'done');
  assert.equal(followUp.closure?.kind, 'delivered-observation');
  const pass = followUp.evidence.filter(entry => entry.reading && entry.result === 'pass');
  assert.equal(pass.length, 1, 'one passing reading, never recorded twice across the refused closes');
  assert.equal(followUp.closure?.ref, pass[0].sha, 'closed on the release the pass was read on');
  const asks = reading.closeAsks;
  assert.equal(new Set(asks.map(ask => ask.key)).size, 1, 'every ask carries the same idempotency key');
  const refused = asks.filter(ask => ask.at < reading.passFrom! + closeRefusedHours * hour);
  const refusedCycles = window.samples.filter(sample => Date.parse(sample.at) >= reading.passFrom! && Date.parse(sample.at) < reading.passFrom! + closeRefusedHours * hour).length;
  assert.ok(refused.length >= 2, `the refused close was asked again on the backoff: ${refused.length}`);
  assert.ok(refused.length * 3 <= refusedCycles, `the refused close is asked far less than once per cycle: ${refused.length} asks over ${refusedCycles} cycles`);
  assert.equal(asks.length - refused.length, 1, 'once the refusal ends the close is asked and lands once');
  assert.ok(window.samples.filter(sample => sample.stage === 'done').length >= 3, 'the item stayed closed');
});
