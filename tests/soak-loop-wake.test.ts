import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loopWakeForgetTicks } from '../src/daemon/loop-wake.js';
import { hour, minute } from './helpers/soak-world.js';
import { soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';

/**
 * GY-1490: the dispatcher's tick wakes the master loop's sleep for each new subject its next cycle
 * acts on (src/daemon/loop-wake.ts). That changes how often the loop cycles, so the real loop runs a
 * busy day here on the production 300 s interval with its cadence driven by the real `LoopWake`:
 * every 10 s tick the day's snapshot and Herdr's agents go to `loopWakeSubjects`, and a cycle runs
 * only when its wait is over or the wake ends it past its floor. Herdr cannot be read every third
 * tick, so every free-slot subject flaps. After every cycle every system invariant holds; woken
 * cycles stand at least one tick apart, the loop cycles a bounded number of times an hour, and a
 * subject absent for a single tick never wakes the loop again.
 */
soakControlPlanes('soak-loop-wake', 412);

test('unit:soak-invariants-hold — a busy day whose loop sleeps 300 s and is woken by the dispatcher tick keeps every system invariant, cycles a bounded number of times an hour, and never re-wakes for a subject that flapped for one tick', { timeout: 600_000 }, async () => {
  const hours = 4, intervalSeconds = 300;
  const { final, violations, failures, lost, observed, loopWakeDay } = await simulateDay({
    hours, loopWake: { intervalSeconds, unreadableEvery: 3 },
    plan: { items: 12, releaseEveryMs: 15 * minute, leftovers: 1, slowRecompute: 0, workMs: 25 * minute, rework: new Set([3, 6, 9]), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, outOfQueue: { item: 12, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 12 } },
  });
  assert.ok(loopWakeDay, 'the day ran on the wake');
  const { cycles, fresh, tickMs, unreadable } = loopWakeDay;
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'every item is delivered');
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle of the woken loop');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost');
  for (const invariant of ['cycle-p90', 'refresh-churn', 'lingering-sessions', 'follow-ups-per-parent']) assert.ok(observed.has(invariant), `${invariant} was judged on the day`);

  // The wake ran: cycles ended idle 300 s sleeps early, and each woken cycle carried its reasons.
  const early = cycles.filter(cycle => cycle.early);
  assert.ok(early.some(cycle => cycle.waitMs === intervalSeconds * 1000), `an idle 300 s sleep was cut short: ${early.length} early cycle(s)`);
  assert.ok(early.every(cycle => cycle.woken.length > 0));
  // Bounded: woken cycles stand at least one tick (the floor) apart, no woken cycle without a new
  // subject behind it, and no hour runs more cycles than the floor allows — or than the loop's own
  // 30 s actionable cadence would, so the per-cycle reads the invariants bound keep their ceiling.
  const gaps = cycles.slice(1).map((cycle, index) => cycle.elapsed - cycles[index].elapsed);
  assert.ok(gaps.every(gap => gap >= tickMs), `cycles stand at least ${tickMs / 1000}s apart: ${Math.min(...gaps) / 1000}s`);
  assert.ok(early.length <= fresh.length, `each early cycle answers new subjects (${early.length} early, ${fresh.length} fresh)`);
  const perHour = Array.from({ length: hours + 1 }, (_, index) => cycles.filter(cycle => cycle.elapsed >= index * hour && cycle.elapsed < (index + 1) * hour).length);
  assert.ok(perHour.every(count => count <= hour / 30_000), `at most ${hour / 30_000} cycles an hour: ${perHour.join(', ')}`);
  // Hysteresis: Herdr was unreadable every third tick, yet no subject woke the loop after a single absent tick.
  assert.ok(unreadable > 0, 'Herdr was unreadable on some ticks');
  const rewoken = fresh.filter(entry => Number.isFinite(entry.absentTicks));
  assert.ok(rewoken.every(entry => entry.absentTicks >= loopWakeForgetTicks), `re-woken only after ${loopWakeForgetTicks} absent ticks: ${rewoken.filter(entry => entry.absentTicks < loopWakeForgetTicks).map(entry => `${entry.key} after ${entry.absentTicks}`).join(', ')}`);
});
