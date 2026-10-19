import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionStall, actionStallThreshold } from '../src/model/action-progress.js';
import { waitReason } from '../src/model/action-kinds.js';
import type { ActionRow } from '../src/model/actions.js';
import { emptyDaemonState, storeAction } from '../src/daemon/state.js';
import { assertDispatchable } from '../src/master/dispatch.js';
import { masterConfigSchema } from '../src/master.js';
import { blockerKind } from '../src/model/blocker-kind.js';
import { classified, classifyAttention, workFaults } from '../src/model/fault-classes.js';
import { trackFaults } from '../src/model/fault-record.js';
import { blockerClassMeaning, classifyBlocker, needsSomeone } from '../src/model/blocker-class.js';
import { workAttentionOwner } from '../src/master/attention.js';
import { doctorPrompt } from '../src/daemon/doctor.js';
import { stalledActionAttention } from '../src/cli/stalled-actions.js';
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
// GY-1674's recorded blocker, as the item holds it (GY-1761's third instance): a post-deploy verification whose criterion
// needs a doctor-issued master checkout-restore and a master status read, which the worker's token can neither run nor observe.
const gy1674Blocker = "AC-1 needs a doctor-issued master checkout-restore and a reading of master status (escalation:dirty-checkout cleared, daemon.upgrade.alignedRelease past ccc0a314). Blocked command: graphyard master status in this worktree, error: '.graphyard/master.json does not exist: run graphyard install --apply, or graphyard master init --token-stdin'. The worker token holds no master role, so the checkout-restore cannot be issued or observed from here. /healthz currently reports commit 7eefa971614153c714fb46c6dcc4512ad4d36b8c, not 215bf18e6492, so the serving release also differs from the one the item names. Needs a master-role session to observe and record manual:checkout-restore-clears-dirty-checkout-on-serving-release.";
const emptyRecord = () => ({ instances: [] as never[], open: {} as Record<string, string>, failing: {} as Record<string, string> });

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

test('a timed-out close of the throughput owner is a wait, and a server refusal with its own error body is not', () => {
  assert.equal(waitReason('Could not close GY-4: The operation was aborted due to timeout'), true);
  assert.equal(waitReason('Graphyard refused /api/work/GY-4 (503): Operator-agent authorization is unavailable'), false);
  assert.equal(waitReason('Graphyard refused /api/work/GY-4 (502): Application failed to respond'), true);
  assert.ok(actionStall(failing('GY-4', 'Graphyard refused /api/work/GY-4 (503): Operator-agent authorization is unavailable', actionStallThreshold)));
});

test('GY-1674: a blocker for a step that needs the master role is the installation\'s setup, not a stalled gate', () => {
  assert.equal(blockerKind(gy1674Blocker), 'setup');
  assert.equal(classified(blockerKind(gy1674Blocker)).faultClass, 'configuration');
  assert.equal(blockerKind('probe refused: plannedFiles do not cover src/a.ts'), 'blocker');
  assert.equal(classified(blockerKind('probe refused: plannedFiles do not cover src/a.ts')).faultClass, 'stalled-gate');
});

// AC-1's per-instance replays: each instance's exact ledger text goes through the path that filed it.
// GY-1666 and GY-1688 filed `stalled-action` instances from the dispatch queue's stall classification
// (master status's stalled rows are the loop's attention, and attention is what trackFaults records);
// GY-1674 filed a `blocker` instance from workFaults's reading of the item's standing blocker. The two
// parked-dispatch instances recur only on a release predating delivered GY-1758, which the base already
// carries; the candidate keeps their guard and adds the master-role classification GY-1674's shape
// needs, so each replay here is this change's own regression proof that no listed instance files a
// stalled-gate fault against the candidate. Instants are epoch millis.
for (const { subject, answer } of [
  { subject: 'GY-1666', answer: 'ad35ed84-415c-415c-a17e-fa2b2fc2c7a4' },
  { subject: 'GY-1688', answer: '09d22edd-da94-4412-90c0-df27674ebf21' },
] as const) test(`${subject}: the stalled-action instance its parked dispatch filed does not recur, through the attention path that filed it`, () => {
  const reason = parked(subject, answer);
  assert.equal(waitReason(reason), true);
  assert.equal(actionStall(failing(subject, reason, 4)), null);
  const work = { key: subject, id: `id-${subject}`, actionQueue: { actions: [failing(subject, reason, 4)], history: [] } } as unknown as Work;
  const attention = stalledActionAttention({ work: [work], now: stamp(30) });
  assert.deepEqual(attention, []);
  assert.deepEqual(trackFaults(emptyRecord(), classifyAttention(attention), stamp(30)), []);
});

test('the same attention path files the stalled-action instance an ordinary unchanged run earns (the replays\' control)', () => {
  const reason = 'Dispatch blocked by unfinished dependencies: GY-9';
  const work = { key: 'GY-9', id: 'id-GY-9', actionQueue: { actions: [failing('GY-9', reason, actionStallThreshold)], history: [] } } as unknown as Work;
  const attention = stalledActionAttention({ work: [work], now: stamp(30) });
  assert.equal(attention.length, 1);
  const opened = trackFaults(emptyRecord(), classifyAttention(attention), stamp(30));
  assert.deepEqual(opened.map(instance => instance.kind), ['stalled-action']);
  assert.deepEqual(opened.map(instance => instance.faultClass), ['stalled-gate']);
});

test('GY-1674: its recorded blocker files a configuration instance through workFaults, never a stalled-gate one', () => {
  const work = { key: 'GY-1674', stage: 'ready', escalations: [], humanRequest: null, scopeRequest: null, proofGaps: [], violations: [], blocker: gy1674Blocker,
    capacity: { exhaustions: [], escalations: [] }, lease: null } as unknown as Work;
  const faults = workFaults(work, Date.parse(stamp(0)));
  assert.deepEqual(faults.map(fault => fault.kind), ['setup']);
  assert.equal(faults[0].faultClass, 'configuration');
  const opened = trackFaults(emptyRecord(), faults, stamp(0));
  assert.deepEqual(opened.map(instance => instance.faultClass), ['configuration']);
  assert.ok(!opened.some(instance => instance.faultClass === 'stalled-gate'));
});

test('the master-role refusal is its own blocker class, handed to a master-role identity, and the fault kind agrees', () => {
  assert.equal(classifyBlocker(gy1674Blocker).class, 'master-role');
  assert.equal(needsSomeone('master-role'), true);
  assert.match(blockerClassMeaning['master-role'], /master role/);
  assert.match(blockerClassMeaning['master-role'], /unblocks the item/);
  assert.equal(blockerKind(gy1674Blocker), 'setup');
  // The fault kind and the blocker class restate the same refusal shapes (blocker-kind cannot import
  // blocker-class: the import closes a module-init cycle), so a drift guard holds the two together.
  for (const text of [
    "'.graphyard/master.json does not exist: run graphyard install --apply, or graphyard master init --token-stdin'",
    'The worker token holds no master role, so the checkout-restore cannot be issued or observed from here',
    'The worker token has no master role, so the checkout-restore cannot be issued',
    'no master role',
    'Blocked: this identity has No Master Role here',
    'Needs a master-role session to observe and record manual:checkout-restore-clears-dirty-checkout-on-serving-release',
  ]) {
    assert.equal(classifyBlocker(text).class, 'master-role', text);
    assert.equal(blockerKind(text), 'setup', text);
  }
  // A blocker that merely names a master command without the role refusal is not the class.
  assert.equal(classifyBlocker('graphyard master unblock GY-1 REASON was refused by the role check').class, 'genuine');
  assert.equal(blockerKind('graphyard master unblock GY-1 REASON was refused by the role check'), 'blocker');
  assert.equal(blockerKind('probe refused: plannedFiles do not cover src/a.ts'), 'blocker');
});

test('a master-role blocker routes the item\'s attention to the master identity with the take-the-step-then-unblock route', () => {
  const work = { key: 'GY-1674', blocker: gy1674Blocker, gates: [], escalations: [], humanRequest: null } as unknown as Work;
  const owner = workAttentionOwner(work, 'gate', Date.parse(stamp(0)));
  assert.equal(owner.role, 'master');
  assert.equal(owner.human, false);
  assert.match(owner.next, /only the master role can take/);
  assert.match(owner.next, /master unblock GY-1674 REASON/);
});

test('the resolver\'s charter acts on blocked items itself: unblock with a quoted reason, never a person (GY-2004)', () => {
  const prompt = doctorPrompt({ repository: 'owner/project', cliPath: '/outside/graphyard.mjs' }, { items: [], faults: [] });
  assert.match(prompt, /a blocked item whose blocker no longer holds/);
  assert.match(prompt, /master unblock GY-N with a quoted reason/);
  assert.match(prompt, /never ask a person/);
});
