import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conflictReworkBoundMs } from '../src/model/approval.js';
import { minute } from './helpers/soak-world.js';
import { basePlan, coordinatorRoot, soakControlPlanes } from './helpers/soak-plane.js';
import { assertLaunchesConfined, simulateDay } from './helpers/soak-simulation.js';

/**
 * GY-1624: the decisions step removes a held item's bound before re-reading its hold and re-sets it while the
 * hold stands; a throw from closeStanding or docsSync.hold in between now puts it back, so the loop's idle wait
 * still ends at the bound. That path runs per item on every cycle a hold stands, so the real loop runs the
 * GY-1622 day here on the production 300 s idle interval, with one transient throw at each call site in turn on
 * the last cycle before the bound, the one whose idle wait would otherwise sleep past it. The cycle at the bound
 * must still run, request the rework once and in time, and every system invariant must hold over the cycles after.
 */
soakControlPlanes('soak-hold-bound-survives-throw', 435);

for (const site of ['closeStanding', 'docsSync.hold'] as const) {
  test(`unit:soak-invariants-hold — a transient ${site} throw on the last cycle before a docs-sync hold bound keeps the bound: the next cycle runs at it, requests the conflict rework once and in time, and every system invariant holds`, { timeout: 600_000 }, async () => {
    const intervalSeconds = 300;
    const day = await simulateDay({ hours: 4, loopWake: { intervalSeconds }, holdThrow: site, plan: { docsConflict: { ...basePlan.docsConflict, syncMs: 30 * minute } } });
    assertLaunchesConfined(day, coordinatorRoot!);
    const { violations, failures, state, docsSyncRuns, decideCalls, items, final, loopWakeDay, holdThrowDay } = day;
    assert.ok(loopWakeDay && holdThrowDay, 'the day ran on the wake, with the throw armed');
    assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
    assert.deepEqual(failures, [], 'no cycle failed');
    const conflicted = items[basePlan.docsConflict.item - 1].key, head = docsSyncRuns[0].plan.head;
    assert.deepEqual(docsSyncRuns.map(run => [run.plan.key, run.outcome]), [[conflicted, 'stopped']], 'one docs-sync session, stopped at its cutoff');

    // The throw was injected exactly once, on a cycle the bound stood ahead of within one idle interval.
    assert.equal(holdThrowDay.thrown.length, 1, `one transient ${site} failure`);
    const [{ elapsed: thrownAt, bound }] = holdThrowDay.thrown;
    assert.ok(state.actions[Object.keys(state.actions).find(key => key.startsWith('isolated:decision:'))!]?.detail?.includes(`transient ${site} failure`), 'the decisions step isolated the throw');

    // The bound survived it: the wait after the failed cycle ended at that same bound, shorter than the idle
    // interval, and the next cycle ran within one tick of it rather than sleeping out the 300 s.
    const { holdWakes, cycles, tickMs } = loopWakeDay;
    const failed = cycles.filter(cycle => cycle.elapsed <= thrownAt).at(-1)!, kept = holdWakes.find(wake => wake.elapsed === failed.elapsed);
    assert.ok(kept, `the cycle that threw still ended its wait at the hold bound: ${JSON.stringify(holdWakes)}, the cycle at ${failed.elapsed} threw at ${thrownAt}`);
    assert.equal(kept.bound, bound, 'at the bound it held before the throw');
    assert.ok(kept.waitMs < intervalSeconds * 1000, `the capped wait is shorter than the idle interval: ${kept.waitMs / 1000}s`);
    const next = cycles.find(cycle => cycle.elapsed > failed.elapsed);
    assert.ok(next && next.elapsed - failed.elapsed <= kept.waitMs + tickMs, `the next cycle ran at the bound: ${next ? (next.elapsed - failed.elapsed) / 1000 : 'never'}s after a ${kept.waitMs / 1000}s wait`);
    // Bounded: each bound ends at most one wait, and no cycle after the release is cut short by a stale bound.
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
}
