import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conflictReworkBoundMs } from '../src/model/approval.js';
import { minute } from './helpers/soak-world.js';
import { basePlan, coordinatorRoot, soakControlPlanes } from './helpers/soak-plane.js';
import { assertLaunchesConfined, simulateDay } from './helpers/soak-simulation.js';

/**
 * GY-1622: a docs-sync hold left standing on a conflict rework ends the loop's idle wait at its bound
 * (holdBoundWait, src/daemon/cycle-decisions.ts), as runDaemon applies it. That changes the loop's cadence
 * on every cycle a hold stands, so the real loop runs a day here on the production 300 s idle interval,
 * its sleep driven by the dispatcher's tick and capped at the hold bound. The docs-sync outlasts its cutoff,
 * so only the loop's own round releases the hold: it must run at the bound, request the rework once, and
 * every system invariant must hold over the cycles after it.
 */
soakControlPlanes('soak-loop-wakes-at-hold-bound', 433);

test('unit:soak-invariants-hold — a 300 s idle loop whose docs-sync hold bound falls before its next idle wake runs a cycle at the bound, requests the conflict rework once and in time, and keeps every system invariant', { timeout: 600_000 }, async () => {
  const intervalSeconds = 300;
  const day = await simulateDay({ hours: 4, loopWake: { intervalSeconds }, plan: { docsConflict: { ...basePlan.docsConflict, syncMs: 30 * minute } } });
  assertLaunchesConfined(day, coordinatorRoot!);
  const { violations, failures, state, docsSyncRuns, decideCalls, items, final, loopWakeDay } = day;
  assert.ok(loopWakeDay, 'the day ran on the wake');
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(failures, [], 'no cycle failed');
  const conflicted = items[basePlan.docsConflict.item - 1].key, head = docsSyncRuns[0].plan.head;
  assert.deepEqual(docsSyncRuns.map(run => [run.plan.key, run.outcome]), [[conflicted, 'stopped']], 'one docs-sync session, stopped at its cutoff');

  // The cap engaged: a cycle's wait ended at a standing hold bound, shorter than the idle interval, and the
  // next cycle ran within one tick of that bound rather than sleeping out the 300 s.
  const { holdWakes, cycles, tickMs } = loopWakeDay;
  assert.ok(holdWakes.length > 0, 'a standing hold bound ended an idle wait');
  for (const wake of holdWakes) {
    assert.ok(wake.waitMs < intervalSeconds * 1000, `the capped wait is shorter than the idle interval: ${wake.waitMs / 1000}s`);
    const next = cycles.find(cycle => cycle.elapsed > wake.elapsed);
    assert.ok(next && next.elapsed - wake.elapsed <= wake.waitMs + tickMs, `the next cycle ran at the bound: ${next ? (next.elapsed - wake.elapsed) / 1000 : 'never'}s after a ${wake.waitMs / 1000}s wait`);
  }
  // Bounded: a hold sets one bound per cycle, never more cap wakes than cycles, and each bound caps a wait only until it passes.
  assert.ok(holdWakes.length <= cycles.length);
  assert.equal(new Set(holdWakes.map(wake => wake.bound)).size, holdWakes.length, `each bound ended at most one wait: ${holdWakes.map(wake => new Date(wake.bound).toISOString())}`);

  // Timely and once-only: the loop's round is requested once for the head, within one tick of the loop-owned bound.
  const round = decideCalls.filter(call => call.key === conflicted && call.action === 'rework' && (call.input as { binding?: string } | undefined)?.binding === `${head}:conflict`);
  assert.equal(round.length, 1, `one rework per head: ${JSON.stringify(round)}`);
  const since = Date.parse(state.conflicts.find(entry => entry.work === conflicted)!.at), requested = Object.entries(state.actions).find(([key]) => key.startsWith('decision:rework:') && key.includes(`:${head}:conflict:`))?.[1];
  assert.ok(requested && Date.parse(requested.at) - since <= conflictReworkBoundMs + tickMs, `requested within a tick of the bound: ${requested ? (Date.parse(requested.at) - since) / minute : 'never'} minutes`);
  assert.ok(!state.faults.instances.some(instance => instance.kind === 'stalled-step' && instance.subject === conflicted), 'no stalled-step fault');
  assert.equal(final.find(entry => entry.key === conflicted)!.stage, 'done', 'and the conflicted item is delivered');
});
