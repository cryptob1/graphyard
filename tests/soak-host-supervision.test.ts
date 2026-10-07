import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executorUnit } from '../src/repository-setup.js';
import { hostSlotKey, hostSupervisionKey, maxSlotRestarts, reviveBackoffMs, slotCooldownMs } from '../src/daemon/cycle-host.js';
import { minute } from './helpers/soak-world.js';
import { soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';

/**
 * The host-supervision step (GY-1428) in the real loop: the host's systemd user manager stops
 * answering for an hour and a half while logind refuses to start it, then an executor slot
 * crash-loops for an hour. One concern of the release-candidate soak (GY-404), split per concern
 * (GY-1363): the world is tests/helpers/soak-world.ts, the control planes tests/helpers/soak-plane.ts,
 * the day itself tests/helpers/soak-simulation.ts, and every suite asserts the system invariants
 * after every cycle.
 */
soakControlPlanes('soak-host-supervision', 411);

test('unit:soak-invariants-hold — a host whose user manager stays down, then whose executor slot crash-loops: the loop revives the manager with backoff and never a revival a cycle, restarts the slot within its cooldown and cap and then reports it failed, keeps one record for the condition, and every invariant holds', { timeout: 600_000 }, async () => {
  const managerDown = { from: 60 * minute, to: 150 * minute }, crashLoop = { from: 200 * minute, to: 260 * minute };
  const { final, violations, failures, state, hostDay } = await simulateDay({ hours: 5, hostSupervision: { managerDown, crashLoop }, plan: { lowLane: 0 } });
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'every item is delivered while the host is repaired');
  assert.deepEqual(violations, [], 'every system invariant holds, cycle-p90 among them, with the step active every cycle');
  assert.deepEqual(failures, [], 'no cycle failed');
  const day = hostDay!;
  // The manager: logind is asked with backoff while it refuses, and once more after it allows.
  const refused = day.revivals.filter(at => at < managerDown.to);
  assert.equal(refused[0], managerDown.from, 'the first cycle that finds the manager silent asks logind');
  for (let index = 1; index < refused.length; index++)
    assert.ok(refused[index] - refused[index - 1] >= reviveBackoffMs(index), `revival ${index + 1} waited its backoff: ${refused.map(at => at / minute).join(', ')}`);
  assert.ok(refused.length <= 8, `at most eight revivals in ninety minutes, not one a cycle: ${refused.length}`);
  const revived = day.revivals.find(at => at >= managerDown.to)!;
  assert.ok(revived !== undefined && revived <= managerDown.to + 30 * minute, `the manager was revived within one backoff of logind allowing it: ${revived / minute} min`);
  const restarted = day.starts.find(start => start.elapsed >= revived);
  assert.ok(restarted && restarted.elapsed === revived && restarted.units.join(' ') === `${executorUnit(1)} ${executorUnit(2)}`, `both slots were started in the cycle that revived the manager: ${JSON.stringify(restarted)}`);
  assert.equal(state.actions[hostSupervisionKey].state, 'done', 'the failing run ended when the manager answered');
  // The crash-looping slot: restarted at most its cap within the window, spaced by the cooldown, then reported failed and left down.
  const loops = day.starts.filter(start => start.elapsed >= crashLoop.from && start.units.includes(executorUnit(1)));
  assert.ok(loops.length >= 1 && loops.length <= maxSlotRestarts, `slot 1 was restarted between once and ${maxSlotRestarts} times: ${loops.map(start => start.elapsed / minute).join(', ')}`);
  for (let index = 1; index < loops.length; index++) assert.ok(loops[index].elapsed - loops[index - 1].elapsed >= slotCooldownMs, 'each restart waited the cooldown');
  assert.equal(state.actions[hostSlotKey(executorUnit(1))]?.state, 'failed', 'the crash loop is reported as a failure, not restarted forever');
  assert.ok(day.peakRows <= 4, `the condition holds one row, plus one per slot started: peak ${day.peakRows}`);
});
