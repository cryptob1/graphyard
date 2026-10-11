import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hour, minute } from './helpers/soak-world.js';
import { basePlan, soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';

/**
 * GY-1698 under the real loop over three simulated days. Item 1 ships with a post-deploy
 * verification whose reading is an intervention rate per three days; 25 minutes after its merge the
 * day files the follow-up exactly as master verify-deployment does (filePostDeployFollowUps over the
 * day's items, the report's projection read for the pattern) and releases it at once — as GY-1689 was
 * filed at 03:36Z for a 03:11Z merge and released at 06:39Z, days before the reading it owed could
 * exist. The filing is repeated on every later cycle, as verify-deployment runs after every deploy
 * observation, so the day shows one follow-up per parent however often it is asked. Every cycle of
 * the day samples the loop's own view of the follow-up: master status's row, its plain sentence,
 * its action queue, the sessions launched for it, the faults and escalations naming it, and
 * whether a master session is live. One concern of the day (GY-1363), in its own file: the world is
 * tests/helpers/soak-world.ts, the control planes tests/helpers/soak-plane.ts, the day
 * tests/helpers/soak-simulation.ts (`observationWindow`), and the system invariants are asserted
 * after every cycle.
 */
soakControlPlanes('soak-observation-window', 442);

const dayMs = 24 * hour, windowDays = 3, items = 5, filedAfterMs = 25 * minute;
const plan = { items, releaseEveryMs: 5 * minute, leftovers: 0, slowRecompute: 0, workMs: 15 * minute, rework: new Set<number>(), deaths: new Set<number>(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set<number>(), misread: new Set<number>(), exits: new Set<number>(), spentProducer: 0, lostRuns: 0,
  outOfQueue: { item: items, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: items }, loopRestarts: [] as number[], dirtyCheckout: { from: 99 * hour, to: 100 * hour }, headMove: { from: 99 * hour, to: 100 * hour }, deploys: basePlan.deploys };

test('unit:soak-invariants-hold — over three simulated days of the real loop, a post-deploy follow-up filed for a windowed criterion and released at once is held on its recorded instant: no dispatch, no stalled-gate attention, no fault and no session for two and a half days, every cycle naming the instant; the first cycle past the instant requests its dispatch as Graphyard with no master session live, one attempt delivers it, repeated filings add no second follow-up for the parent, and every system invariant holds', { timeout: 600_000 }, async () => {
  const day = await simulateDay({ hours: windowDays * 24 + 4, plan, observationWindow: { item: 1, windowDays, filedAfterMs } });
  const window = day.observationWindowDay!, iso = (ms: number) => new Date(ms).toISOString();
  assert.deepEqual(day.violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(day.failures, [], 'no cycle failed');
  assert.deepEqual(day.lost, [], 'no lease was lost');
  assert.deepEqual(day.final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'the five items are delivered');

  // Filed as verify-deployment files it, 25 minutes after the parent's merge, and released at once: the
  // follow-up carries the instant — the merge plus the criterion's three days, later than the report's
  // projection — and nothing dispatched it for the days before it.
  const parent = day.final[0], followUp = window.followUp!;
  assert.ok(parent.delivery && window.filedAt !== null && window.releasedAt !== null, 'the parent was delivered and its follow-up filed and released');
  const mergedAt = Date.parse(parent.delivery!.mergedAt), notBefore = mergedAt + windowDays * dayMs;
  assert.deepEqual([followUp.observationWindow?.notBefore, followUp.observationWindow?.basis], [iso(notBefore), 'criterion-window']);
  assert.match(followUp.observationWindow!.detail, new RegExp(`^${parent.key} merged at ${iso(mergedAt)} and AC-2 names a ${windowDays}-day window, so the reading can first exist at ${iso(notBefore)} \\(the intervention report's projection for the escalation reading at the build stage, ${iso(notBefore - 12 * hour)}, is earlier\\)$`));
  assert.deepEqual(followUp.dependencies, [parent.id]);
  assert.ok(window.filedAt - mergedAt >= filedAfterMs && window.filedAt - mergedAt < filedAfterMs + 2 * minute, `filed ${Math.round((window.filedAt - mergedAt) / minute)} minutes after the merge`);
  assert.ok(notBefore - window.releasedAt > 2 * dayMs, `released ${Math.round((notBefore - window.releasedAt) / hour)} hours before its instant`);
  // One follow-up per parent: the filing ran every cycle after the first and created one item.
  assert.ok(window.filings > 100, `the filing was repeated across the day: ${window.filings} filings`);
  assert.deepEqual(window.created, [followUp.key], 'one follow-up was created for the parent');
  assert.deepEqual(day.final.filter(item => item.key !== parent.key && item.dependencies.includes(parent.id)), [], 'and no other item depends on the parent');

  // Before the instant, on every cycle of the two and a half days: released and ready, no dispatch action,
  // no attention row, no fault, no escalation, no lease and no session; the status row and the plain
  // sentence name the instant; and the loop ran no master session all day.
  const before = window.samples.filter(sample => Date.parse(sample.at) < notBefore), after = window.samples.filter(sample => Date.parse(sample.at) >= notBefore);
  assert.ok(before.length >= 200 && Date.parse(before.at(-1)!.at) - Date.parse(before[0]!.at) > 2 * dayMs, `the loop cycled across the held days: ${before.length} cycles over ${Math.round((Date.parse(before.at(-1)!.at) - Date.parse(before[0]!.at)) / hour)} hours`);
  for (const sample of before) {
    const label = `${sample.at} (+${Math.round(sample.elapsed / hour)} h)`;
    assert.equal(sample.stage, 'ready', `${label}: released, at its ready stage`);
    assert.equal(sample.waiting, true, `${label}: master status reports the window still holding`);
    assert.equal(sample.attention, null, `${label}: no stalled-gate attention row: ${sample.attention}`);
    assert.equal(sample.attentionRows, 0, `${label}: no attention item`);
    assert.equal(sample.sentence, `Waiting for its observation window — the reading it owes can first exist at ${iso(notBefore)}`, label);
    assert.deepEqual(sample.dispatches, [], `${label}: no dispatch action was requested`);
    assert.deepEqual([sample.lease, sample.sessions, sample.faults, sample.escalations], [null, 0, [], []], `${label}: nobody holds it, no session, no fault, no escalation`);
  }
  assert.deepEqual(window.samples.filter(sample => sample.masterLive).map(sample => sample.at), [], 'no master session was live on any cycle of the day');

  // At the instant: the first cycle at or past it requests the dispatch as Graphyard — once, within one
  // idle step of the instant — a worker session is launched, and that one attempt delivers the item.
  const first = after[0]!;
  assert.ok(Date.parse(first.at) - notBefore <= 10 * minute, `the loop's first cycle past the instant ran within an idle step of it: ${iso(Date.parse(first.at))}`);
  assert.deepEqual(first.dispatches.map(action => action.requestedBy), ['graphyard'], 'that cycle requested the dispatch as Graphyard');
  assert.ok(Date.parse(first.dispatches[0]!.at) >= notBefore, 'requested at or after the instant, never before');
  assert.equal(first.waiting, false, 'master status reports the window no longer holding');
  for (const sample of after) {
    assert.equal(sample.waiting, false, `${sample.at}: the window never holds again`);
    assert.deepEqual([sample.faults, sample.escalations], [[], []], `${sample.at}: no fault or escalation names the follow-up`);
    assert.deepEqual([...new Set(sample.dispatches.map(action => action.requestedBy))], ['graphyard'], `${sample.at}: every dispatch is the loop's own`);
  }
  assert.equal(Math.max(...after.map(sample => sample.dispatches.length)), 1, 'one dispatch was requested');
  assert.equal(Math.max(...after.map(sample => sample.sessions)), 1, 'one worker session was launched for it');
  assert.equal(followUp.stage, 'done', `the follow-up is delivered: ${followUp.stage} — ${followUp.gates.flatMap(gate => gate.reasons).join('; ')}`);
  assert.equal(followUp.epoch, 1, 'at its first attempt');
  assert.ok(followUp.delivery && Date.parse(followUp.delivery.mergedAt) > notBefore, 'merged after the instant');
});
