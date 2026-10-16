import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { actionRecordLimit, actionStall, actionRetryAt, actionRetryMaxMs, actionStallThreshold } from '../src/model/action-progress.js';
import { handoffWaitBound, promotionWaitBoundMs, promotionWaitClause, waitReason } from '../src/model/action-kinds.js';
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
import { noLocalPortsReason, promotionCarryingMerge, promotionFrozenReason, promotionHandoffMs, promotionOffReason } from '../src/daemon/deployment.js';
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
const promotionWait = (plain: string) => `${plain}; ${promotionWaitClause}`;

const stalledGateInstances = [
  { subject: 'GY-1827', release: '3100cb653054', merge: '3733d249f020', attempts: 6, spacing: 3 },
  { subject: 'GY-1828', release: '3733d249f020', merge: '9f9b403b10cd', attempts: 7, spacing: 4 },
  { subject: 'GY-1830', release: '9f9b403b10cd', merge: '1b6ba10e01aa', attempts: 5, spacing: 1 },
] as const;

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

const attentionFor = (key: string, row: ActionRow) => stalledActionAttention({ work: [
  { key, id: `id-${key}`, actionQueue: { actions: [row], history: [] } } as unknown as Work,
], now: stamp(40) });

for (const { subject, release, merge, attempts, spacing } of stalledGateInstances) {
  const plain = doesNotCarry(subject, release, merge);
  test(`${subject}: its verify-deployment run is a stall at the base and files the stalled-action instance through the attention path that filed it`, () => {
    assert.equal(waitReason(plain), false);
    assert.ok(actionStall(failingVerify(subject, plain, attempts, spacing)), 'the unchanged run the ledger held is a stall');
    const attention = attentionFor(subject, failingVerify(subject, plain, attempts, spacing));
    assert.equal(attention.length, 1);
    assert.equal(attention[0].kind, 'stalled-action');
    assert.match(attention[0].text, new RegExp(`${subject}'s verify-deployment action is stalled`));
    const opened = trackFaults(emptyRecord(), classifyAttention(attention), stamp(40));
    assert.deepEqual(opened.map(instance => instance.faultClass), ['stalled-gate']);
  });

  test(`${subject}: the same run is no stall once the promotion pipeline is read and names the wait, and none of the three files an instance at the candidate`, () => {
    const row = failingVerify(subject, promotionWait(plain), attempts, spacing);
    assert.equal(handoffWaitBound(promotionWait(plain)), promotionWaitBoundMs);
    assert.equal(actionStall(row), null, 'the wait is bounded, and the recorded window is inside the bound');
    assert.deepEqual(attentionFor(subject, row), []);
    assert.deepEqual(trackFaults(emptyRecord(), classifyAttention(attentionFor(subject, row)), stamp(40)), []);
    // The wait retries on the ordinary schedule, so the promotion that lands about 20 minutes in is
    // picked up by a retry within minutes, not at the stall backoff's ceiling.
    const retryAt = Date.parse(actionRetryAt(row, new Date(stamp(40))));
    assert.ok(retryAt <= stampMs(40) + actionRetryMaxMs, `the wait is retried on the ordinary schedule (retry at ${retryAt})`);
  });

  test(`${subject}: past the promotion pipeline's own bound the wait is a stall again and files as before`, () => {
    const row = failingVerify(subject, promotionWait(plain), 7, 12); // 72 minutes of one unchanged reason
    assert.ok(actionStall(row), 'a run outlasting the bound is a stall');
    const attention = attentionFor(subject, row);
    assert.equal(attention.length, 1);
    assert.deepEqual(trackFaults(emptyRecord(), classifyAttention(attention), stamp(40)).map(instance => instance.faultClass), ['stalled-gate']);
  });
}

test('a promotion wait whose attempts fill the row\'s retained record inside the bound is still a wait: the run is measured from the row\'s request, and stalls once the row has been open the bound', () => {
  const wait = promotionWait(doesNotCarry('GY-1827', '3100cb653054', 'a'.repeat(12)));
  const full = failingVerify('GY-1827', wait, actionRecordLimit / 2, 5); // ten attempts, the record full, 46 minutes after the request
  assert.equal(full.history.length, actionRecordLimit);
  assert.equal(actionStall(full), null, 'the record filling up inside the bound is not the bound running out (the soak found it stalling at about 55 minutes)');
  assert.deepEqual(attentionFor('GY-1827', full), []);
  assert.ok(actionStall(failingVerify('GY-1827', wait, actionRecordLimit / 2, 7)), 'the same full record 64 minutes after the request is a stall');
  const older = { ...full, requestedAt: stamp(-180) } as ActionRow;
  assert.ok(actionStall(older), 'a full record on a row open three hours may hide where the run began, so it is read as having outlasted the bound, as before');
});

test('the three instances the base filed are one recurring stalled-gate class — the filing of GY-1831 itself — and the candidate files none', () => {
  const base = emptyRecord();
  for (const [index, { subject, release, merge, attempts, spacing }] of stalledGateInstances.entries()) {
    const attention = attentionFor(subject, failingVerify(subject, doesNotCarry(subject, release, merge), attempts, spacing));
    trackFaults(base, classifyAttention(attention), stamp(10 + index * 60));
  }
  const policy = faultClassPolicyFromEnv({});
  const recurrence = recurringClasses(base.instances, [], policy, stampMs(130)).find(entry => entry.faultClass === 'stalled-gate');
  assert.ok(recurrence, 'the three instances recur as one stalled-gate class');
  assert.equal(recurrence!.count, 3);
  assert.equal(recurrence!.file, true);
  assert.deepEqual(recurrence!.recent.map(entry => entry.subject).sort(), ['GY-1827', 'GY-1828', 'GY-1830']);

  const candidate = emptyRecord();
  for (const [index, { subject, release, merge, attempts, spacing }] of stalledGateInstances.entries()) {
    const attention = attentionFor(subject, failingVerify(subject, promotionWait(doesNotCarry(subject, release, merge)), attempts, spacing));
    trackFaults(candidate, classifyAttention(attention), stamp(10 + index * 60));
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

test('a soak is advisory and carries nothing: a candidate that failed for main\'s tip, its soak still running, is a quiet pipeline and the row stalls as before', async () => {
  // PRRT_kwDOUZby-s6tFAey: promotionCycle leaves nothing in flight and dispatches nothing until main moves past the failed cut.
  const failed = promotionState({ cutSha: mainTip, candidates: [{ id: 'rc-1', sha: mainTip.toUpperCase(), cutAt: stamp(2), prs: 1, queued: 0 }],
    soaks: [{ sha: mainTip, status: 'in_progress', conclusion: null, createdAt: stamp(3), url: null }] });
  assert.equal(await carries(failed), false, 'the running soak of the failed candidate names no release that will carry the merge');
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
  // A quiet pipeline whose last candidate already covers main and left nothing queued is not moving: the row stalls as before.
  assert.equal(await carries(promotionState({ cutSha: mainTip, candidates: [{ id: 'rc-1', sha: mainTip, cutAt: stamp(2), prs: 1, queued: 0 }] })), false);
});

test('the gates promotionCycle applies hold the answer — off, frozen and control-plane without ports are never a wait, however the flags read', async () => {
  // Each gate leaves the recorded flags standing from before it closed the drive, so each is read with
  // in flight set and a dispatch due: the answer is still no, and the row stalls as before (B2).
  assert.equal(await carries(promotionState({ inFlight: true, reason: promotionOffReason })), false, 'promotion off dispatches nothing, ever');
  assert.equal(await carries(promotionState({ inFlight: true, reason: promotionFrozenReason({ sha: mainTip, since: stamp(0) }) })), false, 'the main watch’s freeze holds every dispatch');
  assert.equal(await carries(promotionState({ inFlight: true, reason: noLocalPortsReason })), false, 'a control-plane merger without its ports cuts nothing');
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
  assert.equal(await effects.promotionCarryingMerge!(mergeSha), false, 'no cursor, no loop: the failure stands as it was');
  assert.equal(calls.length, 0, 'answering that read nothing and spawned nothing');
  const state = emptyDaemonState(wiringConfig);
  await writeDaemonState(wiringConfig, { ...state, promotion: promotionState({ inFlight: true, reason: inFlightReason }) });
  assert.equal(await effects.promotionCarryingMerge!(mergeSha), true, 'the recorded flight the loop left on its cursor is the wait the executor names');
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

test('the wait clause the executor throws is constant, so the unchanged run accumulates and the bound can hold it', () => {
  assert.match(promotionWaitClause, /promotion pipeline/);
  assert.doesNotMatch(promotionWaitClause, /\b[0-9a-f]{7,40}\b/, 'the clause names no candidate, release or merge');
  assert.doesNotMatch(promotionWaitClause, /\d{2}:\d{2}|minute|count/i, 'the clause names no clock or counter');
  for (const { subject, release, merge } of stalledGateInstances) assert.ok(promotionWait(doesNotCarry(subject, release, merge)).endsWith(promotionWaitClause));
});

// ——— The verify-deployment handler at the candidate ———

const work = (key: string) => ({ key, id: `id-${key}`, stage: 'done', delivery: { mergeSha: 'a'.repeat(40), mergedAt: stamp(0) } }) as unknown as Work;
/** The executor identity a claim runs under — the handler takes it beside the row. */
const executorIdentity = { id: 'executor-a', host: 'host-a' };
const verifyRow = (key: string, mergeSha: string): ActionRow => ({ id: `verify-${key}`, kind: 'verify-deployment', work: `id-${key}`, key,
  inputs: { kind: 'verify-deployment', mergeSha, mergedAt: stamp(0), state: 'done' }, gate: 'merge', refusal: null, reason: '', binding: 'delivery:verify',
  requestedBy: 'graphyard', requestedAt: stamp(0), state: 'pending', claim: null, attempts: 0, history: [] } as unknown as ActionRow);

/** The handlers Graphyard ships, over a snapshot this test holds: only the deployment observation, the promotion read and the log vary. */
function verifyHandlers(observation: unknown, wiring: { promotion?: (mergeSha: string) => Promise<boolean>; log?: (line: string) => void } = {}, recorded: unknown[] = []) {
  return controlPlaneHandlers(() => config, {
    snapshot: async () => ({ work: [work('GY-1827')], now: stamp(30) }),
    mutate: async (path, body) => { recorded.push([path, body]); return {}; },
    agents: () => [], workerCredentials: async () => ({}), producerCredentials: async () => ({}),
    dispatchWorker: async () => { throw new Error('no launch here'); }, launchReview: async () => { throw new Error('no launch here'); },
    launchProducer: async () => { throw new Error('no launch here'); },
    observeDeployment: async () => observation as never,
    ...(wiring.promotion ? { promotionCarryingMerge: wiring.promotion } : {}),
    ...(wiring.log ? { log: wiring.log } : {}),
    postDeployFiler: async () => ({ filer: async () => [], dispose: async () => {} }),
  })['verify-deployment']!;
}

const notServing = (reason?: string) => ({ source: 'endpoint', sha: '3100cb6530540000000000000000000000000000', at: stamp(30), deployed: [], pending: ['GY-1827'], ...(reason ? { reason } : {}) });
const serving = { source: 'endpoint', sha: '3733d249f0200000000000000000000000000000', at: stamp(21), deployed: ['GY-1827'], pending: [] };

test('unit:verify-deployment-awaits-promotion — the handler names the promotion wait while the pipeline carries the merge, and keeps the plain reason otherwise', async () => {
  const rowMerge = 'a'.repeat(12), plain = doesNotCarry('GY-1827', '3100cb653054', rowMerge), row = verifyRow('GY-1827', 'a'.repeat(40));
  await assert.rejects(async () => verifyHandlers(notServing(), { promotion: async () => true })(row, executorIdentity), (error: Error) => error.message === promotionWait(plain));
  await assert.rejects(async () => verifyHandlers(notServing(), { promotion: async () => false })(row, executorIdentity), (error: Error) => error.message === plain);
  await assert.rejects(async () => verifyHandlers(notServing())(row, executorIdentity), (error: Error) => error.message === plain, 'an executor without the promotion read keeps today’s failure');
  await assert.rejects(async () => verifyHandlers(notServing(), { promotion: async () => { throw new Error('the pipeline could not be read'); } })(row, executorIdentity), (error: Error) => error.message === plain, 'an unreadable pipeline reads as not carrying');
  await assert.rejects(async () => verifyHandlers(notServing('containment could not be derived: the base branch could not be fetched'), { promotion: async () => true })(row, executorIdentity), (error: Error) => error.message === 'containment could not be derived: the base branch could not be fetched', 'a read that carries its own reason is not the release-lag shape');
});

test('unit:verify-deployment-awaits-promotion — an unreadable promotion state is logged where the executor’s log goes, and still reads as not carrying', async () => {
  const lines: string[] = [];
  await assert.rejects(async () => verifyHandlers(notServing(), { promotion: async () => { throw new Error('Master daemon state belongs to another Graphyard server'); }, log: line => lines.push(line) })(verifyRow('GY-1827', 'a'.repeat(40)), executorIdentity), (error: Error) => error.message === doesNotCarry('GY-1827', '3100cb653054', 'a'.repeat(12)));
  assert.deepEqual(lines, ['[graphyard-executor] the promotion state could not be read for GY-1827, so the failure stands as it was: Master daemon state belongs to another Graphyard server']);
  await assert.rejects(async () => verifyHandlers(notServing(), { promotion: async () => { throw new Error('unreadable'); } })(verifyRow('GY-1827', 'a'.repeat(40)), executorIdentity), (error: Error) => error.message === doesNotCarry('GY-1827', '3100cb653054', 'a'.repeat(12)), 'no log, no crash: the answer stands either way');
});

test('unit:verify-deployment-awaits-promotion — retried when the promotion lands, the same row observes the release serving and records the deployment', async () => {
  const recorded: unknown[] = [];
  const handler = verifyHandlers(serving, { promotion: async () => false }, recorded);
  const outcome = await handler(verifyRow('GY-1827', 'a'.repeat(40)), executorIdentity);
  assert.match(String(outcome), /observed the release serving 3733d249f020 for GY-1827/);
  assert.deepEqual(recorded.map(entry => (entry as [string])[0]), ['work/id-GY-1827/deployment']);
});
