import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState } from '../src/master-daemon.js';
import { storeAction } from '../src/daemon/state.js';
import { trackFaults } from '../src/model/fault-record.js';
import { RefusedResponse } from '../src/model/refusal.js';
import { acceptanceStep } from '../src/daemon/acceptance.js';

/**
 * GY-1751: the loop's cycles over two simulated days, the real acceptance step and the real fault
 * record each cycle. Neither order of an approver-exhaustion escalation and `decision-unanswered`
 * files two instances of one stall, and a plane-wide failure caught by the acceptance step files none
 * while a goal-specific failure quoting the same words files its fault.
 */
const config = (): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/outside/graphyard.mjs',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
const minute = 60_000, id = '65bf0fef-d9c1-4cd2-8467-9f1866b0fd41', day = 24 * 60 * minute, start = Date.parse('2026-10-12T00:00:00.000Z');
const unanswered = (at: number) => ({ kind: 'decision-unanswered', faultClass: 'decision', subject: 'GY-1710', text: `Decision ${id} (close) is unanswered after ${Math.round(at / minute)}m: approver session is not running` }) as never;
const escalate = (state: ReturnType<typeof emptyDaemonState>, at: number) => storeAction(state, `escalation:decision-unjudged:${id}`, { kind: 'escalation', work: 'GY-1710', principal: null, state: 'failed', detail: `GY-1710's close decision ${id} is unjudged after 3 approver session(s)`, attempts: 1, cycle: 1, at: new Date(start + at).toISOString(), epoch: null }, undefined);

for (const order of ['escalation first', 'unanswered first'] as const) {
  test(`unit:soak-decision-fault-dedupe — ${order}, every cycle of two days, one stuck decision is one instance`, () => {
    const state = emptyDaemonState(config());
    for (let at = 0; at < 2 * day; at += 10 * minute) {
      const stuck = at >= 60 * minute && at < 90 * minute, record = () => trackFaults(state.faults, stuck ? [unanswered(at)] : [], new Date(start + at).toISOString());
      if (order === 'escalation first') { if (stuck) escalate(state, at); record(); } else { record(); if (stuck) escalate(state, at); }
    }
    assert.deepEqual(state.faults.instances.map(entry => entry.kind), ['decision-unanswered']);
  });
}

test('unit:soak-decision-fault-dedupe — plane-wide acceptance failures, cycle after cycle for two days, file no decision fault; a goal refusal quoting the same words files one', async () => {
  const state = emptyDaemonState(config());
  let failure: Error = new RefusedResponse('Graphyard refused goals/G/land (503): Startup validation has not completed; retry shortly', 503, { error: 'Startup validation has not completed; retry shortly' });
  const goal = { id: 'g', key: 'GOAL-1', stage: 'accepted', revision: 1, acceptance: { pr: 1, outcomes: [] } };
  const effects = { settings: { enabled: true }, goals: async () => [goal], land: async () => { throw failure; } };
  for (let at = 0; at < 2 * day; at += 5 * minute) {
    const clock = start + at;
    await acceptanceStep({ config: config(), state, effects: { acceptance: effects, persist: async () => {} }, now: () => clock, clock, performed: [],
      isolate: async (_k: string, _i: unknown, _n: string, body: () => Promise<unknown>) => body() } as never);
    if (at === day) assert.deepEqual(state.faults.instances, [], 'a day of plane-wide failures files none');
    if (at === day) failure = new RefusedResponse('Graphyard refused goals/G/land (409): the approved head moved while HTTP 503 was seen on the base', 409, { error: 'the approved head moved' });
  }
  assert.deepEqual(state.faults.instances.map(entry => entry.kind), ['action:decision']);
});
