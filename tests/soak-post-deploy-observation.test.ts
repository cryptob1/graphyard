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
 * and once the window has closed the queue names the reading as the loop's own wait (GY-1779: never
 * an escalation, never a dispatch). One concern of the day, in its own file (GY-1363): the world is tests/helpers/soak-world.ts,
 * the control planes tests/helpers/soak-plane.ts, the day tests/helpers/soak-simulation.ts
 * (`observationWindow`), and the system invariants are asserted after every cycle.
 */
soakControlPlanes('soak-post-deploy-observation', 1762);

const items = 5, windowHours = 2;
const plan = { items, releaseEveryMs: 5 * minute, leftovers: 0, slowRecompute: 0, workMs: 15 * minute, rework: new Set<number>(), deaths: new Set<number>(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set<number>(), misread: new Set<number>(), exits: new Set<number>(), spentProducer: 0, lostRuns: 0,
  outOfQueue: { item: items, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: items }, loopRestarts: [] as number[], dirtyCheckout: { from: 99 * hour, to: 100 * hour }, headMove: { from: 99 * hour, to: 100 * hour }, deploys: basePlan.deploys };

test('unit:soak-invariants-hold — over a simulated day of the real loop, an all-manual post-deploy follow-up is never dispatched or given a session, is counted waiting on every cycle before and after its window closes, past the window the loop records its reading (a fail recorded and escalated, re-read on the backoff; then a pass that closes it delivered-observation), never an escalation of the queue and never a dispatch, with every system invariant holding', { timeout: 600_000 }, async () => {
  const day = await simulateDay({ hours: 16, plan, observationWindow: { item: 1, windowDays: 1, filedAfterMs: 25 * minute, windowHours } });
  const window = day.observationWindowDay!;
  assert.deepEqual(day.violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(day.failures, [], 'no cycle failed');
  assert.deepEqual(day.lost, [], 'no lease was lost');
  const followUp = window.followUp!, notBefore = Date.parse(followUp.observationWindow!.notBefore);
  const before = window.samples.filter(sample => Date.parse(sample.at) < notBefore), after = window.samples.filter(sample => Date.parse(sample.at) >= notBefore);
  assert.ok(before.length >= 30 && after.length >= 30, `the loop cycled across both sides of the instant: ${before.length} before, ${after.length} after`);
  const open = window.samples.filter(sample => sample.stage !== 'done'), closed = window.samples.filter(sample => sample.stage === 'done');
  for (const sample of open) {
    assert.deepEqual([sample.dispatches, sample.lease, sample.sessions, sample.stage, sample.counted], [[], null, 0, 'ready', 'waiting'], `${sample.at}: undispatched, unleased, without a session, ready-stage and counted waiting`);
  }
  assert.ok(before.every(sample => sample.next === null && sample.readings.length === 0), 'before the instant the queue names nothing for it and no reading is taken');
  // GY-1779: past the instant the reading is the loop's own to record: a wait on the loop, never an operator-proof escalation and never a dispatch.
  assert.ok(after.every(sample => sample.next === null), 'past the instant the queue names the loop\'s wait, never an escalation and never a dispatch');
  // The loop read the report: every due cycle until the streak began recorded one failed reading (not one per cycle: the backoff) and raised the escalation naming the measured values.
  const failed = after.filter(sample => sample.stage !== 'done' && sample.readings.some(reading => reading.result === 'fail'));
  assert.ok(failed.length >= 3, `the failed reading stood on the open item across cycles: ${failed.length}`);
  assert.ok(failed.every(sample => sample.readings.filter(reading => reading.result === 'fail').length === 1), `a failed reading re-read on the backoff is not recorded a second time: ${JSON.stringify(failed.map(sample => [sample.at, sample.readings, sample.escalations.length]))}`);
  assert.ok(failed.some(sample => sample.escalations.some(detail => /reading of manual:intervention-pattern-escalation-build-on-serving-release failed on the serving release .*not under its threshold.*so the 2-hour window has not run/.test(detail))), `the fail raised the item's escalation naming the measured values: ${JSON.stringify(failed.at(-1)?.escalations)}`);
  assert.ok(failed.every(sample => /the loop records it in its deployment-verification step/.test(sample.wait ?? '')), 'a failed reading leaves the wait on the loop');
  // Once the streak met the window the pass was recorded and the item closed delivered-observation on the release it was read on, within the same day.
  assert.ok(day.readingDay!.passFrom !== null, 'the report began a streak that meets the window');
  assert.ok(closed.length >= 3, `the item closed and stayed closed: ${closed.length} samples after the close`);
  assert.equal(followUp.stage, 'done');
  assert.equal(followUp.closure?.kind, 'delivered-observation');
  const pass = followUp.evidence.filter(entry => entry.reading && entry.result === 'pass');
  assert.equal(pass.length, 1, 'one passing reading, marked as the loop\'s own');
  assert.equal(followUp.closure?.ref, pass[0].sha, 'closed on the release the pass was read on');
  assert.equal(pass[0].trusted, true);
  assert.ok(closed.every(sample => sample.dispatches.length === 0 && sample.lease === null && sample.sessions === 0), 'closed, it is never dispatched');
  assert.ok(day.readingDay!.reads >= 4, `the report was read per due cycle on the backoff, once per cycle for the filer and the reader together: ${day.readingDay!.reads}`);
});

/**
 * GY-1906 AC-4 under the real loop: item 1 declares GY-1910 AC-2 (`manual:post-deploy/onboarding-default-target`),
 * and its follow-up — GY-1911's shape — is read by the loop through the release-ledger reader. The hold GY-1909
 * clears at hour 3 on a candidate at the parent's merge; each served release's own UAT execution fails
 * onboarding-delivery-defaults until hour 6, then passes. The loop waits while the proof is unproven, records the
 * failed reading and escalates it, then records the pass and closes the item delivered-observation on that exact
 * release — with no evidence but the loop's own readings, no dispatch, lease or session.
 */
test('integration:goal-loop-verifies-onboarding-hold-clearance — over a simulated day of the real loop, the onboarding-default-target follow-up stays unproven until the hold clears, records the serving release\'s failed execution and escalates it, then closes delivered-observation on the exact release whose own execution passed, with only the loop\'s readings as evidence', { timeout: 600_000 }, async () => {
  const day = await simulateDay({ hours: 10, plan, observationWindow: { item: 1, windowDays: 1, filedAfterMs: 25 * minute, onboardingTarget: { clearAt: 3 * hour, passAt: 6 * hour } } });
  const window = day.observationWindowDay!;
  assert.deepEqual(day.violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(day.failures, [], 'no cycle failed');
  const followUp = window.followUp!;
  assert.ok(followUp, 'the follow-up was filed for the parent\'s onboarding-default-target proof');
  assert.deepEqual(followUp.criteria.flatMap(criterion => criterion.proofs), ['manual:onboarding-default-target-on-serving-release']);
  assert.ok(day.onboardingDay!.reads > 0, 'the loop read the release ledger');
  const at = (sample: { at: string }) => Date.parse(sample.at) - day.dayStart;
  const open = window.samples.filter(sample => sample.stage !== 'done'), closed = window.samples.filter(sample => sample.stage === 'done');
  for (const sample of window.samples) assert.deepEqual([sample.dispatches, sample.lease, sample.sessions], [[], null, 0], `${sample.at}: never dispatched, leased or given a session`);
  // Before the clear the proof is unproven: the loop waits and records nothing.
  assert.ok(open.filter(sample => at(sample) < 3 * hour).every(sample => sample.readings.length === 0), 'nothing is recorded while the hold is open');
  // Cleared, but the serving release's own execution fails: the fail is recorded once and escalated, naming it.
  const failedSamples = open.filter(sample => sample.readings.some(reading => reading.result === 'fail'));
  assert.ok(failedSamples.length >= 3, `the failed reading stood on the open item: ${failedSamples.length}`);
  assert.ok(failedSamples.every(sample => at(sample) >= 3 * hour && at(sample) < 6 * hour + hour));
  assert.ok(failedSamples.some(sample => sample.escalations.some(detail => /onboarding-delivery-defaults failed in descendant candidate .*'s own execution .* at the release's exact SHA/.test(detail))), JSON.stringify(failedSamples.at(-1)?.escalations));
  // Its own execution passes: the pass is recorded and the item closes delivered-observation on that release.
  assert.ok(closed.length >= 3, `the item closed and stayed closed: ${closed.length}`);
  assert.equal(followUp.stage, 'done');
  assert.equal(followUp.closure?.kind, 'delivered-observation');
  const pass = followUp.evidence.filter(entry => entry.result === 'pass');
  assert.equal(pass.length, 1);
  assert.equal(followUp.closure?.ref, pass[0].sha, 'closed on the release its pass was read on');
  assert.match(pass[0].reading!.detail, /onboarding-delivery-defaults passed in descendant candidate .* deployed at the release's exact SHA .*; the onboarding-default-path hold GY-1909 cleared on candidate .* under its rule/);
  // No master-submitted evidence, no synthetic pass: every record on the item is the loop's own reading, under the day's coordinator identity graphyard-master.
  assert.ok(followUp.evidence.length >= 2 && followUp.evidence.every(entry => entry.reading && entry.producer === 'graphyard-master' && entry.trusted), JSON.stringify(followUp.evidence.map(entry => [entry.producer, entry.result, !!entry.reading])));
  assert.ok(Date.parse(pass[0].at) - day.dayStart >= 6 * hour, 'the pass follows the serving release\'s own passing execution');
});
