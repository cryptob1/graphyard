import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hour, minute } from './helpers/soak-world.js';
import { api, principals, soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';
import { acceptancePollMs } from '../src/daemon/acceptance.js';
import { mechanicalPlanFreshMs } from '../src/mechanical-findings.js';
import type { Goal } from '../src/model/goal.js';

/**
 * GY-1795: the three decision faults of 14 October 2026, replayed across the real loop's cycles.
 * Each was filed for a state the product had already settled or could settle itself: a mechanical
 * plan's clear that met the loop's write timeout (GY-1459), the same clear refused because the item
 * was delivered after the cycle's snapshot (GY-1775), and an approved acceptance pull request GitHub
 * refused to merge under its last-pusher rule, which the loop asked the master to close every poll
 * (GOAL-1). The unit replays live in tests/fault-class-decision.test.ts; these days run the paths
 * through the real loop, cycle after cycle, with every system invariant asserted after each. One
 * concern of the release-candidate soak (GY-404), split per concern (GY-1363).
 */
soakControlPlanes('soak-decision-faults-settled', 445);

test('unit:soak-invariants-hold — a mechanical plan\'s clear that keeps timing out, and one refused because the item was delivered after the cycle\'s snapshot, stay visible retried writes across cycles, file no decision fault, and every item is delivered with every invariant holding', { timeout: 600_000 }, async () => {
  // The mechanical day (tests/soak-review.test.ts): two items' first approvals raise a finding
  // classified mechanical, the loop confirms each plan to the control plane and holds the head. Two
  // minutes after each plan the review ledger settles it refused — the approver refused the bot
  // round — so the loop owes the clear of a plan it confirmed and the ledger ceased to carry. The
  // rejected item's clear meets the write timeout for three minutes, every cycle of them, then lands
  // while the head is still held; the applied item's keeps timing out until the hold lapses and its
  // candidate merges, and the dispatcher reconciles that delivery beside the next cycle, after its
  // snapshot, so the clear that cycle writes is refused as delivered.
  const mechanical = { applied: 2, rejected: 5 }, timeoutMs = 3 * minute;
  const day = await simulateDay({
    hours: 6, mechanical, planReports: { timeoutMs, settleAfterMs: 2 * minute, delivered: true },
    plan: { items: 6, leftovers: 2, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, exhaustedReviewer: 0, outOfQueue: { item: 6, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 6 } },
  });
  const { items, final, violations, failures, lost, state, planReportDay } = day;
  assert.deepEqual(violations, [], 'every system invariant holds while the clears fail');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost');
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}: ${item.gates.flatMap(gate => gate.reasons).join('; ')}`), [], 'all six items are delivered');
  const applied = items[mechanical.applied - 1], rejected = items[mechanical.rejected - 1];
  assert.deepEqual(planReportDay.settled.map(entry => entry.key).sort(), [applied.key, rejected.key].sort(), 'the ledger settled both plans refused');
  for (const item of [applied, rejected]) assert.ok(planReportDay.writes.some(entry => entry.key === item.key && entry.plan && entry.at < planReportDay.settled.find(entry => entry.key === item.key)!.at), `${item.key}: the loop confirmed the plan before the ledger settled it`);

  // GY-1459: the rejected item's clear timed out across cycles — every clear written inside the
  // window, twice a cycle — and then landed while the item was open; the failed write stayed one
  // visible action naming the timeout and the gate's own lapse, and counted no decision fault.
  const timeouts = planReportDay.timeouts.filter(entry => entry.key === rejected.key), clears = planReportDay.writes.filter(entry => entry.key === rejected.key && !entry.plan && entry.at >= timeouts[0]!.at);
  assert.ok(timeouts.length >= 4, `the clear timed out across cycles: ${timeouts.length}`);
  assert.ok(new Set(timeouts.map(entry => entry.at)).size >= 2, `across cycles: ${timeouts.map(entry => entry.at).join(', ')}`);
  const windowEnd = timeouts[0]!.at + timeoutMs;
  assert.equal(clears.filter(entry => entry.at < windowEnd).length, timeouts.length, 'every clear inside the window timed out');
  assert.ok(clears.some(entry => entry.at >= windowEnd), 'the clear was written once the window closed');
  assert.deepEqual(planReportDay.refusals.filter(entry => entry.key === rejected.key), [], 'the plane never refused it');
  const row = state.actions[`mechanical-plan:${rejected.id}`];
  assert.equal(row?.state, 'failed', 'the timed-out clear is a visible, retried failed action');
  assert.match(row!.detail, new RegExp(`Could not report ${rejected.key}'s mechanical plan \\(none\\): The operation was aborted due to timeout; the review gate drops the hold once its last confirmation passes ${Math.round(mechanicalPlanFreshMs / 60_000)} minutes old`));
  assert.equal(row!.faultClass, undefined, 'and carries no fault class');

  // GY-1775: the applied item's clear kept timing out until its candidate merged; the delivery was
  // reconciled beside the next cycle, after its snapshot, and that cycle's clear met the plane's
  // immutability refusal — no report, no action, no decision fault — while the next snapshot read it done.
  assert.ok(planReportDay.timeouts.some(entry => entry.key === applied.key), 'the applied item\'s clear timed out too');
  assert.equal(planReportDay.delivered.length, 1, `the applied item was delivered beside a cycle: ${JSON.stringify(planReportDay.delivered)}`);
  const refused = planReportDay.refusals.filter(entry => entry.key === applied.key);
  assert.ok(refused.length >= 1, `the clear met the delivered refusal: ${JSON.stringify(planReportDay.refusals)}`);
  for (const entry of refused) assert.match(entry.detail, /Delivered work is immutable/);
  assert.ok(refused.every(entry => entry.at >= planReportDay.delivered[0]!.at), 'refused only once the item was delivered');
  assert.ok(!planReportDay.writes.some(entry => entry.key === applied.key && entry.at > refused.at(-1)!.at), 'no write follows the refusal: the next snapshot reads the item done');
  assert.equal(state.actions[`mechanical-plan:${applied.id}`]?.detail.includes('Delivered work is immutable'), false, 'the settled refusal names no failure');

  // Neither path filed a decision fault, and no plan report carries a fault class.
  assert.deepEqual(state.faults.instances.filter(instance => instance.faultClass === 'decision' && [applied.key, rejected.key].includes(instance.subject ?? '')), [], 'no decision fault is filed for either clear');
  assert.deepEqual(Object.entries(state.actions).filter(([key, action]) => key.startsWith('mechanical-plan:') && action.faultClass).map(([key]) => key), [], 'no plan report carries a fault class');
});

test('unit:soak-invariants-hold — approved acceptance pull requests under GitHub\'s last-pusher rule are landed through the real land route across polls: the independent approver App approves each head once, a refused mint and a pending required check are retried at the poll interval with the approval standing, no master decision is asked, every goal reaches planning and every invariant holds', { timeout: 600_000 }, async () => {
  // GOAL-1's base: the control-plane App pushed every acceptance branch and publishes the judge's
  // verdict as its own review, which GitHub discounts as the last pusher's. Actions reports the
  // required `test` check five minutes after a head's first landing, the independent approver App's
  // mint is refused on each pull request's first two landings, and once its approval stands GitHub
  // answers two merges with a transient 502, so each head is landed again at the poll interval with
  // the approval already standing on it.
  const landing = { approverRefusals: 2, checkPendingMs: 5 * minute, mergeOutages: 2 };
  const day = await simulateDay({
    hours: 6, acceptance: 'protected', landing,
    plan: { items: 4, leftovers: 1, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, attested: 0, exhaustedReviewer: 0, unstable: 0, lowLane: 0, outOfQueue: { item: 4, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 4 } },
  });
  const { violations, failures, lost, state } = day, acceptance = day.acceptanceDay!, world = acceptance.landing!;
  assert.deepEqual(violations, [], 'every system invariant holds while the landings repeat');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost');

  // Every goal landed and reached planning: the last-pusher rule no longer strands an approved goal.
  const goals = (await api(principals.coordinator, 'GET', 'goals')).goals as Goal[];
  const goal = (name: string) => goals.find(entry => entry.key === acceptance.goals[name])!;
  for (const name of ['signup', 'billing', 'audit']) {
    assert.equal(goal(name).stage, 'planning', `${name} was handed to the planner: ${goal(name).stage}`);
    assert.ok(goal(name).merged?.pr === goal(name).acceptance!.pr && world.fake.pull(goal(name).merged!.pr!).merged, `${name}'s approved pull request merged`);
    assert.notEqual(goal(name).acceptance!.author, goal(name).approval!.by, 'the author never judged its own draft');
  }
  const landedHeads = goals.map(entry => entry.approval!.head);
  assert.equal(new Set(landedHeads).size, 3, 'three approved heads landed');

  for (const head of landedHeads) {
    const pr = [...world.fake.pulls.values()].find(pull => pull.head.sha === head)!.number;
    const lands = world.lands.filter(entry => entry.head === head), merges = world.merges.filter(entry => entry.head === head), asked = world.approvals.filter(entry => entry.head === head);
    // The judge's verdict stood on GitHub as the control-plane App's review. While the mint was refused the merge was still asked: refused on the pending check at the first landing, then under the last-pusher rule once Actions had reported the check — GOAL-1's refusal, with the mint's named beside it.
    assert.ok(world.verdicts.some(entry => entry.pr === pr && entry.head === head), `#${pr}: the control-plane App published the judge's approval`);
    assert.deepEqual(merges.slice(0, landing.approverRefusals).map(entry => entry.refusal), ['Required status check "test" is expected.', 'New changes require approval from someone other than the last pusher.'], `#${pr}: the refused mints left the merge to GitHub's rules`);
    assert.deepEqual(lands.slice(0, landing.approverRefusals).map(entry => entry.state), Array(landing.approverRefusals).fill('waiting'));
    assert.match(lands[1]!.detail, /New changes require approval from someone other than the last pusher/);
    for (const entry of lands.slice(0, landing.approverRefusals)) assert.match(entry.detail, /the independent approver's approval was refused: the acceptance approver App \d+ could not mint an installation token \(502\)/);
    // Then the approver App approved exactly this head, once: every later landing asked again, found the approval standing and posted none.
    const approvals = world.fake.reviews.filter(review => review.pr === pr && review.sha === head && review.state === 'APPROVED' && review.by === `app:${world.approver.slug}`);
    assert.equal(approvals.length, 1, `#${pr}: one approval by the independent approver App on ${head.slice(0, 12)}`);
    assert.equal(asked.length, lands.length, `#${pr}: the approval was asked for on every landing (${asked.length})`);
    assert.deepEqual(asked.map(entry => entry.refused), [...Array(landing.approverRefusals).fill(true), ...Array(asked.length - landing.approverRefusals).fill(false)]);
    // With the approval standing, GitHub's transient 502s left the same head landed again at the poll interval, approval standing, until the merge landed, head-bound, once.
    const outages = merges.slice(landing.approverRefusals).filter(entry => entry.outage);
    assert.equal(outages.length, landing.mergeOutages, `#${pr}: the merge was retried through the outage across polls: ${JSON.stringify(merges)}`);
    assert.deepEqual(merges.slice(landing.approverRefusals).map(entry => entry.refusal), [...Array(landing.mergeOutages).fill('GitHub GraphQL query failed: 502 Bad Gateway'), null], `#${pr}: merged once, after the outage`);
    assert.equal(lands.length, landing.approverRefusals + landing.mergeOutages + 1, `#${pr}: one landing per poll until it merged`);
    assert.deepEqual(lands.map(entry => entry.state), [...Array(lands.length - 1).fill('waiting'), 'merged']);
    for (const entry of lands.slice(landing.approverRefusals, -1)) assert.match(entry.detail, /502 Bad Gateway/);
    // Landing was asked at most once per poll interval: each retry is the loop's own cadence, never a tighter loop.
    lands.slice(1).forEach((entry, index) => assert.ok(entry.at - lands[index]!.at >= acceptancePollMs, `#${pr}: landed again after ${entry.at - lands[index]!.at} ms`));
  }
  // No decision was asked of the master and no decision fault filed: the waiting landings were the loop's own retried notes.
  const notes = Object.entries(state.actions).filter(([key]) => key.startsWith('acceptance:'));
  assert.equal(notes.length, 3, `one action per goal: ${notes.map(([key]) => key).join(', ')}`);
  assert.deepEqual(notes.filter(([, action]) => /The master decides/.test(action.detail)).map(([key]) => key), [], 'the master was never asked to close a goal');
  const landingText = /has not merged|master decides|Could not land|asked GitHub to merge|last pusher|502 Bad Gateway/;
  assert.deepEqual(state.faults.instances.filter(instance => instance.faultClass === 'decision' && landingText.test(instance.text)), [], 'no decision fault is filed for the landings');
  assert.deepEqual(Object.values(state.actions).filter(action => action.kind === 'decision' && action.state === 'failed' && action.faultClass && landingText.test(action.detail)), [], 'no failed acceptance note carries a fault class');
  assert.deepEqual([...world.fake.pulls.values()].filter(pull => pull.state === 'open').map(pull => pull.number), [], 'no acceptance pull request is left open');
});
