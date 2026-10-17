import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { actionRecordLimit, actionStall, actionRetryAt, actionRetryMaxMs, actionStallThreshold } from '../src/model/action-progress.js';
import { handoffWaitBound, namesReleaseMachinery, promotionWaitBoundMs, promotionWaitClause, staleContainmentReasonPrefix, waitReason } from '../src/model/action-kinds.js';
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
import { noLocalPortsReason, promotionCarryingMerge, promotionFrozenReason, promotionHandoffMs, promotionMovement, promotionOffReason, promotionWaitSuffix } from '../src/daemon/deployment.js';
import { controlPlaneHandlers } from '../src/executor.js';
import { recurringClasses } from '../src/model/fault-class-recurrence.js';
import { faultClassPolicyFromEnv } from '../src/model/fault-classes.js';
// @ts-expect-error The standalone executor is a dependency-free entry point script.
import { controlPlaneEffects } from '../scripts/graphyard-executor.mjs';
import { daemonStatePath, writeDaemonState, type PromotionState } from '../src/daemon/state.js';
import { writeFile } from 'node:fs/promises';
import { temporaryDirectory } from './helpers/temp-dirs.js';
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
const stampMs = (offset: number) => t0 + offset * 60_000;
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

test('the doctor\'s shipped blocked check carries the master-role hand-off: it takes the step itself, then unblocks', () => {
  const prompt = doctorPrompt({ repository: 'owner/project', cliPath: '/outside/graphyard.mjs' }, { items: [], faults: [] });
  assert.match(prompt, /blocked: an item blocked for more than 10 min; a blocker naming the master-role refusal/);
  assert.match(prompt, /run the master command it names from this checkout yourself/);
  assert.match(prompt, /master unblock GY-N with a quoted reason/);
});

// GY-1831's instances: a delivered item's verify-deployment action failed only because the running
// release did not carry its merge yet, while a release candidate carrying that merge sat in the
// promotion pipeline the loop runs; about 20 minutes after each merge the promotion landed and the
// row's own retry would have observed the release serving. The stall classification, its attention
// row and the fault it filed all fired over that wait — three of them in 24 hours filed this very
// item. The candidate answers the attempt from the promotion state the loop already records on its
// cursor and names the wait, so the run is bounded by the promotion wait bound instead of the stall
// threshold and files no instance inside it; past the bound, under a gate that stops every
// dispatch, and with no candidate carrying the merge, it stalls and files as before. Instants are
// epoch millis; the promotion states below are recorded states, and containment is answered from a
// fixture ancestry over the commits the checkout already holds.

const doesNotCarry = (key: string, release: string, merge: string) => `the running release ${release} does not carry ${key}'s merge ${merge} yet`;
/** The wait-named failure the base executor threw over a carrying pipeline: the bare constant clause (GY-1831). */
const promotionWait = (plain: string) => `${plain}; ${promotionWaitClause}`;

const stalledGateInstances = [
  { subject: 'GY-1827', release: '3100cb653054', merge: '3733d249f020', attempts: 6, spacing: 3 },
  { subject: 'GY-1828', release: '3733d249f020', merge: '9f9b403b10cd', attempts: 7, spacing: 4 },
  { subject: 'GY-1830', release: '9f9b403b10cd', merge: '1b6ba10e01aa', attempts: 5, spacing: 1 },
] as const;

/** The wait the candidate executor throws over the flight `state` records: the clause with the state's newest demonstrated movement (GY-1966). */
const suffixOf = (state: PromotionState, now = stampMs(5)) =>
  promotionWaitSuffix(state, mergeSha, '.', 'main', ancestryRun([`${mergeSha}>${mainTip}`]), now) as Promise<string>;

/** A verify-deployment row whose last `count` attempts all failed for `reason`, one claim between each, `spacing` minutes apart. */
function failingVerify(key: string, reason: string, count: number, spacing = 3): ActionRow {
  const history = Array.from({ length: count }, (_, index) => [
    { at: stamp(index * spacing), event: 'claimed', requester: 'graphyard', executor: 'executor-a', result: null, reason: 'claimed' },
    { at: stamp(index * spacing + 1), event: 'failed', requester: 'graphyard', executor: 'executor-a', result: 'failed', reason },
  ]).flat();
  return { id: `verify-${key}`, kind: 'verify-deployment', work: `id-${key}`, key,
    inputs: { kind: 'verify-deployment', mergeSha: 'a'.repeat(40), mergedAt: stamp(0), state: 'done' },
    gate: 'merge', refusal: reason, reason, binding: 'delivery:verify', requestedBy: 'graphyard', requestedAt: stamp(0),
    state: 'pending', claim: null, attempts: count, history } as unknown as ActionRow;
}

/** A verify-deployment row whose failures carry per-attempt reasons: steps of [claimOffset, failOffset, reason], oldest first. */
function mixedVerify(key: string, steps: readonly (readonly [number, number, string])[]): ActionRow {
  const history = steps.flatMap(([claimAt, failAt, reason]) => [
    { at: stamp(claimAt), event: 'claimed', requester: 'graphyard', executor: 'executor-a', result: null, reason: 'claimed' },
    { at: stamp(failAt), event: 'failed', requester: 'graphyard', executor: 'executor-a', result: 'failed', reason },
  ]);
  const reason = steps[steps.length - 1][2];
  return { id: `verify-${key}`, kind: 'verify-deployment', work: `id-${key}`, key,
    inputs: { kind: 'verify-deployment', mergeSha: 'a'.repeat(40), mergedAt: stamp(0), state: 'done' },
    gate: 'merge', refusal: reason, reason, binding: 'delivery:verify', requestedBy: 'graphyard', requestedAt: stamp(0),
    state: 'pending', claim: null, attempts: steps.length, history } as unknown as ActionRow;
}

const attentionFor = (key: string, row: ActionRow) => stalledActionAttention({ work: [
  { key, id: `id-${key}`, actionQueue: { actions: [row], history: [] } } as unknown as Work,
], now: stamp(40) });

for (const { subject, release, merge, attempts, spacing } of stalledGateInstances) {
  const plain = doesNotCarry(subject, release, merge);
  test(`${subject}: its verify-deployment run is a stall, and the attention it raises is the release machinery's, not a per-item stalled-action`, () => {
    assert.equal(waitReason(plain), false);
    assert.ok(actionStall(failingVerify(subject, plain, attempts, spacing)), 'the unchanged run the ledger held is a stall');
    assert.equal(namesReleaseMachinery(plain), true, 'the plain release-lag reason names the machinery (GY-1966)');
    const attention = attentionFor(subject, failingVerify(subject, plain, attempts, spacing));
    assert.equal(attention.length, 1);
    assert.equal(attention[0].kind, 'production', 'a row a stopped pipeline holds files as the machinery’s');
    assert.match(attention[0].text, new RegExp(`The release machinery is not moving ${subject}'s delivery`));
    // Codex review of 766b9083: a promotion that carries the merge yet is not served is production's to recover, not the pipeline's to restart.
    assert.match((attention[0] as { next?: string }).next ?? '', /recover the production deployment instead, since a new candidate does not repair it/);
    const opened = trackFaults(emptyRecord(), classifyAttention(attention), stamp(40));
    assert.deepEqual(opened.map(instance => instance.faultClass), ['deployment']);
  });

  test(`${subject}: the same run is no stall once the promotion pipeline is read and names the wait with its newest movement, and none of the three files an instance at the candidate`, async () => {
    const wait = `${plain}; ${await suffixOf(gy1831Flight)}`;
    assert.equal(handoffWaitBound(wait), promotionWaitBoundMs);
    const row = failingVerify(subject, wait, attempts, spacing);
    assert.equal(actionStall(row), null, 'the wait is bounded, and the recorded window is inside the bound');
    assert.deepEqual(attentionFor(subject, row), []);
    assert.deepEqual(trackFaults(emptyRecord(), classifyAttention(attentionFor(subject, row)), stamp(40)), []);
    // The wait retries on the ordinary schedule, so the promotion that lands about 20 minutes in is
    // picked up by a retry within minutes, not at the stall backoff's ceiling.
    const retryAt = Date.parse(actionRetryAt(row, new Date(stamp(40))));
    assert.ok(retryAt <= stampMs(40) + actionRetryMaxMs, `the wait is retried on the ordinary schedule (retry at ${retryAt})`);
  });

  test(`${subject}: past the promotion pipeline's own bound the wait is a stall again, and it files the machinery's production instance`, async () => {
    const wait = `${plain}; ${await suffixOf(gy1831Flight)}`;
    const row = failingVerify(subject, wait, 7, 16); // 96 minutes of one unchanged movement
    assert.ok(actionStall(row), 'a run outlasting the bound is a stall');
    const attention = attentionFor(subject, row);
    assert.equal(attention.length, 1);
    assert.equal(attention[0].kind, 'production');
    assert.deepEqual(trackFaults(emptyRecord(), classifyAttention(attention), stamp(40)).map(instance => instance.faultClass), ['deployment']);
  });
}

test('a promotion wait whose attempts fill the row\'s retained record inside the bound is still a wait: the run is measured from the row\'s request, and stalls once the run outlasts the bound', async () => {
  const wait = `${doesNotCarry('GY-1827', '3100cb653054', 'a'.repeat(12))}; ${await suffixOf(gy1831Flight)}`;
  const full = failingVerify('GY-1827', wait, actionRecordLimit / 2, 5); // ten attempts, the record full, 46 minutes after the request
  assert.equal(full.history.length, actionRecordLimit);
  assert.equal(actionStall(full), null, 'the record filling up inside the bound is not the bound running out (46 minutes of one unchanged movement)');
  assert.deepEqual(attentionFor('GY-1827', full), []);
  assert.ok(actionStall(failingVerify('GY-1827', wait, actionRecordLimit / 2, 11)), 'the same full record 100 minutes after the request is a stall');
  const older = { ...full, requestedAt: stamp(-180) } as ActionRow;
  assert.ok(actionStall(older), 'a full record on a row open three hours may hide where the run began, so it is read as having outlasted the bound, as before');
});

test('the three instances the base filed were one recurring class — filed then as per-item stalled-action, filed now as the release machinery\'s production instances — and the candidate files none', async () => {
  const base = emptyRecord();
  for (const [index, { subject, release, merge, attempts, spacing }] of stalledGateInstances.entries()) {
    const attention = attentionFor(subject, failingVerify(subject, doesNotCarry(subject, release, merge), attempts, spacing));
    trackFaults(base, classifyAttention(attention), stamp(10 + index * 60));
  }
  const policy = faultClassPolicyFromEnv({});
  assert.deepEqual((base.instances as { faultClass: string }[]).map(instance => instance.faultClass), ['deployment', 'deployment', 'deployment'], 'a pipeline-held row files as the machinery\'s (GY-1966)');
  const recurrence = recurringClasses(base.instances, [], policy, stampMs(130)).find(entry => entry.faultClass === 'deployment');
  assert.ok(recurrence, 'the three machinery instances recur as one deployment class');
  assert.equal(recurrence!.count, 3);
  assert.equal(recurrence!.file, true);
  assert.deepEqual(recurrence!.recent.map(entry => entry.subject).sort(), ['GY-1827', 'GY-1828', 'GY-1830']);

  const waits = await Promise.all(stalledGateInstances.map(async ({ subject, release, merge }) => `${doesNotCarry(subject, release, merge)}; ${await suffixOf(gy1831Flight)}`));
  const candidate = emptyRecord();
  for (const [index, { subject, attempts, spacing }] of stalledGateInstances.entries()) {
    trackFaults(candidate, classifyAttention(attentionFor(subject, failingVerify(subject, waits[index], attempts, spacing))), stamp(10 + index * 60));
  }
  assert.deepEqual(candidate.instances, [], 'no instance is filed over the bounded promotion wait');
  assert.equal(recurringClasses(candidate.instances, [], policy, stampMs(130)).length, 0, 'so no class item is filed either');
});

// ——— The recorded promotion state the executor asks at the failed attempt ———

/** A child runner over a fixture ancestry: `merge-base --is-ancestor` answers from `edges` (`ancestor>descendant`); every call is recorded, so a fetch or a GitHub call cannot hide. */
const ancestryRun = (edges: readonly string[], calls: string[] = []) => (command: string, args: string[]) => {
  const rest = command === 'git' && args[0] === '-C' ? args.slice(2) : null;
  if (!rest) { calls.push(`${command} ${args.join(' ')}`); throw new Error(`the recorded-state read runs nothing but a local merge-base: ${command} ${args.join(' ')}`); }
  calls.push(`git ${rest.join(' ')}`);
  if (rest[0] !== 'merge-base') throw new Error(`the recorded-state read runs nothing but a local merge-base: git ${rest.join(' ')}`);
  const [ancestor, descendant] = rest.slice(2);
  if (ancestor === descendant || edges.includes(`${ancestor}>${descendant}`)) return '';
  const refusal = new Error('not an ancestor') as Error & { status?: number };
  refusal.status = 1;
  throw refusal;
};

const mergeSha = 'a'.repeat(40), candidateSha = 'b'.repeat(40), mainTip = 'c'.repeat(40), olderCut = 'd'.repeat(40), promotedSha = 'e'.repeat(40);
const quietReason = `The last release candidate cut ${olderCut.slice(0, 12)} and did not promote it; the next is dispatched as soon as main moves past it`;
const inFlightReason = 'A release candidate is still in validation; the next promotion is dispatched as soon as it concludes';
const dispatchFailedReason = `Dispatching release-candidate.yml with promote=true failed; the next attempt is due 10 minute(s) after this one: gh failed`;
/** A recorded promotion state as the loop leaves it, overridable per test. */
const promotionState = (over: Partial<PromotionState> = {}): PromotionState => ({
  checkedAt: stamp(1), mainSha: mainTip, promotedSha: null, promotedAt: null, behind: null, ledgerReadAt: stamp(1),
  inFlight: false, runsReadAt: stamp(1), dispatchedAt: stamp(1), lastDispatchAt: stamp(1), cutSha: olderCut,
  candidates: [{ id: 'rc-1', sha: olderCut, cutAt: stamp(1), prs: 1, queued: 0 }], nextDueAt: null, reason: quietReason, ...over,
});

/** GY-1831's flight as its replays read it: a release candidate carrying the merge, in validation. */
const gy1831Flight = promotionState({ inFlight: true, cutSha: candidateSha, candidates: [{ id: 'rc-1', sha: candidateSha, cutAt: stamp(2), prs: 1, queued: 0 }], reason: inFlightReason });

const carries = async (state: PromotionState | null, edges: readonly string[] = [`${mergeSha}>${mainTip}`], calls: string[] = [], now = stampMs(5)) =>
  promotionCarryingMerge(state, mergeSha, '.', 'main', ancestryRun(edges, calls), now);

test('the recorded promotion state answers in flight while a candidate carrying the merge is building', async () => {
  const calls: string[] = [];
  assert.equal(await carries(promotionState({ inFlight: true, cutSha: candidateSha, candidates: [{ id: 'rc-1', sha: candidateSha, cutAt: stamp(2), prs: 1, queued: 0 }], reason: inFlightReason }), [`${mergeSha}>${candidateSha}`, `${mergeSha}>${mainTip}`], calls), true);
  assert.deepEqual(calls, [`git merge-base --is-ancestor ${mergeSha} ${mainTip}`], 'the only child the answer runs is the local containment read; no fetch, no GitHub request, no ledger');
});

test('the recorded promotion state answers in flight while the merge is queued for a candidate the pipeline is building', async () => {
  // The run in flight cut before the merge, so the merge rides the next candidate — still the pipeline's ordinary pace.
  assert.equal(await carries(promotionState({ inFlight: true, reason: inFlightReason })), true);
});

test('the recorded promotion state answers in flight while the next dispatch is due and will carry the merge', async () => {
  // Nothing is in flight and main has moved past the last cut: promotionCycle dispatches exactly then.
  assert.equal(await carries(promotionState({ reason: dispatchFailedReason })), true, 'a dispatch the loop is retrying is the pipeline moving, inside the bound');
  assert.equal(await carries(promotionState({ dispatchedAt: stamp(1), lastDispatchAt: stamp(1) })), true);
});

test('the recorded promotion state answers in flight while the last candidate left merges queued behind it', async () => {
  // promotionCycle's queued rule (GY-1491): the candidate at the last dispatch differs from the newest,
  // which cut short of main with merges queued — the next dispatch carries them without a new merge.
  const state = promotionState({ cutSha: mainTip, candidateAtDispatch: 'rc-0', candidates: [{ id: 'rc-1', sha: olderCut, cutAt: stamp(1), prs: 2, queued: 2 }] });
  assert.equal(await carries(state, [`${mergeSha}>${mainTip}`, `${mergeSha}>${olderCut}`]), true);
});

test('a candidate that failed for main\'s tip is not the pipeline stopping while its validation window stands: a failed candidate whose soak still runs is the machinery mid-cycle, and past the window the quiet pipeline has stopped', async () => {
  // PRRT_kwDOUZby-s6tFAey: promotionCycle leaves nothing in flight and dispatches nothing until main moves past the failed cut.
  const failed = promotionState({ cutSha: mainTip, candidates: [{ id: 'rc-1', sha: mainTip.toUpperCase(), cutAt: stamp(2), prs: 1, queued: 0 }],
    soaks: [{ sha: mainTip, status: 'in_progress', conclusion: null, createdAt: stamp(3), url: null }] });
  assert.equal(await carries(failed, [`${mergeSha}>${mainTip}`], [], stampMs(30)), true, '32 minutes after the cut, inside the window the pipeline grants a candidate\'s validation and re-cut (GY-1966)');
  assert.equal(await carries(failed, [`${mergeSha}>${mainTip}`], [], stampMs(2) + promotionWaitBoundMs - 1), true, 'until the window closes the machinery, not the item, holds the delivery');
  assert.equal(await carries(failed, [`${mergeSha}>${mainTip}`], [], stampMs(2) + promotionWaitBoundMs), false, 'past it, nothing in flight and no dispatch due is a pipeline that has stopped moving, and the row stalls');
  // A soak of a candidate that promoted is answered by the promotion's own handoff, never by the soak.
  const promoted = promotionState({ ...failed, promotedSha: mainTip, promotedAt: stamp(2) });
  assert.equal(await carries(promoted, [`${mergeSha}>${mainTip}`], [], stampMs(2) + promotionHandoffMs), false, 'past the handoff the running soak holds nothing');
});

test('a merge newer than the loop\'s last ledger read is due: the base branch the checkout holds carries it past the recorded tip, so the next read sees main moved', async () => {
  const origin = 'refs/remotes/origin/main';
  // Quiet as recorded — the last cut covered the recorded tip — but the merge landed after that read.
  const quiet = promotionState({ cutSha: mainTip, candidates: [{ id: 'rc-1', sha: mainTip, cutAt: stamp(1), prs: 1, queued: 0 }] });
  assert.equal(await carries(quiet, [`${mergeSha}>${origin}`, `${mainTip}>${origin}`]), true, 'main moved past the recorded tip with the merge on it: the dispatch carrying it is due');
  assert.equal(await carries(quiet, [`${mergeSha}>${origin}`]), false, 'a base branch that no longer descends from the recorded tip is no pipeline this state describes');
  assert.equal(await carries(quiet, [`${mainTip}>${origin}`]), false, 'a merge the base branch does not hold is not in flight');
  assert.equal(await carries(promotionState({ reason: promotionOffReason }), [`${mergeSha}>${origin}`, `${mainTip}>${origin}`]), false, 'the gates still hold first');
});

test('the wait holds through the deployment handoff: a promotion recorded before production finishes deploying it is the pipeline\'s pace until the handoff bound', async () => {
  // PRRT_kwDOUZby-s6tEZw7: the workflow records rc-production, then production deploys it; an attempt in between is no fault.
  const state = promotionState({ promotedSha, promotedAt: stamp(1), cutSha: mainTip, candidates: [{ id: 'rc-1', sha: promotedSha, cutAt: stamp(0), prs: 1, queued: 0 }] });
  const edges = [`${mergeSha}>${mainTip}`, `${mergeSha}>${promotedSha}`];
  assert.equal(await carries(state, edges, [], stampMs(1)), true, 'the moment the promotion is recorded');
  assert.equal(await carries(state, edges, [], stampMs(1) + promotionHandoffMs - 1), true, 'until the handoff bound');
  assert.equal(await carries(state, edges, [], stampMs(1) + promotionHandoffMs), false, 'past it, production not serving the promoted release is a rollback or a wedged deploy');
  assert.equal(await carries(state, edges, [], stampMs(0)), false, 'a promotion recorded ahead of the clock is not read as a handoff');
  assert.ok(promotionHandoffMs < promotionWaitBoundMs, 'the handoff ends inside the wait bound, so a wedged deploy still stalls within it');
});

test('the recorded promotion state answers not in flight once the promotion record covers the merge, when the base branch does not carry it, and while the pipeline sits quiet', async () => {
  // Production not serving a merge the promotion record already covers is a rollback or a wedged deploy: a fault, not a wait.
  assert.equal(await carries(promotionState({ promotedSha, promotedAt: stamp(1) }), [`${mergeSha}>${mainTip}`, `${mergeSha}>${promotedSha}`], [], stampMs(1) + promotionHandoffMs), false);
  assert.equal(await carries(promotionState({ promotedSha, promotedAt: null }), [`${mergeSha}>${mainTip}`, `${mergeSha}>${promotedSha}`]), false, 'a promotion with no recorded instant has no handoff to wait through');
  // A merge the base branch no longer carries is nothing the pipeline can serve.
  assert.equal(await carries(promotionState({ inFlight: true, reason: inFlightReason }), []), false);
  // A quiet pipeline whose last candidate already covers main, left nothing queued and is past the validation window is a stopped one: the row stalls as before.
  assert.equal(await carries(promotionState({ cutSha: mainTip, candidates: [{ id: 'rc-1', sha: mainTip, cutAt: stamp(-90), prs: 1, queued: 0 }] })), false, 'a newest candidate past the window, nothing in flight and nothing due: the pipeline has stopped moving');
});

test('the gates promotionCycle applies hold the answer — off, frozen and control-plane without ports are never a wait, however the flags read', async () => {
  // Each gate leaves the recorded flags standing from before it closed the drive, so each is read with
  // in flight set and a dispatch due: the answer is still no, and the row stalls as before (B2).
  assert.equal(await carries(promotionState({ inFlight: true, reason: promotionOffReason })), false, 'promotion off dispatches nothing, ever');
  assert.equal(await carries(promotionState({ inFlight: true, reason: promotionFrozenReason({ sha: mainTip, since: stamp(0) }) })), false, 'the main watch’s freeze holds every dispatch');
  assert.equal(await carries(promotionState({ inFlight: true, reason: noLocalPortsReason })), false, 'a control-plane merger without its ports cuts nothing');
});

// ——— GY-1966's instances: the recurrence past GY-1831's delivered fix ———
//
// Both releases running during the three filings already carried GY-1831, yet all three filed.
// GY-1904's row named the promotion wait and still filed: candidate 20261017T182412Z carrying
// 9198a6c88fb5 failed UAT e2e (GY-1938) and the re-cut cycle ran longer than the fixed 60-minute
// bound the base kept — a bound even shorter than the 90 minutes the loop itself grants a
// candidate's soak. GY-1874 and GY-1926 filed plain 'does not carry' reasons: the recorded state
// had a failed candidate whose soak still ran, the machinery mid-cycle, and the binary in-flight
// read answered not carrying, so the rows stalled at the ordinary threshold (GY-1926: four
// minutes over four attempts). The candidate bounds the wait by the pipeline's demonstrated
// movement, files only when the pipeline itself stops moving, and files that as the release
// machinery's. Each replay below reconstructs the recorded state the filing's mechanism names and
// the row as the ledger held it; against the base's shape each one files, against the candidate
// none does. Instants are epoch milliseconds.

/** A pipeline whose newest candidate — cut with the running release itself — failed and whose soak still runs: the machinery mid-cycle. */
const midCycle = promotionState({
  cutSha: mainTip, dispatchedAt: stamp(1), lastDispatchAt: stamp(1),
  candidates: [{ id: 'rc-20261017T080512Z', sha: mainTip.toUpperCase(), cutAt: stamp(1), prs: 3, queued: 0 }],
  soaks: [{ sha: mainTip, status: 'in_progress', conclusion: null, createdAt: stamp(2), url: null }],
  reason: quietReason,
});
/** The re-cut cycle as GY-1904's filing found it: the failed candidate behind main, the dispatch that carries its merges due, no new movement since that candidate was cut. */
const reCutCycle = promotionState({
  cutSha: candidateSha, dispatchedAt: stamp(26), lastDispatchAt: stamp(26),
  candidates: [{ id: 'rc-20261017T182412Z', sha: candidateSha, cutAt: stamp(26), prs: 2, queued: 2 }],
  reason: dispatchFailedReason,
});

for (const { subject, release, merge, attempts, spacing } of [
  { subject: 'GY-1874', release: 'dedcfb537841', merge: 'c30a233fdea2', attempts: 7, spacing: 11 },
  { subject: 'GY-1926', release: '057124e72157', merge: '524b82e88eda', attempts: 4, spacing: 1 },
] as const) {
  const plain = doesNotCarry(subject, release, merge);
  test(`${subject}: the plain does-not-carry run the ledger held is a stall and files; at the candidate the machinery mid-cycle is a wait the row names, and nothing files`, async () => {
    const now = stampMs(spacing * attempts + 2);
    assert.equal(await promotionCarryingMerge(midCycle, mergeSha, '.', 'main', ancestryRun([`${mergeSha}>${mainTip}`]), now), true, 'the failed candidate\'s validation window stands: the machinery is what moves the delivery');
    assert.ok(actionStall(failingVerify(subject, plain, attempts, spacing)), 'the binary read answered not carrying, and the unchanged run stalled at the ordinary threshold');
    const attention = attentionFor(subject, failingVerify(subject, plain, attempts, spacing));
    assert.equal(attention.length, 1);
    assert.match(attention[0].text, new RegExp(plain.slice(0, 60).replaceAll(')', '\\)')), 'the ledger\'s reason stands in the filing');
    assert.equal(attention[0].kind, 'production', 'and it files as the machinery\'s, not the item\'s');
    const wait = `${plain}; ${await suffixOf(midCycle, now)}`;
    assert.match(wait, /rc-20261017T080512Z/, 'the wait names the candidate the machinery is still working through');
    const row = failingVerify(subject, wait, attempts, spacing);
    assert.equal(actionStall(row), null, 'the wait is bounded by the pipeline\'s window, and the movement stands');
    assert.deepEqual(trackFaults(emptyRecord(), classifyAttention(attentionFor(subject, row)), new Date(now).toISOString()), []);
  });
}

test('GY-1904: the wait-named run the ledger held files no more — the movement beside the clause keeps the run inside the window the pipeline grants, and the bound still catches a stopped one', async () => {
  const plain = doesNotCarry('GY-1904', '057124e72157', '9198a6c88fb5');
  const wait = `${plain}; ${await suffixOf(reCutCycle, stampMs(91))}`;
  assert.match(wait, /rc-20261017T182412Z/, 'the wait names the candidate the re-cut cycle last cut');
  // The row as the ledger held it: three plain failures, then the run of seven wait-named ones, 63
  // minutes old at the filing — outlasting the fixed 60-minute bound the base kept, which is what
  // filed this instance there. At the candidate the same run carries the movement beside the
  // clause, and the window the pipeline grants a candidate's validation and re-cut is what bounds it.
  const row = mixedVerify('GY-1904', [
    ...[0, 8, 16].map(at => [at, at + 1, plain] as const),
    ...[27, 38, 49, 60, 71, 82, 90].map(at => [at, at + 1, wait] as const),
  ]);
  assert.equal(actionStall(row), null, 'the wait-named run, 63 minutes of one unchanged movement, is inside the window');
  assert.deepEqual(attentionFor('GY-1904', row), []);
  assert.deepEqual(trackFaults(emptyRecord(), classifyAttention(attentionFor('GY-1904', row)), stamp(95)), []);
  // The bound is real: the same movement held past the whole window is a pipeline that has stopped
  // moving, and the row stalls — filing the machinery's, since a stopped pipeline is what holds it.
  const frozen = mixedVerify('GY-1904', [
    ...[0, 8, 16].map(at => [at, at + 1, plain] as const),
    ...[27, 38, 49, 60, 71, 82, 90, 101, 112, 123].map(at => [at, at + 1, wait] as const),
  ]);
  assert.ok(actionStall(frozen), '96 minutes without a movement is a pipeline that has stopped');
  const attention = attentionFor('GY-1904', frozen);
  assert.equal(attention.length, 1);
  assert.equal(attention[0].kind, 'production');
  assert.deepEqual(trackFaults(emptyRecord(), classifyAttention(attention), stamp(130)).map(instance => instance.faultClass), ['deployment']);
});

test('GY-1904 replayed with production\'s earlier promotion recorded — the movement the wait names is the re-cut cycle\'s own, the wait text changes at the re-cut, and a cycle longer than the bound with a movement inside it never stalls', async () => {
  // The real ledger keeps production's last promotion (the rc-production record), so the state a
  // live pipeline records carries promotedSha/promotedAt from its first promotion on — GY-1904's
  // own pipeline had promoted long before its re-cut cycle began. The movement is therefore the
  // newest of the recorded promotion, the in-flight dispatch and the newest candidate's cut, and
  // the recorded promotion pins nothing: naming it first kept the movement text fixed through the
  // whole re-cut cycle, the row's unchanged run outlasted the bound, and the instance filed again.
  const promoted = { promotedSha, promotedAt: stamp(3) };
  const before = promotionState({ ...promoted, cutSha: candidateSha, dispatchedAt: stamp(26), lastDispatchAt: stamp(26),
    candidates: [{ id: 'rc-20261017T182412Z', sha: candidateSha, cutAt: stamp(26), prs: 2, queued: 2 }], reason: dispatchFailedReason });
  assert.match(promotionMovement(before), /rc-20261017T182412Z/, 'the movement names the re-cut cycle\'s candidate');
  assert.doesNotMatch(promotionMovement(before), /the promotion of/, 'production\'s earlier promotion does not pin the movement (the rework\'s B1)');
  const after = promotionState({ ...promoted, cutSha: candidateSha, dispatchedAt: stamp(91), lastDispatchAt: stamp(91),
    candidates: [{ id: 'rc-20261017T192912Z', sha: candidateSha, cutAt: stamp(91), prs: 2, queued: 2 }], reason: dispatchFailedReason });
  assert.notEqual(promotionMovement(after), promotionMovement(before), 'the movement changes at the re-cut, so the row\'s unchanged run restarts');
  const plain = doesNotCarry('GY-1904', '057124e72157', '9198a6c88fb5');
  const waitBefore = `${plain}; ${await suffixOf(before, stampMs(90))}`;
  const waitAfter = `${plain}; ${await suffixOf(after, stampMs(95))}`;
  assert.notEqual(waitAfter, waitBefore, 'the failure\'s reason changes when the pipeline moves');
  // The re-cut cycle runs 131 minutes — past the 90-minute bound — but moves at its 91st minute: each
  // movement starts a fresh run of identical failures, and no run outlasts the bound. This is the
  // stretch that filed GY-1904 at the base, where the pinned movement left one run for the whole cycle.
  const row = mixedVerify('GY-1904', [
    ...[0, 8, 16].map(at => [at, at + 1, plain] as const),
    ...[27, 38, 49, 60, 71, 82, 90].map(at => [at, at + 1, waitBefore] as const),
    ...[92, 103, 114, 125, 136, 147, 158].map(at => [at, at + 1, waitAfter] as const),
  ]);
  assert.equal(actionStall(row), null, 'a cycle longer than the bound with a movement inside it does not stall');
  assert.deepEqual(attentionFor('GY-1904', row), []);
  assert.deepEqual(trackFaults(emptyRecord(), classifyAttention(attentionFor('GY-1904', row)), stamp(160)), []);
  // The control: the same stretch on a pipeline that never moves again is one unchanged run past the
  // bound — it stalls, and files the machinery's production instance, as a stopped pipeline should.
  const frozen = mixedVerify('GY-1904', [
    ...[0, 8, 16].map(at => [at, at + 1, plain] as const),
    ...[27, 38, 49, 60, 71, 82, 90, 101, 112, 123, 134, 145, 156].map(at => [at, at + 1, waitBefore] as const),
  ]);
  assert.ok(actionStall(frozen), 'the same stretch without a movement is one run past the bound, and stalls');
  const attention = attentionFor('GY-1904', frozen);
  assert.equal(attention.length, 1);
  assert.equal(attention[0].kind, 'production');
  assert.deepEqual(trackFaults(emptyRecord(), classifyAttention(attention), stamp(160)).map(instance => instance.faultClass), ['deployment']);
});

test('no recorded state, an unreadable containment and an unreadable ledger each answer not carrying: the plain failure stands', async () => {
  assert.equal(await carries(null), false, 'no loop has recorded promotion here, so nothing is in flight');
  assert.equal(await carries(promotionState({ mainSha: null, reason: 'The base branch tip could not be read, so nothing is promoted' })), false);
  assert.equal(await carries(promotionState({ reason: 'The base branch and the promotion record could not be read: gh failed' }), []), false, 'a merge the checkout does not hold is unknown containment, and unknown is not a wait');
});

test('the executor wiring reads the recorded state alone: no cursor means no child run at all, and a recorded flight runs only the local merge-base reads', async () => {
  const modules = { master: {}, daemon: await import('../src/master-daemon.js'), reviewer: {}, producer: {}, executor: {} }; // only the daemon names the wiring calls are reached through
  const root = await temporaryDirectory('gy-1831-wiring');
  execFileSync('git', ['init', '-q', root]); // the credential location is verified against the worktree inventory, as in a managed root
  const credentials = await temporaryDirectory('gy-1831-credentials'), credential = `${credentials}/coordinator.token`; // beside the cursor, outside the repository, as an install keeps them
  const wiringConfig = { ...config, credentialFile: credential, url: 'https://graphyard-wiring.example' } as typeof config;
  const calls: string[] = [];
  const effects = controlPlaneEffects(modules as never, { root, current: () => wiringConfig, run: ancestryRun([`${mergeSha}>${mainTip}`], calls), snapshot: async () => ({}), mutate: async () => ({}) });
  assert.equal(await effects.promotionWaitSuffix!(mergeSha), null, 'no cursor, no loop: the failure stands as it was');
  assert.equal(calls.length, 0, 'answering that read nothing and spawned nothing');
  const state = emptyDaemonState(wiringConfig);
  // The dispatch is the state's newest movement when its candidate is not listed yet — cut moments
  // before the dispatch, the window before the workflow records the candidate (GY-1966's rework:
  // the newest instant names the movement, so a tie at the candidate's cut names the cut).
  await writeDaemonState(wiringConfig, { ...state, promotion: promotionState({ inFlight: true, lastDispatchAt: stamp(2), dispatchedAt: stamp(2), reason: inFlightReason }) });
  const named = await effects.promotionWaitSuffix!(mergeSha);
  assert.match(named!, new RegExp(promotionWaitClause), 'the recorded flight the loop left on its cursor is the wait the executor names');
  assert.match(named!, /still in validation/, 'the wait names the pipeline\'s newest demonstrated movement (GY-1966)');
  assert.deepEqual(calls.filter(call => call.includes('fetch') || call.startsWith('gh ')), [], 'no fetch and no GitHub request: the loop’s rate-limited reads stay the only ones');
  assert.ok(calls.every(call => call.includes('merge-base')), `only local containment reads ran: ${JSON.stringify(calls)}`);
  // An unreadable cursor reaches the executor's log through the effects it is built with, and the failure stands as it was.
  const lines: string[] = [];
  const logged = controlPlaneEffects(modules as never, { root, current: () => wiringConfig, run: ancestryRun([`${mergeSha}>${mainTip}`], calls), snapshot: async () => ({ work: [work('GY-1827')], now: stamp(30) }), mutate: async () => ({}), log: (line: string) => lines.push(line) });
  await writeFile(daemonStatePath(wiringConfig), '{ not the cursor');
  const handler = controlPlaneHandlers(() => wiringConfig, { ...logged, observeDeployment: async () => notServing() as never })['verify-deployment']!;
  await assert.rejects(async () => handler(verifyRow('GY-1827', 'a'.repeat(40)), executorIdentity), (error: Error) => error.message === doesNotCarry('GY-1827', '3100cb653054', 'a'.repeat(12)));
  assert.equal(lines.length, 1, `the unreadable cursor is logged once: ${JSON.stringify(lines)}`);
  assert.match(lines[0], /^\[graphyard-executor\] the promotion state could not be read for GY-1827, so the failure stands as it was: /);
  assert.equal(typeof controlPlaneEffects(modules as never, { root, current: () => wiringConfig, run: ancestryRun([]), snapshot: async () => ({}), mutate: async () => ({}) }).log, 'function', 'without a log of its own the executor still logs, to its stderr');
});

test('the wait clause the executor throws is constant, and the movement beside it stands while the pipeline stands and changes when it moves', async () => {
  assert.match(promotionWaitClause, /promotion pipeline/);
  assert.doesNotMatch(promotionWaitClause, /\b[0-9a-f]{7,40}\b/, 'the clause names no candidate, release or merge');
  assert.doesNotMatch(promotionWaitClause, /\d{2}:\d{2}|minute|count/i, 'the clause names no clock or counter');
  const standing = await suffixOf(gy1831Flight);
  for (const { subject, release, merge } of stalledGateInstances) {
    assert.ok(standing.startsWith(promotionWaitClause));
    assert.match(standing, /the release candidate dispatched|the newest candidate \S+ was cut /, 'the movement names what the state last demonstrated');
    assert.equal(await suffixOf(gy1831Flight), standing, 'the same state names the same wait: the run of unchanged reasons accumulates under the bound');
  }
  // A movement — the candidate concluding, a newer cut, a promotion recorded — changes the movement
  // beside the clause, so the row's run of identical failures measures the stretch since the
  // pipeline last moved (GY-1966) and a re-cut cycle longer than an hour no longer files.
  const reCut = promotionState({ inFlight: false, cutSha: candidateSha, dispatchedAt: stamp(1), lastDispatchAt: stamp(1),
    candidates: [{ id: 'rc-2', sha: candidateSha, cutAt: stamp(3), prs: 1, queued: 0 }], reason: quietReason });
  assert.notEqual(await suffixOf(reCut), standing, 'a movement the state demonstrates changes the wait the row names');
  assert.match(await suffixOf(reCut), /rc-2/, 'the movement names the candidate the state last cut');
  for (const { subject, release, merge } of stalledGateInstances) assert.ok(promotionWait(doesNotCarry(subject, release, merge)).endsWith(promotionWaitClause), 'the base\'s bare clause still ends every wait it named');
});

// ——— The verify-deployment handler at the candidate ———

const work = (key: string) => ({ key, id: `id-${key}`, stage: 'done', criteria: [], workspaces: [], delivery: { mergeSha: 'a'.repeat(40), mergedAt: stamp(0) } }) as unknown as Work;
/** The executor identity a claim runs under — the handler takes it beside the row. */
const executorIdentity = { id: 'executor-a', host: 'host-a' };
const verifyRow = (key: string, mergeSha: string): ActionRow => ({ id: `verify-${key}`, kind: 'verify-deployment', work: `id-${key}`, key,
  inputs: { kind: 'verify-deployment', mergeSha, mergedAt: stamp(0), state: 'done' }, gate: 'merge', refusal: null, reason: '', binding: 'delivery:verify',
  requestedBy: 'graphyard', requestedAt: stamp(0), state: 'pending', claim: null, attempts: 0, history: [] } as unknown as ActionRow);

/** The handlers Graphyard ships, over a snapshot this test holds: only the deployment observation, the promotion read and the log vary. */
function verifyHandlers(observation: unknown, wiring: { suffix?: (mergeSha: string) => Promise<string | null>; log?: (line: string) => void } = {}, recorded: unknown[] = []) {
  return controlPlaneHandlers(() => config, {
    snapshot: async () => ({ work: [work('GY-1827')], now: stamp(30) }),
    mutate: async (path, body) => { recorded.push([path, body]); return {}; },
    agents: () => [], workerCredentials: async () => ({}), producerCredentials: async () => ({}),
    dispatchWorker: async () => { throw new Error('no launch here'); }, launchReview: async () => { throw new Error('no launch here'); },
    launchProducer: async () => { throw new Error('no launch here'); },
    observeDeployment: async () => observation as never,
    ...(wiring.suffix ? { promotionWaitSuffix: wiring.suffix } : {}),
    ...(wiring.log ? { log: wiring.log } : {}),
  })['verify-deployment']!;
}

const notServing = (reason?: string) => ({ source: 'endpoint', sha: '3100cb6530540000000000000000000000000000', at: stamp(30), deployed: [], pending: ['GY-1827'], ...(reason ? { reason } : {}) });
const serving = { source: 'endpoint', sha: '3733d249f0200000000000000000000000000000', at: stamp(21), deployed: ['GY-1827'], pending: [] };

test('unit:verify-deployment-awaits-promotion — the handler names the promotion wait with its movement while the pipeline carries the merge, and keeps the plain reason otherwise', async () => {
  const rowMerge = 'a'.repeat(12), plain = doesNotCarry('GY-1827', '3100cb653054', rowMerge), row = verifyRow('GY-1827', 'a'.repeat(40));
  const wait = `${promotionWaitClause} (${promotionMovement(gy1831Flight)})`;
  await assert.rejects(async () => verifyHandlers(notServing(), { suffix: async () => wait })(row, executorIdentity), (error: Error) => error.message === `${plain}; ${wait}`);
  await assert.rejects(async () => verifyHandlers(notServing(), { suffix: async () => null })(row, executorIdentity), (error: Error) => error.message === plain);
  await assert.rejects(async () => verifyHandlers(notServing())(row, executorIdentity), (error: Error) => error.message === plain, 'an executor without the promotion read keeps today’s failure');
  await assert.rejects(async () => verifyHandlers(notServing(), { suffix: async () => { throw new Error('the pipeline could not be read'); } })(row, executorIdentity), (error: Error) => error.message === plain, 'an unreadable pipeline reads as not carrying');
  const stale = `${staleContainmentReasonPrefix}git fetch origin main failed`;
  await assert.rejects(async () => verifyHandlers(notServing(stale), { suffix: async () => wait })(row, executorIdentity), (error: Error) => error.message === stale, 'containment derived without a fresh base branch is not the release-lag shape');
  const inactive = 'production deployment 7 reached success and was later marked inactive with no newer production deployment, so it is the release production serves';
  await assert.rejects(async () => verifyHandlers(notServing(inactive), { suffix: async () => wait })(row, executorIdentity), (error: Error) => error.message === `${plain}: ${inactive}; ${wait}`, 'an informational reason on a valid serving release still names the wait');
  // Codex review of 766b9083: once the wait is over, the informational reason still names the release machinery, so the stall files as the machinery's.
  const informational = await Promise.resolve().then(() => verifyHandlers(notServing(inactive), { suffix: async () => null })(row, executorIdentity)).then(() => '', (error: Error) => error.message);
  assert.equal(informational, `${plain}: ${inactive}`);
  assert.ok(namesReleaseMachinery(informational), 'a stalled row on an inactive serving release is the release machinery\'s');
  await assert.rejects(async () => verifyHandlers(notServing(`${inactive}; ${stale}`), { suffix: async () => wait })(row, executorIdentity), (error: Error) => error.message === `${inactive}; ${stale}`, 'a stale containment beside it still stands as it was');
});

test('unit:verify-deployment-awaits-promotion — an unreadable promotion state is logged where the executor’s log goes, and still reads as not carrying', async () => {
  const lines: string[] = [];
  await assert.rejects(async () => verifyHandlers(notServing(), { suffix: async () => { throw new Error('Master daemon state belongs to another Graphyard server'); }, log: line => lines.push(line) })(verifyRow('GY-1827', 'a'.repeat(40)), executorIdentity), (error: Error) => error.message === doesNotCarry('GY-1827', '3100cb653054', 'a'.repeat(12)));
  assert.deepEqual(lines, ['[graphyard-executor] the promotion state could not be read for GY-1827, so the failure stands as it was: Master daemon state belongs to another Graphyard server']);
  await assert.rejects(async () => verifyHandlers(notServing(), { suffix: async () => { throw new Error('unreadable'); } })(verifyRow('GY-1827', 'a'.repeat(40)), executorIdentity), (error: Error) => error.message === doesNotCarry('GY-1827', '3100cb653054', 'a'.repeat(12)), 'no log, no crash: the answer stands either way');
});

test('unit:verify-deployment-awaits-promotion — retried when the promotion lands, the same row observes the release serving and records the deployment', async () => {
  const recorded: unknown[] = [];
  const handler = verifyHandlers(serving, { suffix: async () => null }, recorded);
  const outcome = await handler(verifyRow('GY-1827', 'a'.repeat(40)), executorIdentity);
  assert.match(String(outcome), /observed the release serving 3733d249f020 for GY-1827/);
  assert.deepEqual(recorded.map(entry => (entry as [string])[0]), ['work/id-GY-1827/deployment']);
});
