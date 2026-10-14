import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hour, minute } from './helpers/soak-world.js';
import { soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';

/**
 * GY-1751: two restatements of one cause must not count as decision faults, replayed across the real
 * loop's cycles. The acceptance role met the plane's startup-readiness 503 on every ten-minute retry of
 * its draft post, and an approver that never judges a hand-requested release is given up on with an
 * exhaustion escalation that restates the stall: neither opens a decision fault instance, every system
 * invariant holds.
 */
soakControlPlanes('soak-decision-fault-restatements', 431);

test('unit:soak-invariants-hold — across cycles an acceptance draft post met by the plane\'s readiness 503 files no decision fault and lands once the plane answers, with every invariant holding', { timeout: 600_000 }, async () => {
  const day = await simulateDay({ hours: 4, acceptance: true, acceptanceOutage: { from: 0, to: 90 * minute },
    plan: { items: 4, leftovers: 1, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, attested: 0, exhaustedReviewer: 0, unstable: 0, lowLane: 0, outOfQueue: { item: 4, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 4 } } });
  assert.deepEqual(day.violations, [], 'every system invariant holds');
  assert.deepEqual(day.failures, [], 'no cycle failed');
  assert.ok(day.outageDay.refused >= 3, `the draft post was refused across cycles: ${day.outageDay.refused}`);
  assert.ok(day.outageDay.answered > 0, 'and then answered');
  assert.deepEqual(day.state.faults.instances.filter(instance => instance.faultClass === 'decision' && /Startup validation|goals/.test(`${instance.subject} ${instance.text}`)), [], 'no decision fault is filed for the outage');
  assert.deepEqual(Object.values(day.state.actions).filter(action => action.kind === 'decision' && action.state === 'failed' && action.faultClass), [], 'the failed acceptance notes carry no fault class');
});

test('unit:soak-invariants-hold — an approver that never judges a hand-requested release is one stall: its exhaustion escalation is one instance with the unanswered line, and never lost', { timeout: 600_000 }, async () => {
  const day = await simulateDay({ hours: 5, handApprovers: true });
  assert.deepEqual(day.violations, [], 'every system invariant holds');
  assert.deepEqual(day.failures, [], 'no cycle failed');
  assert.ok(day.spent.size > 0, 'an approver was given up on');
  const escalations = Object.entries(day.state.actions).filter(([key]) => key.startsWith('escalation:decision-unjudged:'));
  assert.ok(escalations.length > 0, 'the exhaustion escalation was raised');
  // One stall is one instance: the decision-unanswered line when it was observed, else the escalation itself; never both, never neither.
  for (const [key] of escalations) {
    const decision = key.slice('escalation:decision-unjudged:'.length);
    const unanswered = day.state.faults.instances.filter(instance => instance.kind === 'decision-unanswered' && instance.text.startsWith(`Decision ${decision} (`));
    const own = day.state.faults.instances.filter(instance => instance.id === day.state.faults.failing[key]);
    assert.ok(unanswered.length + own.length >= 1, `${key}: the exhausted run is not dropped from recurrence`);
    assert.ok(!(unanswered.length && own.length), `${key}: the stall is not counted twice`);
  }
});
