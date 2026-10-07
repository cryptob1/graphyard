import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workerNoSubmissionBoundMs, workerNoSubmissionRenewalBounds } from '../src/model/fault-classes.js';
import { noSubmissionKey } from '../src/daemon/cycle-resume.js';
import { hour, minute } from './helpers/soak-world.js';
import { soakControlPlanes, store } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';

/**
 * GY-1462. The worker no-submission bound over a simulated working day: the loop's faults step
 * reads every leased attempt every cycle, and the server refuses the renewals of one held two bounds
 * unsubmitted, so both repeat per cycle and per item. Here the real loop runs a cycle a minute for
 * eight hours while the first attempts of three items work for ever — `working` to Herdr, their
 * supervisors renewing every lease, never pushing — beside items that work and submit as usual.
 * After every cycle every system invariant holds (lingering sessions and lease losses near a deploy
 * among them), and at the end: each bounded attempt was one fault instance however many cycles it
 * stood, the recurring stalled-gate class filed at most one item and diagnosed it once, each attempt
 * was refused, preserved and ended exactly once with the bound recorded as the cause of its lapse
 * (no lease-loss), and each item went back to the queue once and was delivered by its next attempt.
 */
soakControlPlanes('soak-unsubmitted-bound', 412);

const unsubmitted = [1, 2, 3];

test('unit:soak-invariants-hold — workers that renew for hours without submitting are faulted once per attempt at the no-submission bound, refused renewal and requeued once at two bounds with no lease-loss, and every invariant holds', { timeout: 600_000 }, async () => {
  const day = await simulateDay({
    hours: 8, unsubmitted,
    plan: { items: 6, leftovers: 2, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, outOfQueue: { item: 6, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 6 } },
  });
  const { items, final, violations, failures, lost, sessions, state, bounded, preservedAttempts, escalations, dayStart } = day;
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle while the attempts are bounded');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost: each bounded attempt ended on the refusal by design');
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'every item is delivered, the bounded ones by their next attempt');

  const keys = unsubmitted.map(n => items[n - 1].key), endedAt = workerNoSubmissionRenewalBounds * workerNoSubmissionBoundMs;
  const faults = state.faults.instances.filter(entry => entry.kind === 'unsubmitted-attempt');
  for (const key of keys) {
    const attempts = sessions.filter(session => session.key === key).sort((a, b) => a.epoch - b.epoch);
    // Requeued once: the bounded attempt, then the one that delivered.
    assert.deepEqual(attempts.map(session => session.state), ['bounded', 'submitted'], `${key}: one bounded attempt, then one that submitted`);
    const first = attempts[0], claimed = first.dispatchAt - dayStart;
    // AC-2: ended at two bounds, once, and never before: the loop's reclaim ended it, and its
    // supervisor stopped on the refused renewal that followed.
    const ended = state.actions[noSubmissionKey(items[unsubmitted[keys.indexOf(key)] - 1], first.epoch)];
    assert.equal(ended?.state, 'done', `${key}: the loop ended the attempt: ${ended?.detail}`);
    assert.equal(ended.attempts, 1, `${key}: once`);
    assert.match(ended.detail, /past 2 worker no-submission bounds of 60 min; the attempt ended on the record/);
    const refused = bounded.filter(entry => entry.key === key);
    assert.equal(refused.length, 1, `${key}: its renewal was refused once: ${JSON.stringify(refused)}`);
    assert.ok(refused[0].epoch === first.epoch && refused[0].elapsed >= claimed + endedAt && refused[0].elapsed <= claimed + endedAt + 3 * minute,
      `${key}: stopped within two cycles of two bounds (claimed +${claimed / minute} min, stopped +${refused[0].elapsed / minute} min)`);
    // AC-3: the attempt's work was preserved once, by the existing path.
    assert.equal(preservedAttempts.filter(entry => entry.key === key && entry.epoch === first.epoch).length, 1, `${key}: its attempt was preserved once: ${JSON.stringify(preservedAttempts)}`);
    // AC-1: one fault instance for the attempt, first seen within a cycle of one bound, however many cycles it stood.
    const mine = faults.filter(entry => entry.subject === key);
    assert.equal(mine.length, 1, `${key}: one unsubmitted-attempt instance for its bounded attempt: ${JSON.stringify(mine)}`);
    const seenAt = Date.parse(mine[0].at) - dayStart;
    assert.ok(seenAt >= claimed + workerNoSubmissionBoundMs && seenAt <= claimed + workerNoSubmissionBoundMs + 2 * minute, `${key}: faulted within a cycle of the bound (+${seenAt / minute} min)`);
    assert.match(mine[0].text, new RegExp(`${key} epoch ${first.epoch} \\(`));
    assert.equal(mine[0].faultClass, 'stalled-gate');
    // The lapse the refusal caused is explained by the bound: no lease-loss stands or was raised.
    const item = final.find(entry => entry.key === key)!;
    assert.deepEqual((item.escalations ?? []).filter(entry => entry.trigger === 'lease-loss'), [], `${key}: no lease-loss stands`);
    assert.ok(!escalations.some(detail => detail.includes(key) && /lease-loss|lost lease/.test(detail)), `${key}: the loop escalated no lease loss`);
  }
  assert.deepEqual([...new Set(faults.map(entry => entry.subject))].sort(), [...keys].sort(), 'only the attempts that never submitted were faulted');
  // The recurring class: at most one structural stalled-gate item, diagnosed once.
  const filed = (await store.list()).filter(item => item.origin?.faultClass?.class === 'stalled-gate');
  assert.ok(filed.length <= 1, `at most one stalled-gate item was filed: ${filed.map(item => item.key).join(', ')}`);
  for (const item of filed) assert.ok(state.diagnoses[item.key], `${item.key} was diagnosed once`);
  assert.ok(faults.every(entry => !filed.length || entry.linkedTo === filed[0].key || Date.parse(entry.at) < Date.parse(filed[0].createdAt)),
    `every later instance links to the filed item: ${JSON.stringify(faults.map(entry => entry.linkedTo))}`);
});
