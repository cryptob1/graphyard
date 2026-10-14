import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minute } from './helpers/soak-world.js';
import { basePlan, coordinatorRoot, soakControlPlanes } from './helpers/soak-plane.js';
import { assertLaunchesConfined, simulateDay } from './helpers/soak-simulation.js';

/**
 * Decision faults (GY-1541): the recurring causes of the decision fault class, replayed across the
 * real loop's cycles. One concern of the release-candidate soak (GY-404), split per concern
 * (GY-1363): the loop's own docs-sync cutoff give-up (GY-1515, GY-1530) and a deploying plane's
 * startup-readiness 503 on the agent registry reconcile (isolated:decision:agent-registry) are
 * designed routes and retried states, so neither files a decision fault while every system
 * invariant holds.
 */
soakControlPlanes('soak-decision-faults', 416);

test('unit:soak-invariants-hold — the loop\'s own docs-sync cutoff give-up and a startup-readiness 503 on the registry reconcile, cycle after cycle, file no decision fault, the conflict is reworked once and the registry recovers, with every invariant holding', { timeout: 600_000 }, async () => {
  // The docs-sync outlasts the bound, so the loop stops it at its cutoff and gives the conflict up (GY-1434);
  // meanwhile the plane answers 503 "Startup validation has not completed" to the registry reconcile for
  // 40 minutes (every cycle of them), then answers.
  const day = await simulateDay({ hours: 5, readiness: { from: 20 * minute, to: 60 * minute }, plan: { docsConflict: { ...basePlan.docsConflict, syncMs: 30 * minute } } });
  assertLaunchesConfined(day, coordinatorRoot!);
  const { violations, failures, state, docsSyncRuns, items, final, readinessDay, decideCalls } = day;
  assert.deepEqual(violations, [], 'every system invariant holds');
  assert.deepEqual(failures, [], 'no cycle failed');
  const conflicted = items[basePlan.docsConflict.item - 1].key;
  assert.deepEqual(docsSyncRuns.map(run => [run.plan.key, run.outcome]), [[conflicted, 'stopped']], 'the docs-sync was stopped at its cutoff');
  const giveUps = Object.values(state.actions).filter(action => action.work === conflicted && /docs-sync session .* was stopped at .* without having moved/.test(action.detail));
  assert.equal(giveUps.length, 1, 'the cutoff give-up settled once');
  assert.equal(decideCalls.filter(call => call.key === conflicted && call.action === 'rework').length, 1, 'and the conflict was reworked once');
  assert.ok(readinessDay.refused >= 6, `the registry refused across cycles: ${readinessDay.refused}`);
  assert.ok(readinessDay.answered > 0, 'and then answered');
  // The default plan's own simulated rework failure files its fault elsewhere; these two causes file none.
  assert.deepEqual(state.faults.instances.filter(instance => instance.faultClass === 'decision' && (instance.subject === conflicted || /agent-registry|Startup validation|registry/.test(`${instance.subject} ${instance.text}`))), [], 'no decision fault is filed for either');
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'every item is delivered');
});
