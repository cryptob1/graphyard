import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionStall, actionStallThreshold } from '../src/model/action-progress.js';
import { waitReason } from '../src/model/action-kinds.js';
import type { ActionRow } from '../src/model/actions.js';
import { emptyDaemonState, storeAction } from '../src/daemon/state.js';
import { assertDispatchable } from '../src/master/dispatch.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';

// GY-1758 names this file for its proof: manual:fault-class-stalled-gate. The master loop filed 4
// stalled-gate faults in 24 hours that shared one cause: a wait counted as a fault.
//   - GY-1747 (stalled-action) and GY-1752 (action:blocker): the merge writer / blocker probe met a
//     plane-wide transport timeout, "The operation was aborted due to timeout" (planeWideFailure).
//   - GY-1666 and GY-1688 (stalled-action): assertDispatchable refused an item parked on a
//     human-only decision, a designed wait whose own text names the answer that resumes it.
// Each instance's reason is replayed below as the ledger held it. Against the base each replay
// reads as a stall / files an instance; against the candidate none does. Instants are epoch
// milliseconds so no date is a wall-clock reading.

const t0 = 1_760_000_000_000, stamp = (offset: number) => new Date(t0 + offset * 60_000).toISOString();
const timeout = (url: string) => `the merge writer could not be read from ${url} (The operation was aborted due to timeout), so the launch is refused before anything is claimed rather than minting a push credential the control plane may have retired; it is dispatched again once the status read succeeds`;
const parked = (key: string, request: string) => `Dispatch waits on a human-only decision (goals and priorities); graphyard answer ${key} ${request} ANSWER resumes it`;

/** A dispatch row whose last `count` attempts all failed for `reason`, a claim between each. */
function failing(key: string, reason: string, count: number): ActionRow {
  const history = Array.from({ length: count }, (_, index) => [
    { at: stamp(index * 3), event: 'claimed', requester: 'graphyard', executor: 'executor-a', result: null, reason: 'claimed' },
    { at: stamp(index * 3 + 1), event: 'failed', requester: 'graphyard', executor: 'executor-a', result: 'failed', reason },
  ]).flat();
  return { id: `dispatch-${key}`, kind: 'dispatch', work: `id-${key}`, key, inputs: { kind: 'dispatch', target: 'implementation', epoch: 0, priority: 2, plannedFiles: [] },
    gate: 'build', refusal: reason, reason, binding: 'dispatch:0', requestedBy: 'graphyard', requestedAt: stamp(0), state: 'pending', claim: null, attempts: count, history } as unknown as ActionRow;
}

const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/outside/graphyard.mjs',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });

const instances = [
  { kind: 'stalled-action', subject: 'GY-1747', reason: timeout('https://graphyard-production.up.railway.app/api/status') },
  { kind: 'stalled-action', subject: 'GY-1666', reason: parked('GY-1666', 'ad35ed84-415c-415c-a17e-fa2b2fc2c7a4') },
  { kind: 'stalled-action', subject: 'GY-1688', reason: parked('GY-1688', '09d22edd-da94-4412-90c0-df27674ebf21') },
] as const;

for (const { subject, reason } of instances) test(`${subject}: ${actionStallThreshold} identical wait failures are not a stall`, () => {
  assert.equal(waitReason(reason), true);
  assert.equal(actionStall(failing(subject, reason, 4)), null);
});

test('GY-1752: a blocker probe that met a plane-wide timeout files no action:blocker instance', () => {
  const state = emptyDaemonState(config);
  const detail = "Could not record GY-1752's planned-file-scope blocker probe (plannedFiles cover the named files: fail): The operation was aborted due to timeout";
  for (let cycle = 1; cycle <= 4; cycle++) storeAction(state, 'blocker:GY-1752', { kind: 'blocker', work: 'GY-1752', principal: null, epoch: 1, state: 'failed', detail, attempts: cycle, cycle, at: stamp(cycle) });
  assert.equal(state.actions['blocker:GY-1752'].faultClass, undefined);
  assert.deepEqual(state.faults.instances ?? [], []);
});

test('a blocker probe that failed for the item still files its instance', () => {
  const state = emptyDaemonState(config);
  storeAction(state, 'blocker:GY-1', { kind: 'blocker', work: 'GY-1', principal: null, epoch: 1, state: 'failed', detail: 'probe refused: plannedFiles do not cover src/a.ts', attempts: 1, cycle: 1, at: stamp(1) });
  assert.equal(state.actions['blocker:GY-1'].faultClass, 'stalled-gate');
});

test('a run of one ordinary unchanged reason is still a stall', () => {
  assert.equal(waitReason('Dispatch blocked by unfinished dependencies: GY-9'), false);
  assert.ok(actionStall(failing('GY-5', 'Dispatch blocked by unfinished dependencies: GY-9', actionStallThreshold)));
});

test('the dispatch refusal for a parked item is the text the wait is read from', () => {
  const work = { key: 'GY-1666', humanRequest: { id: 'r-1', kind: 'goals-and-priorities', needed: 'x', answer: null } } as unknown as Work;
  assert.throws(() => assertDispatchable(work, [work], stamp(0)), error => waitReason((error as Error).message));
});

test('a repeated plane-wide-shaped failure of a call that is not the control plane\'s stays a fault and a stall', () => {
  const state = emptyDaemonState(config);
  const detail = 'Deployment endpoint is unreachable: The operation was aborted due to timeout';
  assert.equal(waitReason(detail), false);
  assert.equal(waitReason('GitHub answered HTTP 503'), false);
  assert.ok(actionStall(failing('GY-8', detail, actionStallThreshold)));
  storeAction(state, 'deployment:x', { kind: 'deployment', work: 'GY-8', principal: null, epoch: 1, state: 'failed', detail, attempts: 1, cycle: 1, at: stamp(1) });
  assert.ok(state.actions['deployment:x'].faultClass);
});
