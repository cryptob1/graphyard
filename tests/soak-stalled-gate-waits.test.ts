import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { masterConfigSchema } from '../src/master.js';
import { cycleFaults, emptyDaemonState } from '../src/master-daemon.js';
import { storeAction } from '../src/daemon/state.js';
import { assertDispatchable } from '../src/master/dispatch.js';
import { actionStall } from '../src/model/action-progress.js';
import type { ActionRow } from '../src/model/actions.js';
import { hour, minute } from './helpers/soak-world.js';

/**
 * GY-1758 (manual:fault-class-stalled-gate): the loop's fault step over simulated days while a
 * plane-wide timeout and an item parked on a human-only decision both repeat every cycle, across
 * several items. Neither wait files a stalled-gate instance or reads as an action stall, the
 * retried action stays stored as failed (its retry is untouched), and instance counts stay
 * bounded across cycles and items. An ordinary unchanged failure still files its instance.
 */

const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token',
  cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)), repository: 'owner/project', baseBranch: 'main', githubAppId: 1234,
  hostId: 'soak-host', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
const dayStart = Date.parse('2031-06-02T08:00:00Z'), cycleMs = 5 * minute;
const iso = (ms: number) => new Date(ms).toISOString();
const timeout = 'the merge writer could not be read from https://graphyard.example/api/status (The operation was aborted due to timeout), so the launch is refused before anything is claimed; it is dispatched again once the status read succeeds';

const parkedItem = (key: string): Work => ({ key, id: `id-${key}`, ready: true, blocker: null, humanRequest: { id: `r-${key}`, kind: 'goals-and-priorities', needed: 'x', answer: null } }) as unknown as Work;

function dispatchRow(key: string, reason: string, at: number, attempts: number): ActionRow {
  const history = Array.from({ length: attempts }, (_, index) => [
    { at: iso(at - (attempts - index) * cycleMs), event: 'claimed', requester: 'graphyard', executor: 'executor-a', result: null, reason: 'claimed' },
    { at: iso(at - (attempts - index) * cycleMs + 1000), event: 'failed', requester: 'graphyard', executor: 'executor-a', result: 'failed', reason },
  ]).flat();
  return { id: `dispatch-${key}`, kind: 'dispatch', work: `id-${key}`, key, inputs: { kind: 'dispatch', target: 'implementation', epoch: 0, priority: 2, plannedFiles: [] },
    gate: 'build', refusal: reason, reason, binding: 'dispatch:0', requestedBy: 'graphyard', requestedAt: iso(at - attempts * cycleMs), state: 'pending', claim: null, attempts, history } as unknown as ActionRow;
}

test('unit:soak-invariants-hold — across three simulated days and several items, repeated plane-wide timeouts and human-only dispatch waits file no stalled-gate instance and are no stall, while an ordinary failure still files one', () => {
  const state = emptyDaemonState(config);
  const parked = ['GY-P1', 'GY-P2', 'GY-P3'].map(parkedItem), probed = ['GY-T1', 'GY-T2', 'GY-T3'];
  const refusals = new Map(parked.map(item => [item.key, (() => { try { assertDispatchable(item, parked, iso(dayStart)); return ''; } catch (error) { return (error as Error).message; } })()]));
  for (const [key, reason] of refusals) assert.ok(reason.length > 0, `${key} is refused at dispatch`);
  let cycles = 0;
  for (let elapsed = 0; elapsed < 72 * hour; elapsed += cycleMs) {
    const at = dayStart + elapsed;
    state.cycle += 1; cycles += 1;
    for (const key of probed) storeAction(state, `blocker:${key}`, { kind: 'blocker', work: key, principal: null, epoch: 1, state: 'failed', detail: `Could not record ${key}'s blocker probe: The operation was aborted due to timeout`, attempts: cycles, cycle: state.cycle, at: iso(at) });
    for (const item of parked) {
      const row = dispatchRow(item.key, refusals.get(item.key)!, at, 8);
      assert.equal(actionStall(row), null, `${item.key} is no stall at ${iso(at)}`);
      storeAction(state, `dispatch:${item.key}`, { kind: 'dispatch', work: item.key, principal: null, epoch: 1, state: 'failed', detail: refusals.get(item.key)!, attempts: cycles, cycle: state.cycle, at: iso(at) });
    }
    cycleFaults(state, [], at, { config, reported: [] });
  }
  assert.equal(cycles, 72 * hour / cycleMs);
  assert.deepEqual((state.faults.instances ?? []).filter(instance => instance.faultClass === 'stalled-gate'), [], 'no stalled-gate instance is filed by a repeating wait');
  for (const key of probed) assert.equal(state.actions[`blocker:${key}`].state, 'failed', 'the probe stays stored for retry');
  for (const item of parked) assert.equal(state.actions[`dispatch:${item.key}`].state, 'failed', 'the dispatch stays stored for retry');
  assert.ok(Object.keys(state.actions).length <= probed.length + parked.length + 20, 'stored actions stay bounded across cycles and items');

  // A cause that is no wait keeps filing, so the rule suppresses nothing else.
  storeAction(state, 'blocker:GY-X', { kind: 'blocker', work: 'GY-X', principal: null, epoch: 1, state: 'failed', detail: 'probe refused: plannedFiles do not cover src/a.ts', attempts: 1, cycle: state.cycle, at: iso(dayStart + 80 * hour) });
  assert.equal(state.actions['blocker:GY-X'].faultClass, 'stalled-gate');
});
