import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { storeAction } from '../src/daemon/state.js';
import type { FaultKind } from '../src/model/fault-classes.js';
import { trackFaults } from '../src/model/fault-record.js';
import { containmentInMotion, containmentSettleWaitBoundMs, cycleFaults, emptyDaemonState, reworkDecisionInMotion, reworkDecisionWaitBoundMs, runCycle, type DaemonEffects } from '../src/master-daemon.js';
// GY-1337's own exports are read through namespaces, so the base exercise runs these replays and each fails on its assertion.
import * as daemon from '../src/master-daemon.js';
import * as decisionReport from '../src/cli/decision-report.js';
import { terminalDecisions } from '../src/cli/decision-report.js';
import { containmentGraceMs } from '../src/model/containment.js';
import { maxApproverLaunches } from '../src/daemon/decisions.js';
// GY-1346's bound is read through the namespace too, so the base exercise loads this file and its replays fail on their assertions.
import * as decisions from '../src/daemon/decisions.js';
import { humanNeededAttention, mergeWriterMotionBoundMs, mergeWriterMovement, mergeWriterStallAttention, owedAttention } from '../src/cli/owed-report.js';
import { githubUnobservedRefusal, pushRefusal, trialRefusal } from '../src/model/gates.js';
// GY-2053's own exports are read through namespaces (and its summary type as a type), so the base exercise loads this file and each new replay fails on its assertion.
import * as owed from '../src/cli/owed-report.js';
import * as mergeWriterModule from '../src/daemon/cycle-merge-writer.js';
import type { MergeWriterSummary } from '../src/daemon/cycle-merge-writer.js';
import { readDecisions } from '../src/server/decision-ledger.js';
import { humanNeeded, type NextAction } from '../src/model/next-action.js';
import { approverSessionName } from '../src/master.js';
import { RefusedResponse } from '../src/model.js';

// GY-1251 names this file for its proof: manual:fault-class-decision. The master loop filed 5
// decision faults in 24 hours on 5 October 2026, all recorded at 05:12:49.809Z. Each was an
// `owed-decision` line for an item whose open action was `request-rework` — a new head owed after
// a required check failed again on its rerun (four) or the reviewer requested changes (one). The
// shared cause: the fault observation counted that line from the moment the action was computed,
// while the loop was already requesting the rework decision and supervising its approver session
// (cycle-decisions step 4c, routineDecisionActions). Each was owed 15 seconds to 4 minutes: the
// ordinary pace of a rework round, not a decision refused, stale, unanswered or without an approver.
//
// Each instance is replayed as the item stood when the loop recorded it, with the line master
// status reported for it. Against the base each subtest fails: the instance reproduces.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const config = (): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
const observedAt = '2026-10-05T05:12:49.809Z';
const rerun = 'Required CI check test has not passed on the current candidate; rerun: failed again after rerunning its failed jobs';

interface Instance { subject: string; detail: string; owedMs: number; owed: string }
const instances: Instance[] = [
  { subject: 'GY-1168', detail: rerun, owedMs: 4 * 60_000, owed: '4m' },
  { subject: 'GY-1244', detail: rerun, owedMs: 3 * 60_000, owed: '3m' },
  { subject: 'GY-1238', detail: rerun, owedMs: 2 * 60_000, owed: '2m' },
  { subject: 'GY-1062', detail: rerun, owedMs: 60_000, owed: '1m' },
  { subject: 'GY-1124', detail: 'graphyard-reviewer[bot] requested changes on 9a299cadd661; the next head is reviewed afresh', owedMs: 15_000, owed: '15s' },
];

/** The item as it stood: a candidate whose open action is `request-rework`, with the queue row requested `requestedAt`. */
function standing(entry: Instance, requestedAt: string): Work {
  const id = `work-${entry.subject}`, binding = `request-rework:${entry.subject}`;
  const action: NextAction = { kind: 'request-rework', work: id, key: entry.subject, gate: 'test', refusal: entry.detail, reason: `${entry.subject} needs a new head: ${entry.detail}`,
    inputs: { kind: 'request-rework', pr: 700, sha: '9a299cadd661'.padEnd(40, '0'), detail: entry.detail }, llmRole: 'approve-decision', binding };
  return {
    id, key: entry.subject, title: entry.subject, description: '', type: 'bug', priority: 2, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'The behaviour changes as described', proofs: ['unit:behaviour-changes'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/'], stage: 'test', revision: 1, policyRevision: 1,
    createdAt: requestedAt, updatedAt: requestedAt, stageEnteredAt: requestedAt, ready: true, epoch: 1, lease: null, workspaces: [],
    candidate: { sha: '9a299cadd661'.padEnd(40, '0'), baseSha: '1'.repeat(40), pr: 700, branch: `graphyard/${entry.subject.toLowerCase()}-1`, author: 'implementer' },
    submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [], scopeRequest: null,
    nextAction: { ...action, needsHuman: humanNeeded(action)! },
    actionQueue: { actions: [{ id: `row-${entry.subject}`, key: entry.subject, work: id, kind: 'request-rework', gate: 'test', binding, inputs: action.inputs, reason: action.reason,
      refusal: entry.detail, state: 'requested', claim: null, result: null, resolution: null, resolvedAt: null, attempts: 0, history: [], requestedAt, requestedBy: 'graphyard' }], history: [] },
  } as unknown as Work;
}
/** What the loop's fault step records for the item: its own record, the attention master status derives, and the owed line it reports. */
function decisionFaults(work: Work, at: string) {
  const reported = humanNeededAttention({ work: [work], now: at });
  return { reported, faults: cycleFaults(emptyDaemonState(config()), [work], Date.parse(at), { config: config(), reported }).filter(fault => fault.faultClass === 'decision') };
}

for (const entry of instances) test(`manual:fault-class-decision — owed-decision|${entry.subject}|${observedAt} is no fault while the rework round is in motion`, () => {
  const work = standing(entry, new Date(Date.parse(observedAt) - entry.owedMs).toISOString());
  const { reported, faults } = decisionFaults(work, observedAt);
  // The line master status reported is the instance's own text, so the replay is the instance.
  assert.deepEqual(reported.map(line => line.text), [`${entry.subject} needs a new head: ${entry.detail} — no executor may run it; a new head for ${entry.subject} has been owed for ${entry.owed}`]);
  assert.equal(reworkDecisionInMotion(work, Date.parse(observedAt)), true);
  assert.deepEqual(faults.map(fault => fault.kind), [], `${entry.subject}'s rework decision was in motion when the loop recorded it`);
});

test('manual:fault-class-decision — a rework decision owed past the bound, or with nothing dating it, still stands as a fault', () => {
  const [first] = instances;
  const requestedAt = new Date(Date.parse(observedAt) - first.owedMs).toISOString();
  const late = new Date(Date.parse(requestedAt) + reworkDecisionWaitBoundMs + 60_000).toISOString();
  assert.deepEqual(decisionFaults(standing(first, requestedAt), late).faults.map(fault => fault.kind), ['owed-decision']);
  // A row with no requested instant cannot be dated, so it is not taken to be in motion.
  const undated = standing(first, requestedAt);
  (undated.actionQueue!.actions[0] as { requestedAt: string | null }).requestedAt = null;
  assert.deepEqual(decisionFaults(undated, observedAt).faults.map(fault => fault.kind), ['owed-decision']);
});

test('manual:fault-class-decision — an owed escalation is not a rework round: it waits only for the master\'s turn (GY-1346)', () => {
  const work = standing(instances[0], observedAt);
  const action: NextAction = { kind: 'escalate', work: work.id, key: work.key, gate: 'merge', refusal: 'lease lost', reason: `${work.key} lost its lease`,
    inputs: { kind: 'escalate', trigger: 'lease-loss', detail: 'lease lost' } as NextAction['inputs'], llmRole: null, binding: `escalate:${work.key}` };
  work.nextAction = { ...action, needsHuman: humanNeeded(action)! } as Work['nextAction'];
  (work.actionQueue!.actions[0] as { kind: string; binding: string }).kind = 'escalate';
  (work.actionQueue!.actions[0] as { kind: string; binding: string }).binding = action.binding;
  assert.equal(reworkDecisionInMotion(work, Date.parse(observedAt) + 60_000), false);
  assert.deepEqual(decisionFaults(work, new Date(Date.parse(observedAt) + 60_000).toISOString()).faults.map(fault => fault.kind), []);
  assert.deepEqual(decisionFaults(work, new Date(Date.parse(observedAt) + decisions.masterTurnWaitBoundMs + 60_000).toISOString()).faults.map(fault => fault.kind), ['owed-decision']);
});

// GY-1337: three more decision faults in 24 hours, on 5–6 October 2026, from the same cause as
// GY-1251's: a decision wait the product is already moving counted the moment it was seen. Each
// instance is replayed from the ledger snapshot the loop observed (graphyard events --payload full).
//
// - owed-decision|GY-1329|2026-10-05T23:25:31.610Z: the worker submitted at 23:25:16 while its
//   containment fence's deadline (23:27:10) had not passed; the fence's own line was inside its
//   grace window (containmentInMotion), but the owed line restating its escalation counted 15s in.
//   The loop autosettled the fence at 23:25:36.
// - decision-refused|GY-1335|2026-10-06T00:52:38.070Z: the release was refused at 00:47:49 because
//   GY-1332's PR #813 was in review; it counted five minutes later, and the master answered it at
//   01:02:17 with a requirements decision rescoping the item.
// - decision-unanswered|GY-1335|2026-10-06T01:07:20.695Z: the master's approver for that
//   requirements decision (launched 01:05:18) vanished; the line counted two minutes later, and
//   the loop's hand-approver supervision (GY-551) relaunched it at 01:15:04, within its launch bound.

const fence1329 = { at: '2026-10-05T23:11:19.885Z', epoch: 2, owner: 'graphyard-claude-1', scope: { pid: 868275, unit: 'graphyard-watch-868275-d2a79447-115f-4c98-a22c-2a4507dfbc75.scope' },
  leaseExpiresAt: '2026-10-05T23:27:10.056Z', settlementHash: 'd0e9baf497c68912da580f7cae088a7130650372c6daaa1d41b2b23e16031899',
  launchExpiresAt: '2026-10-05T23:13:21.376Z', launchAcknowledgedAt: '2026-10-05T23:11:21.376Z' };
/** GY-1329 as its submit at 23:25:16.524Z left it: lease gone, fence standing, the containment escalation computed at 23:25:15.987Z. */
function fenced1329(): Work {
  const work = standing({ subject: 'GY-1329', detail: '', owedMs: 0, owed: '' }, '2026-10-05T23:25:15.987Z');
  const binding = `quarantine:2:${fence1329.settlementHash}`;
  const action: NextAction = { kind: 'escalate', work: work.id, key: 'GY-1329', gate: null, refusal: null, llmRole: 'resolve-escalation', binding,
    reason: 'GY-1329 is fenced by unverified containment from epoch 2 and nothing may be assigned to it; no executor step lowers a quarantine',
    inputs: { kind: 'escalate', trigger: 'containment', detail: "verify that graphyard-claude-1's worker stopped and settle the epoch 2 quarantine (graphyard master settle-containment GY-1329 REASON), or recover it as a stopped worker" } as NextAction['inputs'] };
  Object.assign(work, { stage: 'review', epoch: 2, lease: null, containmentQuarantine: fence1329, nextAction: { ...action, needsHuman: humanNeeded(action)! } });
  Object.assign(work.actionQueue!.actions[0], { kind: 'escalate', binding, gate: null, state: 'pending' });
  return work;
}

test('manual:fault-class-decision — owed-decision|GY-1329|2026-10-05T23:25:31.610Z is no fault while the fence it restates is in motion', () => {
  const at = '2026-10-05T23:25:31.610Z', work = fenced1329();
  const { reported, faults } = decisionFaults(work, at);
  assert.deepEqual(reported.map(line => line.text), ["GY-1329 is fenced by unverified containment from epoch 2 and nothing may be assigned to it; no executor step lowers a quarantine — no executor may run it; resolving GY-1329's containment refusal has been owed for 15s"]);
  assert.deepEqual(faults.map(fault => fault.kind), [], "GY-1329's fence was still inside its grace window, and the loop settled it 5s later");
  assert.equal(containmentInMotion(work, Date.parse(at)), true);
  assert.equal(daemon.owedContainmentLine(work, reported[0].text), true);
});

test('manual:fault-class-decision — a fence past its settle bound counts once, as the containment fault its owed line restates', () => {
  const work = fenced1329();
  const late = new Date(Date.parse(fence1329.leaseExpiresAt) + containmentGraceMs + containmentSettleWaitBoundMs + 60_000).toISOString();
  const kinds = cycleFaults(emptyDaemonState(config()), [work], Date.parse(late), { config: config(), reported: humanNeededAttention({ work: [work], now: late }) }).map(fault => fault.kind);
  assert.deepEqual(kinds, ['containment']);
  // An owed escalation of any other trigger is not the fence and still counts on sight (see the lease-loss case above).
  assert.equal(daemon.owedContainmentLine(work, 'resolving GY-1329\'s lease-loss escalation has been owed for 15s'), false);
});

const master = 'graphyard-master-graphyard-operator';
const release1335 = { id: '4caa2dd6-9ad2-456e-ac47-4e38218c19e2', action: 'release', state: 'refused', requestedAt: '2026-10-06T00:45:33.194Z', requestedBy: master,
  refusal: { approver: 'graphyard-approver-graphyard', at: '2026-10-06T00:47:49.398Z', reason: "The diagnosis is sound and the code confirms it: src/github.ts:2187 returns 'unconfigured' when no approver is set, main-guard.ts never retries an abandoned merge, and cycle-delivery.ts:86 records the line only once. The release as written still collides with work already in flight. GY-1332's PR #813 (head 17374fbd, in review) already changes src/main-guard.ts and src/daemon/cycle-delivery.ts to " } };
const requirements1335 = { id: 'c3835bc8-93fc-47fd-ac09-31c0f8d0e9c2', action: 'requirements', state: 'requested', requestedAt: '2026-10-06T01:02:17.892Z', requestedBy: master };
const item1335 = { id: 'ee99a47c-bda7-4892-a52b-acf4c8e96039', key: 'GY-1335', stage: 'backlog', ready: false };
/** The decision-report lines for GY-1335 at `at`, with the approval watches and Herdr agents the loop read, and the faults the cycle records from them. */
async function decisionReport1335(decisions: object[], at: string, approvals: Parameters<typeof terminalDecisions>[2]['approvals'] = []) {
  const report = await terminalDecisions(async () => ({ decisions }), [item1335], { approvals, runtime: { available: true, agents: [] }, now: Date.parse(at) });
  const faults = cycleFaults(emptyDaemonState(config()), [], Date.parse(at), { config: config(), reported: report.attentionItems }).filter(fault => fault.faultClass === 'decision');
  return { report, faults };
}

test('manual:fault-class-decision — decision-refused|GY-1335|2026-10-06T00:52:38.070Z is no fault while the master answers it', async () => {
  const at = '2026-10-06T00:52:38.070Z';
  const { report, faults } = await decisionReport1335([release1335], at);
  assert.equal(report.attentionItems.length, 1);
  assert.match(report.attentionItems[0].text, /^Decision 4caa2dd6-9ad2-456e-ac47-4e38218c19e2 \(release\) was refused by graphyard-approver-graphyard: The diagnosis is sound/);
  assert.deepEqual(faults.map(fault => fault.kind), [], 'the refusal was 5 minutes old; the master answered it 15 minutes later');
  assert.equal(report.attentionItems[0].inMotionUntil, new Date(Date.parse(release1335.refusal.at) + decisionReport.refusalAnswerWaitBoundMs).toISOString());
  // Answered at 01:02:17 by a decision of another action, it raises nothing more, though no later release stands.
  const answered = await decisionReport1335([release1335, requirements1335], '2026-10-06T01:30:00.000Z', [{ work: 'GY-1335', decision: requirements1335.id, agentName: 'gy-approver-gy-1335-c3835bc8', launches: 1, launchedAt: '2026-10-06T01:18:12.618Z', settledAt: null }]);
  assert.deepEqual(answered.report.attentionItems.filter(item => item.text.includes(release1335.id)), []);
  assert.equal(answered.report.listed.some(entry => entry.id === release1335.id && entry.state === 'refused'), true, 'the refusal is still listed for the record');
});

test('manual:fault-class-decision — a refusal nobody answers within the bound still counts', async () => {
  const late = new Date(Date.parse(release1335.refusal.at) + decisionReport.refusalAnswerWaitBoundMs + 60_000).toISOString();
  assert.deepEqual((await decisionReport1335([release1335], late)).faults.map(fault => fault.kind), ['decision-refused']);
  // A later decision the requester took back is no answer, nor is one somebody else asked for.
  assert.deepEqual((await decisionReport1335([release1335, { ...requirements1335, state: 'withdrawn' }], late)).faults.map(fault => fault.kind), ['decision-refused']);
  assert.deepEqual((await decisionReport1335([release1335, { ...requirements1335, state: 'applied', requestedBy: 'graphyard-master' }], late)).faults.map(fault => fault.kind), ['decision-refused']);
});

const handWatch1335 = { work: 'GY-1335', action: 'requirements', decision: requirements1335.id, agentName: 'gy-approver-gy-1335-c3835bc8', launches: 1, launchedAt: '2026-10-06T01:05:18.944Z', settledAt: null, exhaustedAt: null, ended: [] };

test('manual:fault-class-decision — decision-unanswered|GY-1335|2026-10-06T01:07:20.695Z is no fault while the loop relaunches its approver', async () => {
  const at = '2026-10-06T01:07:20.695Z';
  // The line was built by a status read that saw the decision six minutes old.
  const read = await terminalDecisions(async () => ({ decisions: [release1335, requirements1335] }), [item1335], { approvals: [handWatch1335], runtime: { available: true, agents: [] }, now: Date.parse('2026-10-06T01:08:18.000Z') });
  const line = read.attentionItems.find(item => item.text.startsWith(`Decision ${requirements1335.id}`))!;
  assert.equal(line.text, `Decision ${requirements1335.id} (requirements) is unanswered after 6m: approver session gy-approver-gy-1335-c3835bc8 is not running and recorded no outcome — a stall, not a refusal`);
  const faults = cycleFaults(emptyDaemonState(config()), [], Date.parse(at), { config: config(), reported: [line] }).filter(fault => fault.faultClass === 'decision');
  assert.deepEqual(faults.map(fault => fault.kind), [], 'the loop relaunched the approver at 01:15:04, inside the bound');
  assert.equal(line.inMotionUntil, new Date(Date.parse(handWatch1335.launchedAt) + decisionReport.approverRelaunchWaitBoundMs).toISOString());
  assert.ok(Date.parse('2026-10-06T01:15:04.384Z') < Date.parse(line.inMotionUntil!));
});

test('manual:fault-class-decision — an unanswered decision with its launches spent, unwatched or past the bound still counts', async () => {
  const kinds = async (approvals: Parameters<typeof terminalDecisions>[2]['approvals'], at: string) =>
    (await decisionReport1335([requirements1335], at, approvals)).faults.map(fault => fault.kind);
  const at = '2026-10-06T01:07:20.695Z';
  // No watch: the master's to put to an approver, so it counts once the master's turn has passed (GY-1346).
  assert.deepEqual(await kinds([], new Date(Date.parse(requirements1335.requestedAt) + decisions.masterTurnWaitBoundMs + 60_000).toISOString()), ['decision-unanswered'], 'no watch, past the master\'s turn');
  assert.deepEqual(await kinds([{ ...handWatch1335, launches: maxApproverLaunches }], at), ['decision-unanswered'], 'launches spent');
  assert.deepEqual(await kinds([{ ...handWatch1335, exhaustedAt: '2026-10-06T01:06:00.000Z' }], at), ['decision-unanswered'], 'escalated as unjudged');
  const late = new Date(Date.parse(handWatch1335.launchedAt) + decisionReport.approverRelaunchWaitBoundMs + 60_000).toISOString();
  assert.deepEqual(await kinds([handWatch1335], late), ['decision-unanswered'], 'past the relaunch bound');
});

// GY-1346: three more decision faults in 24 hours, on 6 October 2026, from GY-1337's cause in the
// lanes it left: a wait only the master's turn moves counted the moment it was seen.
//
// - decision-unanswered|GY-1338: the master asked for requirements decision f8a7ec3d at 02:41:24 and
//   launched its approver at 03:01:16 (.graphyard/approvers/launches.json), which declined it at
//   03:02:06; the line counted 17 minutes in, while no watch existed for the loop to relaunch.
// - decision-unanswered|GY-1335: the master asked for resolve decision bbc92e6a at 03:05:42 and the
//   line counted one minute later, before the master's approver launch.
// - owed-decision|GY-1335|2026-10-06T03:06:13.542Z: the requirement-weakening escalation's row was
//   queued at 03:02:55 and counted 3 minutes in — 31 seconds after the master had asked for the
//   resolve decision above. Replayed from the ledger snapshot the loop observed (tests/fixtures).

const master1346 = 'graphyard-master-graphyard-operator';
const unanswered1346 = [
  { item: { id: '4932070a-203a-45e7-9825-90047f7054b9', key: 'GY-1338', stage: 'backlog', ready: false }, age: '17m',
    decision: { id: 'f8a7ec3d-e828-4a9c-bc28-147ff7be3edc', action: 'requirements', state: 'requested', requestedAt: '2026-10-06T02:41:24.958Z', requestedBy: master1346 } },
  { item: { id: 'ee99a47c-bda7-4892-a52b-acf4c8e96039', key: 'GY-1335', stage: 'build', ready: true }, age: '1m',
    decision: { id: 'bbc92e6a-b2b6-4423-8505-c3d6df4ef7ac', action: 'resolve', state: 'requested', requestedAt: '2026-10-06T03:05:42.740Z', requestedBy: master1346 } },
];
/** The unanswered line for the decision `ageMs` after its request, with no approval watch and no live approver session, and the decision faults the cycle records from it. */
async function unansweredReplay(entry: typeof unanswered1346[number], ageMs: number) {
  const now = Date.parse(entry.decision.requestedAt) + ageMs;
  const report = await terminalDecisions(async () => ({ decisions: [entry.decision] }), [entry.item], { approvals: [], runtime: { available: true, agents: [] }, now });
  const faults = cycleFaults(emptyDaemonState(config()), [], now, { config: config(), reported: report.attentionItems }).filter(fault => fault.faultClass === 'decision');
  return { report, faults };
}

for (const entry of unanswered1346) test(`manual:fault-class-decision — decision-unanswered|${entry.item.key} (${entry.decision.id.slice(0, 8)}, ${entry.age}) is no fault inside the master's turn`, async () => {
  const { report, faults } = await unansweredReplay(entry, (parseInt(entry.age) * 60 + 10) * 1000);
  const session = `gy-approver-${entry.item.key.toLowerCase()}-${entry.decision.id.slice(0, 8)}`;
  assert.deepEqual(report.attentionItems.map(item => item.text), [`Decision ${entry.decision.id} (${entry.decision.action}) is unanswered after ${entry.age}: approver session ${session} is not running and recorded no outcome — a stall, not a refusal`]);
  assert.deepEqual(faults.map(fault => fault.kind), [], 'the master asked for it and had not yet put it to an approver');
  assert.equal(report.attentionItems[0].inMotionUntil, new Date(Date.parse(entry.decision.requestedAt) + decisions.masterTurnWaitBoundMs).toISOString());
  // The line still stands in master status: the bound only defers the fault.
  assert.equal(report.unanswered.length, 1);
});

test('manual:fault-class-decision — an unwatched decision past the master\'s turn, or with no instant to date it, still counts', async () => {
  const [entry] = unanswered1346;
  assert.deepEqual((await unansweredReplay(entry, decisions.masterTurnWaitBoundMs + 60_000)).faults.map(fault => fault.kind), ['decision-unanswered']);
  assert.equal(decisionReport.unansweredInMotionUntil(undefined, 'not a date'), undefined);
});

const fixture1346 = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/gy-1346-decision-faults.json', import.meta.url)), 'utf8')) as { work: Work };

test('manual:fault-class-decision — owed-decision|GY-1335|2026-10-06T03:06:13.542Z is no fault inside the master\'s turn to resolve the escalation', () => {
  const at = '2026-10-06T03:06:13.542Z', work = structuredClone(fixture1346.work);
  const { reported, faults } = decisionFaults(work, at);
  assert.deepEqual(reported.map(line => line.text), ["GY-1335 has a standing requirement-weakening escalation and nothing else to do: Requirement revision retires AC-1, AC-2, AC-5 and narrows proofs for no criterion — no executor may run it; resolving GY-1335's requirement-weakening escalation has been owed for 3m"]);
  assert.deepEqual(faults.map(fault => fault.kind), [], 'the master asked for the resolve decision 31s before the loop counted the line');
  assert.equal(daemon.owedEscalationInMotion(work, reported[0].text, Date.parse(at)), true);
});

test('manual:fault-class-decision — an owed escalation past the master\'s turn, undated, or a containment one still counts as before', () => {
  const work = structuredClone(fixture1346.work);
  const late = new Date(Date.parse(work.actionQueue!.actions[0].requestedAt!) + decisions.masterTurnWaitBoundMs + 60_000).toISOString();
  assert.deepEqual(decisionFaults(work, late).faults.map(fault => fault.kind), ['owed-decision']);
  const undated = structuredClone(fixture1346.work);
  (undated.actionQueue!.actions[0] as { requestedAt: string | null }).requestedAt = null;
  assert.deepEqual(decisionFaults(undated, '2026-10-06T03:06:13.542Z').faults.map(fault => fault.kind), ['owed-decision']);
  // A containment escalation's owed line is the fence's (owedContainmentLine), never the master's turn.
  assert.equal(daemon.owedEscalationInMotion(fenced1329(), "resolving GY-1329's containment refusal has been owed for 15s", Date.parse('2026-10-05T23:25:31.610Z')), false);
});

// GY-1349: four decision faults in 24 hours on GY-1338, on 6 October 2026, replayed from the ledger
// (graphyard events GY-1338 --payload full). The master asked for release 77cccf4c at 03:55:53 and
// resolve 19b70cd4 at 03:57:09; the release was applied at 04:11:33, and the resolve went stale at
// 04:13:09 when the dispatch that followed moved the item's revision under its approver.
//
// - decision-unanswered|GY-1338 (release 77cccf4c, 10m) and (resolve 19b70cd4, 9m): unwatched
//   decisions inside the master's turn, which GY-1346's bound already defers on the base.
// - owed-decision|GY-1338|2026-10-06T04:13:35.901Z: the requirement-weakening escalation's row was
//   queued at 04:12:06 and counted a minute in, inside GY-1346's owedEscalationInMotion on the base.
// - decision-stale|GY-1338|2026-10-06T04:13:35.901Z: the residue. A stale decision of any action
//   but release is requested again by nothing but the master's next turn, yet its line counted 26
//   seconds after it went stale — the shape GY-1337 and GY-1346 removed for every sibling wait.

const master1349 = 'graphyard-master-graphyard-operator';
const item1338 = { id: '4932070a-203a-45e7-9825-90047f7054b9', key: 'GY-1338', stage: 'build', ready: true };
const release1349 = { id: '77cccf4c-484b-44c7-8d20-28db36f084bd', action: 'release', state: 'requested', requestedAt: '2026-10-06T03:55:53.223Z', requestedBy: master1349 };
const resolve1349 = { id: '19b70cd4-550e-4802-b214-caf8dbb30696', action: 'resolve', state: 'requested', requestedAt: '2026-10-06T03:57:09.496Z', requestedBy: master1349 };
const staleResolve1349 = { ...resolve1349, state: 'stale', staleAt: '2026-10-06T04:13:09.269Z', outcome: 'Task revision changed (now 36); reload and request again; the decision was not applied',
  race: { expected: { epoch: 0, lease: null }, current: { epoch: 1, lease: 1 } } };
const observed1349 = '2026-10-06T04:13:35.901Z';
/** The decision-report lines for GY-1338 at `now` with no approval watch and no live approver, and the decision faults the cycle records from them at `at`. */
async function report1338(rows: object[], now: number, at = now) {
  const report = await terminalDecisions(async () => ({ decisions: rows }), [{ ...item1338, stage: 'backlog', ready: false }], { approvals: [], runtime: { available: true, agents: [] }, now });
  return { report, faults: cycleFaults(emptyDaemonState(config()), [], at, { config: config(), reported: report.attentionItems }).filter(fault => fault.faultClass === 'decision').map(fault => fault.kind) };
}

for (const [decision, age] of [[release1349, '10m'], [resolve1349, '9m']] as const) test(`manual:fault-class-decision — decision-unanswered|GY-1338 (${decision.id.slice(0, 8)}, ${age}) is no fault inside the master's turn`, async () => {
  const { report, faults } = await report1338([decision], Date.parse(decision.requestedAt) + (parseInt(age) * 60 + 10) * 1000);
  assert.deepEqual(report.attentionItems.map(item => item.text), [`Decision ${decision.id} (${decision.action}) is unanswered after ${age}: approver session gy-approver-gy-1338-${decision.id.slice(0, 8)} is not running and recorded no outcome — a stall, not a refusal`]);
  assert.deepEqual(faults, [], 'the master asked for it and its turn to put it to an approver had not passed');
});

test('manual:fault-class-decision — decision-stale|GY-1338|2026-10-06T04:13:35.901Z is no fault inside the master\'s turn to request it again', async () => {
  const { report, faults } = await report1338([{ ...release1349, state: 'applied', outcome: 'Released to ready' }, staleResolve1349], Date.parse(observed1349));
  assert.deepEqual(report.attentionItems.map(item => item.text), [`Decision ${resolve1349.id} (resolve) is stale: Task revision changed (now 36); reload and request again; the decision was not applied; request it again, the stale decision no longer blocks`]);
  assert.deepEqual(faults, [], 'the resolve went stale 26s before the loop counted it, and only the master requests it again');
  assert.equal(report.attentionItems[0].inMotionUntil, new Date(Date.parse(staleResolve1349.staleAt) + decisionReport.staleDecisionWaitBoundMs).toISOString());
  assert.equal(decisionReport.staleDecisionWaitBoundMs, decisions.masterTurnWaitBoundMs);
});

test('manual:fault-class-decision — a stale decision past the master\'s turn still counts, dated from its request when the record has no stale instant', async () => {
  const late = Date.parse(staleResolve1349.staleAt) + decisions.masterTurnWaitBoundMs + 60_000;
  assert.deepEqual((await report1338([staleResolve1349], late)).faults, ['decision-stale']);
  const { staleAt: _, ...undated } = staleResolve1349;
  const fromRequest = await report1338([undated], Date.parse(observed1349));
  assert.equal(fromRequest.report.attentionItems[0].inMotionUntil, new Date(Date.parse(resolve1349.requestedAt) + decisions.masterTurnWaitBoundMs).toISOString());
  assert.deepEqual((await report1338([undated], Date.parse(resolve1349.requestedAt) + decisions.masterTurnWaitBoundMs + 60_000)).faults, ['decision-stale']);
  // A later decision of the same action supersedes it, so nothing is owed at all.
  assert.deepEqual((await report1338([staleResolve1349, { ...resolve1349, id: 'later', requestedAt: '2026-10-06T04:20:00.000Z' }], late)).report.attentionItems.filter(item => item.text.includes('is stale')), []);
});

const fixture1349 = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/gy-1349-decision-faults.json', import.meta.url)), 'utf8')) as { work: Work };

test('manual:fault-class-decision — owed-decision|GY-1338|2026-10-06T04:13:35.901Z is no fault inside the master\'s turn to resolve the escalation', () => {
  const work = structuredClone(fixture1349.work);
  const { reported, faults } = decisionFaults(work, observed1349);
  assert.deepEqual(reported.map(line => line.text), ["GY-1338 has a standing requirement-weakening escalation and nothing else to do: Requirement revision retires AC-1, AC-3, AC-4, AC-6 and narrows proofs for no criterion — no executor may run it; resolving GY-1338's requirement-weakening escalation has been owed for 1m"]);
  assert.deepEqual(faults.map(fault => fault.kind), [], 'the escalation row was queued at 04:12:06, a minute before the loop counted it');
  const late = new Date(Date.parse(work.actionQueue!.actions.find(row => row.kind === 'escalate')!.requestedAt!) + decisions.masterTurnWaitBoundMs + 60_000).toISOString();
  assert.deepEqual(decisionFaults(structuredClone(fixture1349.work), late).faults.map(fault => fault.kind), ['owed-decision']);
});

test('manual:fault-class-decision — the decision ledger records when a decision went stale, the instant the master\'s turn starts', async () => {
  const rows = [
    { actor: master1349, kind: 'decision.requested', created_at: resolve1349.requestedAt, payload: { id: resolve1349.id, action: 'resolve', input: { trigger: 'requirement-weakening', expectedRevision: 21 }, reason: 'resolve it', requester: { id: master1349, role: 'operator-agent' } } },
    { actor: 'graphyard-approver-graphyard', kind: 'decision.stale', created_at: staleResolve1349.staleAt, payload: { id: resolve1349.id, action: 'resolve', reason: staleResolve1349.outcome, expected: null, current: null } },
  ];
  const [decision] = await readDecisions({ query: (async () => ({ rows })) as never }, { id: item1338.id } as Work);
  assert.equal(decision.state, 'stale');
  assert.equal(decision.staleAt, staleResolve1349.staleAt);
});

// GY-1374, instance owed-decision|GY-1373|2026-10-06T14:03:39.561Z: GY-1373's worker lost its lease
// at 14:03:13 and the control plane raised the lease-loss escalation itself. The item was ready to
// be dispatched again, so the escalation was carried beside that dispatch with no queue row of its
// own, and owedEscalationInMotion — which dated the master's turn only from an `escalate` row —
// counted the owed line 25 seconds in. Replayed from the ledger snapshot the loop observed.
const fixture1374 = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/gy-1374-decision-faults.json', import.meta.url)), 'utf8')) as { work: Work };

test('manual:fault-class-decision — owed-decision|GY-1373|2026-10-06T14:03:39.561Z is no fault inside the master\'s turn to resolve the carried escalation', () => {
  const at = '2026-10-06T14:03:39.561Z', work = structuredClone(fixture1374.work);
  const { reported, faults } = decisionFaults(work, at);
  assert.deepEqual(reported.map(line => line.text), ["GY-1373 carries a standing lease-loss escalation while it is worked: Worker graphyard-claude-1 lost lease epoch 1 — no executor may run it; resolving GY-1373's lease-loss escalation has been owed for 25s"]);
  assert.deepEqual(faults.map(fault => fault.kind), [], 'the escalation was raised 25s before the loop counted its line');
  assert.equal(daemon.owedEscalationInMotion(work, reported[0].text, Date.parse(at)), true);
});

test('manual:fault-class-decision — a carried escalation past the master\'s turn, or a carried containment one, still counts', () => {
  const work = structuredClone(fixture1374.work);
  const late = new Date(Date.parse('2026-10-06T14:03:13.938Z') + decisions.masterTurnWaitBoundMs + 60_000).toISOString();
  assert.deepEqual(decisionFaults(work, late).faults.map(fault => fault.kind), ['owed-decision']);
  const fenced = structuredClone(fixture1374.work);
  const carried = (fenced.nextAction as unknown as { carried: { trigger: string }[] }).carried;
  carried[0].trigger = 'containment';
  const line = "GY-1373 carries a standing containment escalation while it is worked — no executor may run it; resolving GY-1373's containment escalation has been owed for 25s";
  assert.equal(daemon.owedEscalationInMotion(fenced, line, Date.parse('2026-10-06T14:03:39.561Z')), false, 'a containment concern is counted as its fence is');
});

// GY-1751, three instances in 24 hours. (1) action:decision on GOAL-1, 2026-10-12T23:43:05.011Z: the acceptance land step met the
// plane's startup-readiness 503 and recorded a decision fault though it asks again in five minutes. (2) decision-unanswered and
// action:escalation on GY-1710, ten seconds apart: one stuck close decision, counted as two instances.
const goalAccepted = (id: string) => ({ id, key: 'GOAL-1', stage: 'accepted', revision: 3, acceptance: { pr: 1153, outcomes: [] } }) as never;
async function landFailure(failure: Error, id: string) {
  const { acceptanceStep } = await import('../src/daemon/acceptance.js');
  const state = emptyDaemonState(config());
  const effects = { settings: { enabled: true }, goals: async () => [goalAccepted(id)], land: async () => { throw failure; } };
  const clock = Date.parse('2026-10-12T23:43:05.011Z');
  await acceptanceStep({ config: config(), state, effects: { acceptance: effects, persist: async () => {} }, now: () => clock, clock, performed: [],
    isolate: async (_k: string, _i: unknown, _n: string, body: () => Promise<unknown>) => body() } as never);
  return state;
}

test('manual:fault-class-decision — action:decision|GOAL-1|2026-10-12T23:43:05.011Z: a land step that met the plane\'s startup-readiness 503 is no decision fault', async () => {
  const state = await landFailure(new Error('Graphyard refused goals/GOAL-1/land (503): Startup validation has not completed; retry shortly'), 'goal-503');
  assert.equal(state.actions['acceptance:goal-503']?.state, 'failed', 'the step still records that it will ask again');
  assert.deepEqual(state.faults.instances, []);
  assert.deepEqual(state.faults.failing, {});
});

test('manual:fault-class-decision — a land step the goal itself was refused still counts as a decision fault', async () => {
  const state = await landFailure(new Error('Graphyard refused goals/GOAL-1/land (409): the approved head moved'), 'goal-409');
  assert.deepEqual(state.faults.instances.map(entry => entry.kind), ['action:decision']);
});

test('manual:fault-class-decision — decision-unanswered|GY-1710 and action:escalation|GY-1710 are one stuck decision, one instance', () => {
  const id = '65bf0fef-d9c1-4cd2-8467-9f1866b0fd41', state = emptyDaemonState(config());
  const unanswered = `Decision ${id} (close) is unanswered after 41m: approver session gy-approver-gy-1710-65bf0fef is not running and recorded no outcome — a stall, not a refusal`;
  trackFaults(state.faults, [{ kind: 'decision-unanswered', faultClass: 'decision', subject: 'GY-1710', text: unanswered }], '2026-10-12T02:16:40.081Z');
  storeAction(state, `escalation:decision-unjudged:${id}`, { kind: 'escalation', work: 'GY-1710', principal: null, state: 'failed', detail: `close decision ${id} on GY-1710: approver session has not judged it for 10 minutes`, attempts: 1, cycle: 1, at: '2026-10-12T02:16:50.965Z', epoch: null }, undefined);
  assert.deepEqual(state.faults.instances.map(entry => entry.kind), ['decision-unanswered'], 'the exhaustion escalation restates the stall');
  // Recorded first, in the other observation order, it is the same one instance.
  const fresh = emptyDaemonState(config());
  storeAction(fresh, `escalation:decision-unjudged:${id}`, { kind: 'escalation', work: 'GY-1710', principal: null, state: 'failed', detail: 'x', attempts: 1, cycle: 1, at: '2026-10-12T02:16:30.000Z', epoch: null }, undefined);
  trackFaults(fresh.faults, [{ kind: 'decision-unanswered', faultClass: 'decision', subject: 'GY-1710', text: unanswered }], '2026-10-12T02:16:40.081Z');
  assert.deepEqual(fresh.faults.instances.map(entry => entry.kind), ['decision-unanswered']);
});

test('manual:fault-class-decision — an exhaustion escalation whose decision was never observed unanswered stays an instance', () => {
  const id = '11111111-d9c1-4cd2-8467-9f1866b0fd41', state = emptyDaemonState(config());
  storeAction(state, `escalation:decision-unjudged:${id}`, { kind: 'escalation', work: 'GY-1710', principal: null, state: 'failed', detail: 'close decision: not judged', attempts: 1, cycle: 1, at: '2026-10-12T02:16:50.965Z', epoch: null }, undefined);
  // The decision settles before any successful observation: no unanswered line ever stands.
  trackFaults(state.faults, [], '2026-10-12T02:17:40.000Z');
  trackFaults(state.faults, [], '2026-10-12T02:17:50.000Z');
  assert.deepEqual(state.faults.instances.map(entry => entry.kind), ['action:escalation'], 'the real exhausted run is not dropped');
});

test('manual:fault-class-decision — an acceptance failure from a GitHub child process is a decision fault even when it quotes a 502', async () => {
  const { ChildProcessError } = await import('../src/child-runner.js');
  const failure = new ChildProcessError('gh', ['pr', 'close', '1153'], { stdout: '', stderr: 'HTTP 502 Bad Gateway', status: 1, signal: null, timedOut: false });
  const state = await landFailure(failure, 'goal-gh');
  assert.deepEqual(state.faults.instances.map(entry => entry.kind), ['action:decision']);
});

test('manual:fault-class-decision — a goal wait past its bound that quotes an HTTP 503 still counts; only the caught plane-wide error is exempt', async () => {
  const { acceptanceStep } = await import('../src/daemon/acceptance.js');
  const state = emptyDaemonState(config());
  const approved = '2026-10-10T00:00:00.000Z', clock = Date.parse(approved) + 3 * 86_400_000;
  const goal = { id: 'goal-wait', key: 'GOAL-2', stage: 'accepted', revision: 3, approval: { at: approved }, acceptance: { pr: 1153, outcomes: [] } } as never;
  const effects = { settings: { enabled: true }, goals: async () => [goal], land: async () => ({ goal, landing: { state: 'waiting', detail: 'GitHub has not merged: HTTP 503 Startup validation has not completed' } }) };
  await acceptanceStep({ config: config(), state, effects: { acceptance: effects, persist: async () => {} }, now: () => clock, clock, performed: [],
    isolate: async (_k: string, _i: unknown, _n: string, body: () => Promise<unknown>) => body() } as never);
  assert.deepEqual(state.faults.instances.map(entry => entry.kind), ['action:decision']);
});

// GY-1751 review: the real acceptance step and fault record over cycles of two simulated days.
test('manual:fault-class-decision — over two simulated days a plane-wide land failure files none, and a goal refusal that follows files one', async () => {
  const { RefusedResponse } = await import('../src/model/refusal.js');
  const { acceptanceStep } = await import('../src/daemon/acceptance.js');
  const state = emptyDaemonState(config()), day = 86_400_000, start = Date.parse('2026-10-12T00:00:00.000Z');
  let failure: Error = new RefusedResponse('Graphyard refused goals/G/land (503): Startup validation has not completed; retry shortly', 503, { error: 'Startup validation has not completed; retry shortly' });
  const goal = { id: 'g', key: 'GOAL-1', stage: 'accepted', revision: 1, acceptance: { pr: 1, outcomes: [] } };
  const effects = { settings: { enabled: true }, goals: async () => [goal], land: async () => { throw failure; } };
  for (let at = 0; at < 2 * day; at += 300_000) {
    const clock = start + at;
    await acceptanceStep({ config: config(), state, effects: { acceptance: effects, persist: async () => {} }, now: () => clock, clock, performed: [],
      isolate: async (_k: string, _i: unknown, _n: string, body: () => Promise<unknown>) => body() } as never);
    if (at === day) { assert.deepEqual(state.faults.instances, [], 'a day of plane-wide failures files none'); failure = new RefusedResponse('Graphyard refused goals/G/land (409): the approved head moved while the base was unavailable', 409, { error: 'the approved head moved' }); }
  }
  assert.deepEqual(state.faults.instances.map(entry => entry.kind), ['action:decision']);
});

// GY-1751 review round 5: three paths by which the restated stall still counted twice.
const stall = (id: string) => `Decision ${id} (close) is unanswered after 41m: approver session gy-approver-gy-1710-${id.slice(0, 8)} is not running and recorded no outcome — a stall, not a refusal`;
const exhaust = (state: ReturnType<typeof emptyDaemonState>, id: string, at: string) => storeAction(state, `escalation:decision-unjudged:${id}`, { kind: 'escalation', work: 'GY-1710', principal: null, state: 'failed', detail: `close decision ${id}: not judged`, attempts: 1, cycle: 1, at, epoch: null }, undefined);

test('manual:fault-class-decision — an escalation recorded before its unanswered line is observed is not an instance of its own', () => {
  const id = '22222222-d9c1-4cd2-8467-9f1866b0fd41', state = emptyDaemonState(config());
  exhaust(state, id, '2026-10-12T02:16:50.000Z');
  assert.equal(state.faults.instances.length, 0, 'nothing counts before an observation has looked for the unanswered line');
  trackFaults(state.faults, [{ kind: 'decision-unanswered', faultClass: 'decision', subject: 'GY-1710', text: stall(id) }], '2026-10-12T02:16:55.000Z');
  assert.deepEqual(state.faults.instances.map(entry => entry.kind), ['decision-unanswered']);
});

test('manual:fault-class-decision — a standing unanswered line that names another decision absorbs that decision\'s escalation', () => {
  const first = '33333333-d9c1-4cd2-8467-9f1866b0fd41', second = '44444444-d9c1-4cd2-8467-9f1866b0fd41', state = emptyDaemonState(config());
  trackFaults(state.faults, [{ kind: 'decision-unanswered', faultClass: 'decision', subject: 'GY-1710', text: stall(first) }], '2026-10-12T02:00:00.000Z');
  exhaust(state, second, '2026-10-12T02:10:00.000Z');
  trackFaults(state.faults, [{ kind: 'decision-unanswered', faultClass: 'decision', subject: 'GY-1710', text: stall(second) }], '2026-10-12T02:11:00.000Z');
  assert.deepEqual(state.faults.instances.map(entry => entry.kind), ['decision-unanswered']);
});

test('manual:fault-class-decision — an exhausted run whose decision was never unanswered is an instance once, however often it settles', () => {
  const id = '55555555-d9c1-4cd2-8467-9f1866b0fd41', state = emptyDaemonState(config());
  exhaust(state, id, '2026-10-12T02:16:50.000Z');
  trackFaults(state.faults, [], '2026-10-12T02:16:55.000Z'); trackFaults(state.faults, [], '2026-10-12T02:17:55.000Z');
  assert.deepEqual(state.faults.instances.map(entry => entry.kind), ['action:escalation']);
});

test('manual:fault-class-decision — a partial observation settles no held escalation; the next full one does', () => {
  const id = '66666666-d9c1-4cd2-8467-9f1866b0fd41', state = emptyDaemonState(config());
  exhaust(state, id, '2026-10-12T02:16:50.000Z');
  trackFaults(state.faults, [], '2026-10-12T02:16:55.000Z', true);
  trackFaults(state.faults, [], '2026-10-12T02:17:55.000Z', new Set(['decision-unanswered']));
  assert.equal(state.faults.instances.length, 0);
  trackFaults(state.faults, [], '2026-10-12T02:18:55.000Z');
  assert.deepEqual(state.faults.instances.map(entry => entry.kind), ['action:escalation']);
});

// GY-1764 names this file for GY-1763's two instances (decision class, subjects GY-1696 and GY-1761): decision formation had no
// evidence gate. Each is replayed as the item stood; the candidate forms no decision the evidence refutes.
test('integration:fault-class-decision-gy-1763-replay — GY-1696\'s two ask shapes produce no approver decision and no decision-refused fault', async () => {
  const { nonRepositoryPaths } = await import('../src/model/scope-repository.js');
  const { decideScopeRequest } = await import('../src/model/scope.js');
  const tree = new Set(['src/model/scope.ts', 'src/daemon/cycle-scope.ts', 'README.md']);
  const at = '2026-10-13T05:26:00.000Z', now = Date.parse('2026-10-13T05:26:30.000Z');
  const criteria = [{ id: 'AC-1', text: 'The live observation is recorded by a master session', proofs: ['manual:checkout-restore'] }];
  for (const paths of [['daemon.relea', 'upgrade.align'], ['.graphyard/master.json']]) {
    const request = { epoch: 1, paths, reason: 'AC-1 needs the live fields', requestedBy: 'graphyard-opencode-1', at };
    const standing = (decision: ReturnType<typeof decideScopeRequest> & { decidedBy?: string }) => ({
      key: 'GY-1696', stage: 'build', plannedFiles: [] as string[], criteria, lease: { epoch: 1, expiresAt: '2026-10-13T06:26:00.000Z' },
      scopeRequest: { ...request, decision: { state: decision.state, reason: decision.reason, paths, at, decidedBy: 'graphyard', waitedMs: 0, requestedBy: request.requestedBy, requestedAt: at, epoch: 1, ...(decision.nonRepository ? { nonRepository: true } : {}), treeRead: true } },
    } as unknown as Work);
    // Base: the rule judges implication alone, refuses the ask, and the loop routes it to the approver, who refuses it (decision-refused).
    const base = standing(decideScopeRequest({ plannedFiles: [], criteria }, request));
    assert.ok(decisions.scopeRoutineDecision(base, now, true), `${paths.join(', ')}: the base routes the ask to the approver`);
    // A refusal the tree was never read for (a failed read, a typed ask) is never routed: it waits for the evidence.
    const unread = standing(decideScopeRequest({ plannedFiles: [], criteria }, request));
    delete (unread.scopeRequest!.decision as { treeRead?: boolean }).treeRead;
    assert.equal(decisions.scopeRoutineDecision(unread, now, true), null, `${paths.join(', ')}: an unevidenced refusal is not routed`);
    // Candidate: the evidence gate refuses it in-process, with the offending path named, and nothing is routed.
    const gated = decideScopeRequest({ plannedFiles: [], criteria }, request, { nonRepository: nonRepositoryPaths(paths, tree) });
    assert.equal(gated.state, 'refused');
    assert.ok(paths.some(path => gated.reason.includes(path)), gated.reason);
    assert.equal(decisions.scopeRoutineDecision(standing(gated), now, true), null, `${paths.join(', ')}: no approver decision is formed`);
  }
});

test('integration:owed-decision-gy-1761-replay — approval 5499583025 of 632185dd with no ledger plan holds nothing and owes no decision past reworkDecisionWaitBoundMs', async () => {
  const { mechanicalReviewHold } = await import('../src/mechanical-findings.js');
  const head = '632185dd17dd'.padEnd(40, '0'), submittedAt = '2026-10-13T06:25:00.000Z';
  const review = { reviewer: 'graphyard-reviewer[bot]', sha: head, state: 'APPROVED', id: 5499583025, submittedAt, mechanical: 2 };
  const candidate = { sha: head, baseSha: '1'.repeat(40), pr: 1169, branch: 'graphyard/gy-1761-1', author: 'implementer' };
  const gy1761 = { id: 'work-1761', key: 'GY-1761', stage: 'review', epoch: 1, criteria: [{ id: 'AC-1', text: 'It works', proofs: ['unit:works'] }], evidence: [], gates: [], dependencies: [], workspaces: [], lastAssignment: { owner: 'implementer', epoch: 1 }, implementers: ['implementer'], reworkRequested: false, policy: { checks: ['test'], review: true, reviewProvider: 'github' }, candidate, submission: { epoch: 1, pr: 1169 },
    observation: { candidate, reviews: [review], checks: [], merged: false, prState: 'open', draft: false, at: submittedAt } } as unknown as Work;
  const sevenOhOne = Date.parse('2026-10-13T07:00:34.946Z');
  // Base: the gate held from the observation's review entry alone, until 07:25:00Z, while the ledger planned nothing (mechanicalFix null, follow-ups filed 06:24:59.869Z).
  // Candidate: the loop's report answers the approval — follow-ups are filed, so no plan is owed — and the gate releases on it; there is no owed request-rework to outlast the bound.
  // GY-1814: the answer rides the item as `mechanicalPlan` null, the clear the loop wrote over its provisional report of this approval.
  assert.equal(mechanicalReviewHold({ ...gy1761, mechanicalPlan: null, mechanicalAnswered: { reviewId: 5499583025, head } }, sevenOhOne), null, 'no plan, no hold');
  // GY-1814: a clear, or a plan, recorded for another head or approval answers nothing here: a later approval of a later head is held until the loop reports on it.
  const priorHead = 'a'.repeat(40);
  assert.match(mechanicalReviewHold({ ...gy1761, mechanicalPlan: null, mechanicalAnswered: { reviewId: 5499583000, head: priorHead } }, sevenOhOne) ?? '', /names 2 findings/, 'a clear of an earlier head holds the new approval');
  assert.match(mechanicalReviewHold({ ...gy1761, mechanicalPlan: null, mechanicalAnswered: { reviewId: 5499582999, head } }, sevenOhOne) ?? '', /names 2 findings/, 'a clear of an earlier review holds it');
  assert.match(mechanicalReviewHold({ ...gy1761, mechanicalPlan: { reviewId: 5499583000, head: priorHead, at: '2026-10-13T07:00:00.000Z' } }, sevenOhOne) ?? '', /names 2 findings/, 'a plan for an earlier head holds it');
  assert.match(mechanicalReviewHold({ ...gy1761, mechanicalPlan: null }, sevenOhOne) ?? '', /names 2 findings/, 'a clear naming no approval holds it');
  assert.equal(decisions.neededDecision(gy1761, { autoMerge: true } as never, undefined, [], []), null, 'and no mechanical rework is owed');
  assert.ok(sevenOhOne - Date.parse('2026-10-13T06:25:05.685Z') > reworkDecisionWaitBoundMs, 'the instance stood past the bound at 07:00:34Z');
  // The same approval with a planned fix the loop confirmed this cycle is held, as GY-971 intends, and owes its round;
  // GY-1814: a matching report holds past its confirm too — the round is still owed between the loop's confirms, so
  // the head is never released to merge it, and the round window (here 07:25:00Z) is the bound that releases it.
  const held = mechanicalReviewHold({ ...gy1761, mechanicalPlan: { reviewId: 5499583025, head, at: '2026-10-13T07:00:00.000Z' } }, sevenOhOne);
  assert.match(held ?? '', /Approval 5499583025 of 632185dd17dd names 2 findings classified mechanical/);
  const { mechanicalPlanFreshMs } = await import('../src/mechanical-findings.js');
  const staleHold = mechanicalReviewHold({ ...gy1761, mechanicalPlan: { reviewId: 5499583025, head, at: new Date(sevenOhOne - mechanicalPlanFreshMs - 1).toISOString() } }, sevenOhOne);
  assert.match(staleHold ?? '', /names 2 findings classified mechanical/, 'a matching report past its confirm holds until the round window');
  assert.ok(staleHold!.includes('07:25:00'), 'the hold names the round window that releases it');
  // Two approvals on the head both name mechanical findings and the ledger planned the later one: the hold is for that one.
  const earlier = { ...review, id: 5499583024, submittedAt: '2026-10-13T06:20:00.000Z' };
  const twoApprovals = { ...gy1761, observation: { ...gy1761.observation!, reviews: [earlier, review] }, mechanicalPlan: { reviewId: 5499583025, head, at: '2026-10-13T07:00:00.000Z' } } as unknown as Work;
  assert.match(mechanicalReviewHold(twoApprovals, sevenOhOne) ?? '', /Approval 5499583025 of 632185dd17dd/, 'the planned later approval holds the head');
});

// GY-1764 rework, AC-2: the loop's report of the review ledger's mechanical plan is the one write the
// review gate's hold stands on, so a report that cannot be written is a visible, retried failure — and
// a hold whose confirmation the loop cannot renew is dropped, never retained past its evidence.
test('integration:mechanical-plan-report-surfaced — a refused plan report is a failed action row that retries, and the hold drops while the report stands unconfirmed', async () => {
  const { mechanicalReviewHold } = await import('../src/mechanical-findings.js');
  const minute = 60_000, start = Date.parse('2026-10-13T08:00:00.000Z');
  const iso = (at: number) => new Date(at).toISOString();
  const head = '632185dd17dd'.padEnd(40, '0');
  const review = { reviewer: 'graphyard-reviewer[bot]', sha: head, state: 'APPROVED', id: 5499583025, submittedAt: iso(start - 35 * minute), mechanical: 2 };
  const candidate = { sha: head, baseSha: '1'.repeat(40), pr: 1169, branch: 'graphyard/gy-1761-1', author: 'implementer' };
  const state = emptyDaemonState(config());
  // The plane as the loop reports to it: the item, its accepted plan report, and the ledger's standing plan.
  // `reworkRequested` keeps the round's own rework decision out of the way: this step is the plan report.
  let confirmedAt = iso(start - 11 * minute);
  const attempts: ({ reviewId: number; head: string } | null)[] = [];
  const work = (): Work => ({
    id: 'work-1761', key: 'GY-1761', title: 'GY-1761', description: '', type: 'bug', priority: 2, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'It works', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 3, policyRevision: 1,
    createdAt: iso(start - hour(2)), updatedAt: iso(start), stageEnteredAt: iso(start - hour(1)), ready: true, epoch: 1, lease: null, workspaces: [],
    candidate, submission: { epoch: 1, pr: 1169 }, reworkRequested: true, scenarioRequirements: [], evidence: [], blocker: null, violations: [], scopeRequest: null, gates: [],
    observation: { candidate, reviews: [review], checks: [], merged: false, prState: 'open', draft: false, at: iso(start - 30 * minute) },
    mechanicalPlan: { reviewId: 5499583025, head, at: confirmedAt },
  } as unknown as Work);
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: [work()], now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}), wakeObservation: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {},
    persist: async () => {},
    mechanicalFixes: async () => ({ requests: [{ key: 'GY-1761', pr: 1169, head, reviewId: 5499583025, epoch: 1, at: iso(start - 35 * minute), mechanical: [], substantive: [], paths: ['src/widget.ts'] }] }),
    recordMechanicalPlan: async (item: Work, plan: { reviewId: number; head: string } | null) => {
      attempts.push(plan);
      if (attempts.length <= 2) throw new Error('the control plane refused work/work-1761/mechanicalplan (503): plane-wide outage');
      confirmedAt = iso(now);
      return { ...item, mechanicalPlan: plan ? { ...plan, at: confirmedAt } : null };
    },
  } as unknown as Parameters<typeof daemon.runCycle>[2];
  let now = start;
  const faultsBefore = state.faults.instances.length;
  for (let step = 0; step < 4; step++, now += 2 * minute) await daemon.runCycle(config(), state, effects, () => now);
  assert.deepEqual(attempts.slice(0, 3), [{ reviewId: 5499583025, head }, { reviewId: 5499583025, head }, { reviewId: 5499583025, head }], 'the stale report is retried until the plane accepts it');
  const row = Object.entries(state.actions).find(([key]) => key.startsWith('mechanical-plan:'));
  assert.ok(row, 'the refused report is on the record');
  assert.equal(row![1].state, 'failed');
  assert.match(row![1].detail, /mechanical plan \(review 5499583025/);
  assert.match(row![1].detail, /503\): plane-wide outage/);
  assert.deepEqual(state.faults.instances.slice(faultsBefore).map(entry => entry.kind).filter(kind => /decision|escalation/.test(kind)), [], 'a refused plan report is not a decision fault');
  assert.deepEqual(attempts.slice(3), [], 'a confirmed report is not re-reported while it stays fresh');
  // The gate reads the same projection: held while the confirmation stands. GY-1814: a matching report holds
  // past its confirm too — the round is still owed between the loop's confirms, and the round window is the
  // bound that releases it — never dropped to let the head merge a round the ledger still plans.
  assert.match(mechanicalReviewHold(work(), start) ?? '', /names 2 findings classified mechanical/);
  const staleHold = mechanicalReviewHold({ ...work(), mechanicalPlan: { reviewId: 5499583025, head, at: iso(start - 6 * minute) } } as Work, start);
  assert.match(staleHold ?? '', /names 2 findings classified mechanical/, 'a matching report past its confirm holds until the round window');
});
test('integration:mechanical-plan-report-blocks-decision — an item whose planned round cannot be reported forms no decision from the ledger until the report lands', async () => {
  const { mechanicalReviewHold } = await import('../src/mechanical-findings.js');
  const minute = 60_000, start = Date.parse('2026-10-13T08:00:00.000Z');
  const iso = (at: number) => new Date(at).toISOString();
  const head = '632185dd17dd'.padEnd(40, '0');
  const review = { reviewer: 'graphyard-reviewer[bot]', sha: head, state: 'APPROVED', id: 5499583025, submittedAt: iso(start - 35 * minute), mechanical: 2 };
  const candidate = { sha: head, baseSha: '1'.repeat(40), pr: 1169, branch: 'graphyard/gy-1761-1', author: 'implementer' };
  const state = emptyDaemonState(config());
  // The plane as the loop reports to it: the item, its accepted plan report, and the ledger's standing plan.
  // `reworkRequested` keeps the round's own rework decision out of the way: this step is the plan report.
  let confirmedAt = iso(start - 11 * minute);
  const attempts: ({ reviewId: number; head: string } | null)[] = [];
  const work = (): Work => ({
    id: 'work-1761', key: 'GY-1761', title: 'GY-1761', description: '', type: 'bug', priority: 2, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'It works', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 3, policyRevision: 1,
    createdAt: iso(start - hour(2)), updatedAt: iso(start), stageEnteredAt: iso(start - hour(1)), ready: true, epoch: 1, lease: null, workspaces: [],
    candidate, submission: { epoch: 1, pr: 1169 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [], scopeRequest: null, gates: [],
    observation: { candidate, reviews: [review], checks: [], merged: false, prState: 'open', draft: false, at: iso(start - 30 * minute) },
    mechanicalPlan: { reviewId: 5499583025, head, at: confirmedAt },
  } as unknown as Work);
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: [work()], now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}), wakeObservation: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {},
    persist: async () => {},
    mechanicalFixes: async () => ({ requests: [{ key: 'GY-1761', pr: 1169, head, reviewId: 5499583025, epoch: 1, at: iso(start - 35 * minute), mechanical: [], substantive: [], paths: ['src/widget.ts'] }] }),
    recordMechanicalPlan: async (item: Work, plan: { reviewId: number; head: string } | null) => {
      attempts.push(plan);
      if (attempts.length <= 4) throw new Error('the control plane refused work/work-1761/mechanicalplan (503): plane-wide outage');
      confirmedAt = iso(now);
      return { ...item, mechanicalPlan: plan ? { ...plan, at: confirmedAt } : null };
    },
  } as unknown as Parameters<typeof daemon.runCycle>[2];
  let now = start;
  const faultsBefore = state.faults.instances.length;
  for (let step = 0; step < 2; step++, now += 2 * minute) await daemon.runCycle(config(), state, effects, () => now);
  const decisions = () => Object.keys(state.actions).filter(key => /^escalation:decision:/.test(key) || /rework/.test(key) && key.includes('work-1761'));
  assert.ok(attempts.length >= 4, 'the report is retried within the cycle and again the next');
  assert.equal(state.actions['mechanical-plan:work-1761']?.state, 'failed', 'the failed report is on the record');
  assert.deepEqual(decisions(), [], 'no decision forms while the plan report fails');
  assert.deepEqual(Object.values(state.approvals).map(watch => watch.work), [], 'no approval is requested for it');
  const before = decisions().length;
  for (let step = 0; step < 3; step++, now += 2 * minute) await daemon.runCycle(config(), state, effects, () => now);
  assert.ok(decisions().length > before, 'once the report lands the round forms its decision');
});
test('integration:mechanical-plan-report-clear-blocks-decision — a held plan the ledger no longer carries, whose clearing cannot be reported, owes no decision and does not hold its decisions', async () => {
  const { mechanicalReviewHold } = await import('../src/mechanical-findings.js');
  const minute = 60_000, start = Date.parse('2026-10-13T08:00:00.000Z');
  const iso = (at: number) => new Date(at).toISOString();
  const head = '632185dd17dd'.padEnd(40, '0');
  const review = { reviewer: 'graphyard-reviewer[bot]', sha: head, state: 'APPROVED', id: 5499583025, submittedAt: iso(start - 35 * minute), mechanical: 2 };
  const candidate = { sha: head, baseSha: '1'.repeat(40), pr: 1169, branch: 'graphyard/gy-1761-1', author: 'implementer' };
  const state = emptyDaemonState(config());
  // The plane as the loop reports to it: the item, its accepted plan report, and the ledger's standing plan.
  // `reworkRequested` keeps the round's own rework decision out of the way: this step is the plan report.
  let confirmedAt = iso(start - 11 * minute);
  const attempts: ({ reviewId: number; head: string } | null)[] = [];
  const work = (): Work => ({
    id: 'work-1761', key: 'GY-1761', title: 'GY-1761', description: '', type: 'bug', priority: 2, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'It works', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 3, policyRevision: 1,
    createdAt: iso(start - hour(2)), updatedAt: iso(start), stageEnteredAt: iso(start - hour(1)), ready: true, epoch: 1, lease: null, workspaces: [],
    candidate, submission: { epoch: 1, pr: 1169 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [], scopeRequest: null, gates: [],
    observation: { candidate, reviews: [review], checks: [], merged: false, prState: 'open', draft: false, at: iso(start - 30 * minute) },
    mechanicalPlan: { reviewId: 5499583025, head, at: confirmedAt },
  } as unknown as Work);
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: [work()], now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}), wakeObservation: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {},
    persist: async () => {},
    mechanicalFixes: async () => ({ requests: [] }),
    recordMechanicalPlan: async (item: Work, plan: { reviewId: number; head: string } | null) => {
      attempts.push(plan);
      if (attempts.length <= 4) throw new Error('the control plane refused work/work-1761/mechanicalplan (503): plane-wide outage');
      confirmedAt = iso(now);
      return { ...item, mechanicalPlan: plan ? { ...plan, at: confirmedAt } : null };
    },
  } as unknown as Parameters<typeof daemon.runCycle>[2];
  let now = start;
  const faultsBefore = state.faults.instances.length;
  for (let step = 0; step < 2; step++, now += 2 * minute) await daemon.runCycle(config(), state, effects, () => now);
  const decisions = () => Object.keys(state.actions).filter(key => /^escalation:decision:/.test(key) || /rework/.test(key) && key.includes('work-1761'));
  assert.ok(attempts.length >= 4, 'the report is retried within the cycle and again the next');
  assert.equal(state.actions['mechanical-plan:work-1761']?.state, 'failed', 'the failed report is on the record');
  assert.deepEqual(decisions(), [], 'no decision forms while the plan report fails');
  assert.deepEqual(Object.values(state.approvals).map(watch => watch.work), [], 'no approval is requested for it');
  assert.ok(attempts.every(plan => plan === null), 'only the plan\'s absence is reported');
});
test('integration:scope-evidence-gate-failed-read — a failed tree read decides nothing and routes nothing; the ask waits for a read', async () => {
  const minute = 60_000, start = Date.parse('2026-10-13T08:20:00.000Z');
  const iso = (at: number) => new Date(at).toISOString();
  const work = {
    id: 'work-GY-1696', key: 'GY-1696', title: 'GY-1696', description: '', type: 'feature', priority: 1, dependencies: [], plannedFiles: ['src/widget.ts'],
    criteria: [{ id: 'AC-1', text: 'The live observation is recorded by a master session', proofs: ['unit:x'] }], policy: { checks: ['test'], review: true }, stage: 'build', ready: true,
    epoch: 1, revision: 10, policyRevision: 2, createdAt: iso(start - 2 * hour(1)), updatedAt: iso(start), stageEnteredAt: iso(start - hour(1)),
    lease: { owner: 'worker', epoch: 1, expiresAt: iso(start + 30 * minute) }, workspaces: [], submission: null, candidate: null,
    scenarioRequirements: [], blocker: null, violations: [], evidence: [], observation: null, gates: [],
    scopeRequest: { epoch: 1, at: iso(start - 5 * minute), paths: ['daemon.relea'], reason: 'the round needs these', requestedBy: 'worker' },
  } as unknown as Work;
  let reads = 0; const decided: boolean[] = [];
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: [work], now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}), wakeObservation: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {},
    persist: async () => {}, reviewFindings: async () => [], basePaths: async (paths: string[]) => new Set(paths),
    repositoryFiles: async () => { reads++; throw new Error('git is unavailable'); },
    decideScope: async (item: Work) => { decided.push(true); return item; },
  } as unknown as Parameters<typeof daemon.runCycle>[2];
  let now = start;
  const state = emptyDaemonState(config());
  for (let step = 0; step < 3; step++, now += 2 * minute) await daemon.runCycle(config(), state, effects, () => now);
  assert.equal(reads, 3, 'each cycle retries the read');
  assert.deepEqual(decided, [], 'the rules alone never decide an ask whose tree could not be read');
  assert.deepEqual(Object.values(state.approvals).map(watch => watch.work), [], 'and no approver is asked');
});
function hour(count: number) { return count * 60 * 60_000; }

// GY-1764 rework, AC-1/AC-3: the replay above injects the classifier's verdict; this one runs the real
// loop's scope step over repeated cycles, heads and items — the loop reads the tree once per cycle, the
// plane decides from what the loop posted, and no approver decision is ever formed for what the tree refutes.
test('integration:scope-evidence-gate-repeated-cycles — the loop reads the tree once per cycle, refuses non-repository asks in-process, approves decidable new files, and routes nothing', async () => {
  const { decideScopeRequest } = await import('../src/model/scope.js');
  const minute = 60_000, start = Date.parse('2026-10-13T08:20:00.000Z');
  const iso = (at: number) => new Date(at).toISOString();
  const tree = ['src/widget.ts', 'docs/guide.md', 'README.md', 'package.json'];
  const asked = iso(start - 5 * minute);
  const item = (key: string, paths: string[], criterion: string): Work => ({
    id: `work-${key}`, key, title: key, description: '', type: 'feature', priority: 1, dependencies: [], plannedFiles: ['src/widget.ts'],
    criteria: [{ id: 'AC-1', text: criterion, proofs: ['unit:x'] }], policy: { checks: ['test'], review: true }, stage: 'build', ready: true,
    epoch: 1, revision: 10, policyRevision: 2, createdAt: iso(start - 2 * hour(1)), updatedAt: iso(start), stageEnteredAt: iso(start - hour(1)),
    lease: { owner: 'worker', epoch: 1, expiresAt: iso(start + 30 * minute) }, workspaces: [], submission: null, candidate: null,
    scenarioRequirements: [], blocker: null, violations: [], evidence: [], observation: null, gates: [],
    scopeRequest: { epoch: 1, at: asked, paths, reason: 'the round needs these', requestedBy: 'worker' },
  } as unknown as Work);
  // The plane as the loop's `autoscope` leaves it: the verdict recomputed here from the item and the evidence posted.
  const plane = new Map<string, Work>([
    ['GY-1696', item('GY-1696', ['daemon.relea', 'upgrade.align'], 'The live observation is recorded by a master session')],
    ['GY-1697', item('GY-1697', ['.graphyard/master.json'], 'The credential the master reads exists')],
    ['GY-1698', item('GY-1698', ['src/soak/new-check.ts'], 'src/soak/new-check.ts behaves for the item')],
  ]);
  const posted: [string, string[]][] = [];
  let treeReads = 0;
  const widened: string[] = [];
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: [...plane.values()], now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}), wakeObservation: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {},
    persist: async () => {}, basePaths: async (paths: string[]) => new Set(paths),
    // A finding naming each offender would ground an automatic widening; a terminal non-repository refusal must never reach it.
    reviewFindings: async () => [{ ground: 'review finding', text: 'daemon.relea upgrade.align and .graphyard/master.json need changes' }],
    widenScope: async (work: Work) => { widened.push(work.key); return work; },
    repositoryFiles: async () => { treeReads++; return new Set(tree); },
    decideScope: async (work: Work, nonRepository?: readonly { path: string; nearMiss: string | null; why: 'install-local' | 'untracked' }[], treeRead?: boolean) => {
      posted.push([work.key, (nonRepository ?? []).map(entry => entry.path)]);
      const request = work.scopeRequest!;
      const verdict = decideScopeRequest(work, request, { nonRepository });
      const decision = { state: verdict.state, reason: verdict.reason, at: iso(now), decidedBy: 'graphyard', waitedMs: 0, paths: verdict.paths, requestedBy: request.requestedBy, requestedAt: request.at, epoch: request.epoch, ...(verdict.nonRepository ? { nonRepository: true } : {}), ...(treeRead ? { treeRead: true } : {}) };
      const decided: Work = { ...work, scopeDecision: decision, ...(verdict.state === 'approved'
        ? { scopeRequest: null, plannedFiles: [...(work.plannedFiles ?? []), ...verdict.paths] }
        : { scopeRequest: { ...request, decision } }) };
      plane.set(work.key, decided);
      return decided;
    },
  } as unknown as Parameters<typeof daemon.runCycle>[2];
  let now = start;
  const state = emptyDaemonState(config());
  const violations: string[] = [];
  for (let step = 0; step < 5; step++, now += 2 * minute) {
    await daemon.runCycle(config(), state, effects, () => now);
    for (const check of state.invariants.report as { holds: boolean; line: string }[]) if (!check.holds) violations.push(`cycle ${step}: ${check.line}`);
  }
  assert.equal(treeReads, 1, 'the tree is read once for the cycle with open asks, not once per item');
  assert.deepEqual(posted.map(([key, paths]) => [key, paths]), [
    ['GY-1696', ['daemon.relea', 'upgrade.align']],
    ['GY-1697', ['.graphyard/master.json']],
    ['GY-1698', []],
  ], 'the loop posts the offenders it read, and nothing for the decidable new file');
  const a = plane.get('GY-1696')!, b = plane.get('GY-1697')!, c = plane.get('GY-1698')!;
  assert.equal(a.scopeRequest!.decision!.nonRepository, true, 'A: refused as its own verdict');
  assert.match(a.scopeRequest!.decision!.reason, /daemon\.release is a master-status field, not a file/);
  assert.equal(b.scopeRequest!.decision!.nonRepository, true, 'B: the install-local credential is refused as its own verdict');
  assert.match(b.scopeRequest!.decision!.reason, /install-local \.graphyard\/ directory/);
  assert.equal(c.scopeRequest, null, 'C: a new file inside a tracked directory is approved across the same read');
  assert.ok(c.plannedFiles!.includes('src/soak/new-check.ts'));
  assert.deepEqual(Object.values(state.approvals).filter(watch => watch.action === 'requirements').map(watch => watch.work), [], 'no requirements decision is requested for what the tree refutes');
  assert.ok(!widened.includes('GY-1696') && !widened.includes('GY-1697'), 'a standing non-repository refusal is never widened on a finding');
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  // The decision class this item removes is silent here: no requirements decision is requested, so no
  // approver session, no escalation and no decision fault forms — the standing scope-request faults are
  // the refused asks themselves, which the worker re-asks or finishes without, as the refusal says.
  assert.deepEqual(state.faults.instances.map(entry => entry.kind).filter(kind => /decision|escalation/.test(kind)), [], 'no decision fault opens for any of them');
});

// GY-1764: a refusal the repository tree supplied the evidence for is no pending widening; a later attempt asks afresh.
test('unit:non-repository-refusal-not-carried', async () => {
  const { carriedScopeRequest } = await import('../src/engine.js');
  const decision = { state: 'refused', reason: 'daemon.release is a master-status field, not a file', at: '2026-10-13T08:00:00.000Z', decidedBy: 'graphyard', waitedMs: 0, paths: ['daemon.release'], requestedBy: 'w', requestedAt: '2026-10-13T07:59:00.000Z', epoch: 1 };
  const ask = { epoch: 1, at: decision.requestedAt, paths: ['daemon.release'], reason: 'r', requestedBy: 'w', decision: { ...decision, treeRead: true } };
  assert.equal(carriedScopeRequest({ plannedFiles: ['src/a.ts'] }, { ...ask, decision: { ...decision, nonRepository: true } } as any), null, 'an evidence-gated refusal ends with its attempt');
  assert.deepEqual(carriedScopeRequest({ plannedFiles: ['src/a.ts'] }, ask as any)?.paths, ['daemon.release'], 'an ordinary graphyard refusal the tree was read for still carries');
  assert.equal(carriedScopeRequest({ plannedFiles: ['src/a.ts'] }, { ...ask, decision } as any), null, 'a refusal the tree was never read for is not carried to the approver');
});

// GY-1764 rework, AC-2: a ledger read that fails reads as no plan, so a held projection is cleared on that very cycle, retried
// until the clear lands; the failure of the clear is a visible failed action, never a quiet hold.
test('unit:mechanical-plan-cleared-on-failed-read', async () => {
  const { reportMechanicalPlans } = await import('../src/daemon/mechanical-plan-report.js');
  const at = '2026-10-13T08:00:00.000Z', clock = Date.parse(at) + 30_000;
  const item = { id: 'w', key: 'GY-1', stage: 'review', epoch: 1, candidate: { sha: 'abc', pr: 1 }, mechanicalPlan: { reviewId: 7, head: 'abc', at } } as unknown as Work;
  const sent: unknown[] = [], failures: string[] = [] as string[];
  let refuse = 1;
  const effects = { mechanicalFixes: () => {}, recordMechanicalPlan: async (_: Work, plan: unknown) => { sent.push(plan); if (refuse-- > 0) throw new Error('503'); } };
  const unreported = await reportMechanicalPlans([item], [], effects, clock, { fail: async (_, detail) => { failures.push(detail); }, settle: async () => {} });
  assert.deepEqual(sent, [null, null], 'the clear is retried within the cycle until it lands');
  assert.equal(unreported.size, 0, 'a cleared plan owes no round');
  assert.deepEqual(failures, [], 'a landed clear is no failure');
  refuse = 9; sent.length = 0;
  const later: string[] = [];
  await reportMechanicalPlans([item], [], effects, clock, { fail: async (_, detail) => { later.push(detail); }, settle: async () => {} });
  assert.equal(later.length, 1, 'a clear that cannot land is a visible failure');
});

// GY-1795: the three decision faults of 14 October 2026 share one cause — the loop filed a decision
// fault (or asked the master to close a goal) for a state the product had already settled or could
// settle itself. Each instance below is replayed as the item stood when the loop recorded it; against
// the base each subtest fails, because the instance files there.
//
// - action:decision|GY-1459|2026-10-14T04:54:55.483Z: the loop's clear of a plan the ledger no longer
//   carried met a write timeout. The gate lapses the hold by `mechanicalPlanFreshMs` whatever the write
//   does, so the failure is a visible, retried action — and no decision fault.
// - action:decision|GY-1775|2026-10-14T06:43:08.482Z: the same clear hit the server's refusal because
//   the item had been delivered after the cycle's snapshot. The target is settled: no report, no hold,
//   no instance.
// - action:decision|GOAL-1|2026-10-14T08:54:23.295Z: the acceptance land route merged as the
//   control-plane App that pushed the acceptance branch, so GitHub's approval-from-someone-other-than-
//   the-last-pusher rule refused #1153, and past `acceptanceStuckMs` the loop asked the master to close
//   the goal every five-minute poll. The route now approves the verified head with the independent
//   approver App (GY-1291's), as the main guard's reverts are approved, and an unconfigured approver is
//   named in the waiting detail.
/**
 * GY-1459 as the loop held it: a confirmed plan from before the ledger ceased to carry it, whose clear
 * meets the loop's 30-second write timeout on every attempt. `state` is the loop's, `cycles` how many
 * two-minute cycles to run from 04:50; the attempts the clear made and the item are returned.
 */
async function timedOutClearReplay(state: ReturnType<typeof emptyDaemonState>, cycles: number) {
  const minute = 60_000, start = Date.parse('2026-10-14T04:50:00.000Z');
  const iso = (at: number) => new Date(at).toISOString();
  const head = '632185dd17dd'.padEnd(40, '0');
  const review = { reviewer: 'graphyard-reviewer[bot]', sha: head, state: 'APPROVED', id: 5499583025, submittedAt: iso(start - 35 * minute), mechanical: 2 };
  const candidate = { sha: head, baseSha: '1'.repeat(40), pr: 1169, branch: 'graphyard/gy-1459-1', author: 'implementer' };
  const confirmedAt = iso(start - 11 * minute);
  const attempts: ({ reviewId: number; head: string } | null)[] = [];
  let now = start;
  const work = (): Work => ({
    id: 'work-1459', key: 'GY-1459', title: 'GY-1459', description: '', type: 'bug', priority: 2, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'It works', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 3, policyRevision: 1,
    createdAt: iso(start - hour(2)), updatedAt: iso(start), stageEnteredAt: iso(start - hour(1)), ready: true, epoch: 1, lease: null, workspaces: [],
    candidate, submission: { epoch: 1, pr: 1169 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [], scopeRequest: null, gates: [],
    observation: { candidate, reviews: [review], checks: [], merged: false, prState: 'open', draft: false, at: iso(start - 30 * minute) },
    mechanicalPlan: { reviewId: 5499583025, head, at: confirmedAt },
  } as unknown as Work);
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: [work()], now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}), wakeObservation: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {},
    persist: async () => {},
    mechanicalFixes: async () => ({ requests: [] }),
    recordMechanicalPlan: async (_item: Work, plan: { reviewId: number; head: string } | null) => { attempts.push(plan); throw new Error('The operation was aborted due to timeout'); },
  } as unknown as Parameters<typeof daemon.runCycle>[2];
  for (let step = 0; step < cycles; step++, now += 2 * minute) await daemon.runCycle(config(), state, effects, () => now);
  return { attempts, work: work(), start };
}
const timedOutClearDetail = `Could not report GY-1459's mechanical plan (none): The operation was aborted due to timeout; the review gate drops the hold once its last confirmation passes 5 minutes old, except over an approval still inside its mechanical round, which it holds until a report lands or 2026-10-14T05:15:00.000Z`;

test('manual:fault-class-decision — action:decision|GY-1459|2026-10-14T04:54:55.483Z: a plan-report write that times out is a retried action, not a decision fault', async () => {
  const state = emptyDaemonState(config());
  const faultsBefore = state.faults.instances.length;
  const { attempts } = await timedOutClearReplay(state, 2);
  assert.ok(attempts.length >= 2, 'the clear is attempted within the cycle and again the next');
  const row = state.actions['mechanical-plan:work-1459'];
  assert.equal(row?.state, 'failed', 'the failed write stays a visible, retried action');
  assert.equal(row!.detail, timedOutClearDetail);
  assert.equal(row!.faultClass, undefined, 'and carries no fault class');
  assert.deepEqual(state.faults.instances.slice(faultsBefore).map(entry => entry.kind).filter(kind => /decision|escalation/.test(kind)), [], 'the timeout counts no decision fault: the hold lapses by its own bound whatever the write does');
});

// The row a loop before this change stored for the same timed-out clear counts as a decision fault,
// and its text never changes, so an unchanged-detail guard alone would keep it counting (Codex, PR
// #1203): the first cycle after the upgrade rewrites it without the class, and files no instance.
test('manual:fault-class-decision — a stored counting failure of the same clear is rewritten without its fault class once the write stops counting, under the same text', async () => {
  const state = emptyDaemonState(config());
  const at = '2026-10-14T04:48:00.000Z';
  storeAction(state, 'mechanical-plan:work-1459', { kind: 'decision', work: 'GY-1459', principal: null, state: 'failed', detail: timedOutClearDetail, attempts: 3, epoch: 1, cycle: 7, at });
  assert.equal(state.actions['mechanical-plan:work-1459']!.faultClass, 'decision', 'the stored row counts, as the loop before this change stored it');
  const counted = state.faults.failing['mechanical-plan:work-1459'];
  assert.ok(counted && state.faults.instances.some(entry => entry.id === counted && entry.kind === 'action:decision' && entry.subject === 'GY-1459'), 'the stored row opened a decision instance the recurrence counts');
  const instancesBefore = state.faults.instances.length;
  await timedOutClearReplay(state, 1);
  const row = state.actions['mechanical-plan:work-1459']!;
  assert.equal(row.state, 'failed');
  assert.equal(row.detail, timedOutClearDetail, 'the same text');
  assert.equal(row.faultClass, undefined, 'rewritten without the fault class on the first cycle after the upgrade');
  assert.equal(row.attempts, 4, 'as one more attempt of the same failure');
  assert.deepEqual(state.faults.instances.slice(instancesBefore).filter(entry => /decision|escalation/.test(entry.kind)).map(entry => `${entry.kind} ${entry.subject}`), [], 'and no further decision instance is filed');
  // Codex, PR #1203 round 3: the rewrite alone left the instance the counting row had opened, and the run pointing at it, so the recurrence (which counts instances, not rows) could still reach its threshold on a write that was no fault.
  assert.equal(state.faults.failing['mechanical-plan:work-1459'], undefined, 'the run the counting row opened is ended');
  assert.deepEqual(state.faults.instances.filter(entry => entry.kind === 'action:decision' && entry.subject === 'GY-1459'), [], 'and the instance it opened is dropped: the write was no fault');
  const [{ recurringClasses }, { faultClassPolicyDefaults }] = await Promise.all([import('../src/model/fault-class-recurrence.js'), import('../src/model/fault-classes.js')]);
  assert.deepEqual(recurringClasses(state.faults.instances, [], faultClassPolicyDefaults, Date.parse(at) + hour(1)).filter(entry => entry.faultClass === 'decision'), [], 'so nothing of it stands in the decision class window');
});

test('manual:fault-class-decision — action:decision|GY-1775|2026-10-14T06:43:08.482Z: a write refused because the item was delivered meanwhile is settled — no report, no hold, no instance', async () => {
  const { reportMechanicalPlans } = await import('../src/daemon/mechanical-plan-report.js');
  const at = '2026-10-14T06:40:00.000Z', clock = Date.parse(at) + 30_000;
  // The item as the pre-delivery snapshot held it, its confirmation already past the freshness window.
  const item = { id: 'w', key: 'GY-1775', stage: 'review', epoch: 1, candidate: { sha: 'abc', pr: 1 }, mechanicalPlan: { reviewId: 7, head: 'abc', at } } as unknown as Work;
  const sent: unknown[] = [], failures: string[] = [], settled: string[] = [];
  const effects = { mechanicalFixes: () => {}, recordMechanicalPlan: async (_: Work, plan: unknown) => { sent.push(plan); throw new Error('{"error":"Delivered work is immutable; create a follow-up task"}'); } };
  const unreported = await reportMechanicalPlans([item], [], effects, clock, { fail: async (_, detail) => { failures.push(detail); }, settle: async target => { settled.push(target.key); } });
  assert.deepEqual(sent, [null, null], 'the clear was attempted and refused twice — the refusal only shows on the write');
  assert.deepEqual(failures, [], 'the settled refusal names no failure');
  assert.deepEqual(settled, ['GY-1775'], 'and settles what an earlier failure of the same report may have recorded');
  assert.equal(unreported.size, 0, 'a delivered item holds no decision from the ledger');
});

// Codex, PR #1203 round 4: a newly wanted plan's write that failed on an earlier cycle opened a counting instance; when
// the item is delivered before the retry, the delivered refusal used to skip that row untouched, and the next snapshot
// skips the delivered item, so the run stood (and its instance counted) until the window aged it out. The refusal now
// settles the report: the run ends, its instance is dropped, and the row reads done.
test('manual:fault-class-decision — a counting failure of a newly wanted plan, refused as delivered on its retry, is settled: its run ends, its instance is dropped and its row reads done', async () => {
  const [{ reportMechanicalPlans, planReportSink }, { recurringClasses }, { faultClassPolicyDefaults }] = await Promise.all([import('../src/daemon/mechanical-plan-report.js'), import('../src/model/fault-class-recurrence.js'), import('../src/model/fault-classes.js')]);
  const state = emptyDaemonState(config());
  const at = '2026-10-14T06:38:00.000Z', clock = Date.parse(at) + 2 * 60_000, key = 'mechanical-plan:w';
  const failed = `Could not report GY-1775's mechanical plan (review 7 on abc): 503 Service Unavailable; the review gate drops the hold once its last confirmation passes 5 minutes old`;
  storeAction(state, key, { kind: 'decision', work: 'GY-1775', principal: null, state: 'failed', detail: failed, attempts: 1, epoch: 1, cycle: 3, at });
  const counted = state.faults.failing[key];
  assert.ok(counted && state.faults.instances.some(entry => entry.id === counted && entry.kind === 'action:decision' && entry.subject === 'GY-1775'), 'the newly wanted plan\'s failed write counts, and opened a decision instance');
  const item = { id: 'w', key: 'GY-1775', stage: 'review', epoch: 1, candidate: { sha: 'abc', pr: 1 }, mechanicalPlan: null } as unknown as Work;
  const effects = { mechanicalFixes: () => {}, recordMechanicalPlan: async () => { throw new Error('{"error":"Delivered work is immutable; create a follow-up task"}'); } };
  const note = async (row: string, target: Work, kind: 'decision', outcome: 'done' | 'failed', detail: string, when: number = clock, faultKind?: FaultKind | null) =>
    storeAction(state, row, { kind, work: target.key, principal: null, state: outcome, detail, attempts: (state.actions[row]?.attempts ?? 0) + 1, epoch: target.epoch, cycle: 4, at: new Date(when).toISOString() }, faultKind);
  const unreported = await reportMechanicalPlans([item], [{ key: 'GY-1775', head: 'abc', pr: 1, epoch: 1, reviewId: 7 }], effects, clock, planReportSink(state, note));
  assert.equal(unreported.size, 0, 'a delivered item holds no decision from the ledger');
  const row = state.actions[key]!;
  assert.equal(row.state, 'done', 'the row reads done: the report is settled');
  assert.match(row.detail, /GY-1775's mechanical plan report is settled: the item was delivered after the cycle's snapshot/);
  assert.equal(row.faultClass, undefined, 'and carries no fault class');
  assert.equal(row.attempts, 2, 'as one more attempt of the same report');
  assert.equal(state.faults.failing[key], undefined, 'the run the counting row opened is ended');
  assert.deepEqual(state.faults.instances.filter(entry => entry.kind === 'action:decision' && entry.subject === 'GY-1775'), [], 'and the instance it opened is dropped: delivery settled the target');
  assert.deepEqual(recurringClasses(state.faults.instances, [], faultClassPolicyDefaults, clock + hour(1)).filter(entry => entry.faultClass === 'decision'), [], 'so nothing of it stands in the decision class window');
  // The same refusal on a report nothing recorded writes no row: the settled target is not even named.
  const quiet = emptyDaemonState(config());
  await reportMechanicalPlans([item], [], effects, clock, planReportSink(quiet, note));
  assert.equal(quiet.actions[key], undefined, 'no row for a settled report nothing had recorded');
});

test('manual:fault-class-decision — the land route approves the verified head with the independent approver App, so the last-pusher rule merges an approved acceptance (GOAL-1)', async () => {
  const { landAcceptance } = await import('../src/server/routes/goals.js');
  const head = 'a'.repeat(40), pr = 1153, lastPusher = 'GitHub GraphQL query failed: New changes require approval from someone other than the last pusher.';
  const goal = { id: 'goal-1', key: 'GOAL-1', acceptance: { pr, author: 'graphyard-acceptance', outcomes: [{ case: { id: 'signup' } }] }, approval: { head, by: 'graphyard-approver', reason: 'The cases check what the customer asked for' } } as never;
  // GitHub as GOAL-1's base branch held it: the merger is the control-plane App, which pushed the
  // acceptance branch, so only an approval at exactly the merged head from an App other than it
  // satisfies the rule.
  function world(approver: boolean) {
    const reviews: { state: string; commit_id: string; performed_via_github_app: { id: number } }[] = [];
    const approvals: string[] = [], merges: { head: string; refused: boolean }[] = [];
    let merged = false;
    const github = {
      config: { base: 'main', appId: 1, repository: 'owner/project', ...(approver ? { revertApprover: { appId: 5678, installationId: 9, privateKey: 'not-used' } } : {}) },
      async approveAcceptance(_: number, sha: string) {
        if (!approver) return 'unconfigured' as const;
        approvals.push(sha); reviews.push({ state: 'APPROVED', commit_id: sha, performed_via_github_app: { id: 5678 } });
        return 'approved' as const;
      },
      async request(path: string) {
        if (path === `/pulls/${pr}`) return { state: merged ? 'closed' : 'open', merged, merge_commit_sha: merged ? 'c'.repeat(40) : null, node_id: `PR_${pr}`, head: { sha: head }, base: { ref: 'main' }, mergeable: true, mergeable_state: 'clean' };
        if (path === '/check-runs') return {};
        throw new Error(`unexpected GitHub call ${path}`);
      },
      async pages() { return []; },
      async upsertLandable() {},
      async graphql(_query: string, variables: { id: string; head: string }) {
        const approved = reviews.some(review => review.state === 'APPROVED' && review.commit_id === variables.head && review.performed_via_github_app.id !== 1);
        merges.push({ head: variables.head, refused: !approved });
        if (!approved) throw new Error(lastPusher);
        merged = true;
        return {};
      },
    };
    return { github, approvals, merges };
  }
  // Configured: one landing approves exactly the verified head as the independent approver App and merges.
  const configured = world(true);
  const landed = await landAcceptance(configured.github as never, goal);
  assert.equal(landed.state, 'merged', 'the last-pusher rule no longer strands the approved goal');
  assert.deepEqual(configured.approvals, [head], 'the approver approved exactly the verified head');
  assert.deepEqual(configured.merges, [{ head, refused: false }]);
  // Unconfigured: the merge is refused as before, and the waiting detail names the missing approver, so the
  // stuck landing reads as the configuration gap it is rather than a decision nobody made.
  const unconfigured = world(false);
  const waiting = await landAcceptance(unconfigured.github as never, goal);
  assert.equal(waiting.state, 'waiting');
  assert.match(waiting.detail, /New changes require approval from someone other than the last pusher/);
  assert.match(waiting.detail, /no independent approver App is configured \(GRAPHYARD_REVERT_APPROVER_APP_ID, GRAPHYARD_REVERT_APPROVER_INSTALLATION_ID, GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY\)/);
  assert.deepEqual(unconfigured.merges.map(merge => merge.refused), [true], 'the merge is still attempted, as the main guard attempts a refused approval');
});

// The approveAcceptance unit, over the real GitHub adapter: the acceptance approval is the revert
// approver App's (GY-1291), posted head-bound, and one already standing is not posted again.
test('manual:fault-class-decision — approveAcceptance is the independent approver App\'s head-bound approval, deduplicated on the standing one, unconfigured without it', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const { GitHub } = await import('../src/github.js');
  const head = 'b'.repeat(40), pr = 1153;
  const world = (approver: boolean) => {
    const github = new GitHub({ repository: 'fixture/repo', base: 'main', appId: 1, installationId: 2, privateKey: 'not-used', ...(approver ? { revertApprover: { appId: 5678, installationId: 9, privateKey } } : {}) });
    const state = { reviews: [] as any[], approvals: [] as { auth: string; commit: string }[] };
    github.fetch = (async (input: string, init: RequestInit = {}) => {
      const url = new URL(String(input)), method = init.method ?? 'GET', body = init.body ? JSON.parse(String(init.body)) : undefined;
      const auth = String((init.headers as Record<string, string>)?.Authorization);
      if (url.pathname === '/app/installations/9/access_tokens') return Response.json({ token: 'approver-installation-token' }, { status: 201 });
      if (url.pathname === `/repos/fixture/repo/pulls/${pr}/reviews` && method === 'GET') return Response.json(state.reviews);
      if (url.pathname === `/repos/fixture/repo/pulls/${pr}/reviews` && method === 'POST') {
        state.approvals.push({ auth, commit: body.commit_id });
        const review = { id: state.reviews.length + 1, state: 'APPROVED', commit_id: body.commit_id, performed_via_github_app: { id: auth === 'Bearer approver-installation-token' ? 5678 : 1 } };
        state.reviews.push(review);
        return Response.json(review);
      }
      return new Response(`unexpected ${method} ${url.pathname}`, { status: 500 });
    }) as typeof fetch;
    return { github, state };
  };
  const configured = world(true);
  assert.equal(await configured.github.approveAcceptance(pr, head, 'the landing approval'), 'approved');
  assert.deepEqual(configured.state.approvals, [{ auth: 'Bearer approver-installation-token', commit: head }], 'the approval is the approver App\'s, head-bound');
  assert.equal(await configured.github.approveAcceptance(pr, head, 'the landing approval'), 'approved');
  assert.equal(configured.state.approvals.length, 1, 'an approval already standing on the head is not posted again');
  assert.equal(await world(false).github.approveAcceptance(pr, head, 'the landing approval'), 'unconfigured', 'no approver App, no approval');
});

// GY-1888 names this file for its proof: manual:fault-class-decision. The master loop filed this
// item itself on 17 October 2026: 3 decision faults in 24 hours — owed-decision|GY-1834 at
// 22:35:33.279Z, action:decision|GY-1846 at 02:57:31.390Z, action:decision|GY-1884 at 08:25:26.339Z.
// The shared cause: the loop's decision machinery repeated an action the record or the runtime had
// already answered instead of adopting or recovering it, so the decisions it owed — including the
// new head a request-rework action owes — stood past every bound while the same refusal recurred
// and counted. Each instance is replayed through the loop's own cycle. Against the base each
// records the fault or repeats the refusal; against the candidate none.

const instanceClock = Date.parse('2026-10-17T02:00:00Z'), instanceIso = (offsetMs: number) => new Date(instanceClock + offsetMs).toISOString();
const instanceSha = 'b658b5a614e5'.padEnd(40, '0'), instanceBase = 'b'.repeat(40);
const loopConfig = config;

/** The item as each GY-1888 instance's loop snapshot held it: a candidate under review, no worker holding it. */
function instanceItem(key: string, reworkRequested: boolean, verdict: boolean): Work {
  const candidate = { sha: instanceSha, baseSha: instanceBase, pr: 1884, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' };
  const observation = {
    clockOffset: { min: 0, max: 0 }, candidate, checks: [{ name: 'test', result: 'success', appId: 15368 }],
    reviews: [{ reviewer: 'graphyard-reviewer[bot]', sha: instanceSha, state: verdict ? 'CHANGES_REQUESTED' : 'APPROVED', submittedAt: instanceIso(-600_000) }],
    protected: true, mergeable: true, merged: false, mergeSha: null, files: ['src/loop.ts'], scopeFiles: [], at: instanceIso(-20_000),
  };
  return {
    id: `00000000-0000-4000-8000-${key.replace(/\D/g, '').padStart(12, '0')}`, key, title: key, description: '', type: 'bug', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:loop'] }], policy: { checks: ['test'], review: true },
    plannedFiles: ['src/loop.ts'], stage: 'review', revision: 5, policyRevision: 1, createdAt: instanceIso(-3_600_000), updatedAt: instanceIso(0),
    stageEnteredAt: instanceIso(-1_800_000), ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: 1884 },
    candidate, reworkRequested, scenarioRequirements: [], evidence: [], observation, blocker: null, violations: [],
    gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: !verdict, reasons: verdict ? ['Outstanding change requests must be resolved through a new review'] : [] }],
  } as unknown as Work;
}

const instanceEffects = (work: () => Work, overrides: Partial<DaemonEffects>): DaemonEffects => ({
  agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
  snapshot: async () => ({ work: [work()], now: instanceIso(0), jobs: [] }),
  closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
  observeDeployment: async () => ({ source: 'unavailable', sha: null, at: instanceIso(0), reason: 'not configured', deployed: [], pending: [] }),
  recordDeployment: async () => {}, requestSmoke: () => {},
  decide: async () => ({ id: 'unused' }), decisions: async () => ({ decisions: [] }),
  approver: async () => ({ agentName: 'graphyard-approver', pane: 'pane-1' }), persist: async () => {},
  ...overrides,
});
const decisionInstances = (state: ReturnType<typeof emptyDaemonState>) => state.faults.instances.filter(instance => instance.faultClass === 'decision');

test('manual:fault-class-decision — action:decision|GY-1846|2026-10-17T02:57:31.390Z: a put the applied rework already answers is adopted, not refused on every retry', async () => {
  // The hold the control plane named: applied rework 067c0c4f for head b658b5a614e5, no worker having submitted since.
  const heldId = '067c0c4f-7b1f-4409-86be-b345107d3f31';
  const history = [{ id: heldId, action: 'rework', state: 'applied', input: { previousWorkerStopped: true }, requestedAt: instanceIso(-3_600_000), approvedAt: instanceIso(-3_500_000), approvedBy: 'graphyard-approver-graphyard', situation: { sha: instanceSha, baseSha: instanceBase }, reason: 'The reviewer requested changes on head b658b5a614e5' }];
  // The loop's snapshot predates the application (an observation-only install reads slowly), so the
  // verdict grounds still compute a rework; the control plane refuses the put naming the hold, every time.
  let work = instanceItem('GY-1846', false, true);
  const refusedPut = () => new RefusedResponse(`Graphyard refused work/${work.id}/decide (409): GY-1846 already holds rework: decision ${heldId} was applied for head ${instanceSha.slice(0, 12)} and no worker has submitted since, so the item waits for a worker on it and a second rework authorizes nothing. If no worker takes it, what holds its dispatch (an unfinished dependency, a blocker, a fenced launch) is the lever, not another rework`, 409, { heldRework: { decision: heldId } });
  const puts: number[] = [];
  const state = emptyDaemonState(loopConfig());
  await runCycle(loopConfig(), state, instanceEffects(() => work, {
    decide: async () => { puts.push(state.cycle); throw refusedPut(); },
    decisions: async () => ({ decisions: structuredClone(history) }),
  }), () => instanceClock);
  const adoptedRow = () => Object.values(state.actions).find(action => action.kind === 'decision' && action.state === 'done' && /already holds rework decision/.test(action.detail));
  // The candidate: the refusal names the applied rework the record holds, so it is adopted as answered —
  // done once, no fault, and nothing is put again on the item's next cycle.
  assert.match(adoptedRow()?.detail ?? '', /already holds rework decision 067c0c4f/, JSON.stringify(state.actions));
  assert.deepEqual(decisionInstances(state), [], 'a hold that answers the request judged nothing');
  await runCycle(loopConfig(), state, instanceEffects(() => work, {
    decide: async () => { puts.push(state.cycle); throw refusedPut(); },
    decisions: async () => ({ decisions: structuredClone(history) }),
  }), () => instanceClock + 90_000);
  assert.equal(puts.length, 1, 'the adopted hold is never asked for a second rework');
  assert.deepEqual(decisionInstances(state), []);
});

test('manual:fault-class-decision — action:decision|GY-1884|2026-10-17T08:25:26.339Z: a launch the runtime refuses for its own held name recovers the pane and launches', async () => {
  // The leftover: pane w1V:pQGR held the decision's own approver name while the session inventory
  // listed nothing under it — by the loop's own liveness rule, a session that is gone.
  const decisionId = 'a17c5808-0000-4000-8000-000000001884';
  const name = approverSessionName({ key: 'GY-1884' } as Work, decisionId);
  const heldName = () => new Error(`No session can be launched as ${JSON.stringify(name)}: the runtime refused it: {"error":{"code":"agent_name_taken","message":"agent name ${name} is already used; candidates: terminal_id=term_65e050436138156a0 pane_id=w1V:pQGR workspace_id=w1V tab_id=w1V:tQGM. A session name must start with a lowercase letter, use only lowercase letters, digits, '-' or '_', and be 1-32 characters. Retry with graphyard master approver GY-1884 ${decisionId}"}}`);
  let work = instanceItem('GY-1884', false, true);
  const launches: string[] = [], closed: string[] = [], ended: string[] = [], order: string[] = [];
  const state = emptyDaemonState(loopConfig());
  await runCycle(loopConfig(), state, instanceEffects(() => work, {
    decide: async () => ({ id: decisionId }),
    decisions: async () => ({ decisions: [{ id: decisionId, action: 'rework', state: 'requested', input: {}, approvedBy: null }] }),
    approver: async () => { launches.push(decisionId); if (launches.length === 1) throw heldName(); order.push('launch'); return { agentName: name, pane: 'w1V:pNEW' }; },
    // The leftover's pane-bound launch record names the registry session that still holds the role's slot.
    approverLaunch: async () => ({ account: null, runtime: 'claude', session: 'registry-1884', pane: 'w1V:pQGR' }),
    endRegistrySession: async session => { ended.push(session); order.push('end'); },
    closeSession: pane => { closed.push(pane); order.push('close'); },
  }), () => instanceClock);
  // The candidate: the refusal names the pane that holds the decision's own name; the loop ends the
  // leftover's registry session (freeing the role's slot), closes the pane and makes the launch once
  // more, so the decision is put to an approver instead of standing.
  assert.deepEqual(ended, ['registry-1884'], 'the leftover registry session is ended, so the retry is not refused for the role slot it held');
  assert.deepEqual(order, ['end', 'close', 'launch'], 'the session is ended and the pane closed before the launch is made again');
  assert.deepEqual(closed, ['w1V:pQGR'], 'the leftover pane holding the name is closed');
  assert.deepEqual(launches, [decisionId, decisionId], 'the launch is made again once the leftover is gone');
  const watch = Object.values(state.approvals).find(entry => entry.decision === decisionId);
  assert.equal(watch?.pane, 'w1V:pNEW', 'the watch holds the session the recovered launch started');
  assert.deepEqual(decisionInstances(state), [], 'a recovered launch judged nothing');
  assert.ok(Object.values(state.actions).some(action => action.state === 'done' && /closed leftover approver pane w1V:pQGR/.test(action.detail)), JSON.stringify(state.actions));
  // A pane the inventory lists under another name is a live session this decision's name cannot be
  // judged against: it is left alone, and the failure stands as it did before.
  const live = emptyDaemonState(loopConfig());
  await runCycle(loopConfig(), live, instanceEffects(() => work, {
    decide: async () => ({ id: decisionId }),
    decisions: async () => ({ decisions: [{ id: decisionId, action: 'rework', state: 'requested', input: {}, approvedBy: null }] }),
    approver: async () => { launches.push('live'); throw heldName(); },
    closeSession: pane => { closed.push(pane); },
    herdr: () => ({ agents: [{ name: 'something-else', pane_id: 'w1V:pQGR', agent: 'claude', agent_status: 'working' }], available: true }),
  }), () => instanceClock);
  assert.deepEqual(launches, [decisionId, decisionId, 'live'], 'the live pane was attempted once and never closed or retried');
  assert.deepEqual(closed, ['w1V:pQGR'], 'nothing more was closed: a listed pane is not ours to close');
  assert.ok(Object.values(live.actions).some(action => action.state === 'failed' && /agent_name_taken/.test(action.detail)), 'the refusal stands');
});

test('manual:fault-class-decision — action:decision|GY-1884: a recovery relaunch that loses the freed slot or every account waits for capacity, not a failed decision', async () => {
  // Review of 6653b93a: once the leftover is ended and closed, another launch can take the freed slot (a role-capacity refusal) or the
  // last account (capacityExhausted) before the recovery's own relaunch. Either is the capacity wait the first launch's refusal would be.
  const decisionId = 'a17c5808-0000-4000-8000-000000001885';
  const name = approverSessionName({ key: 'GY-1884' } as Work, decisionId);
  const heldName = () => new Error(`No session can be launched as ${JSON.stringify(name)}: the runtime refused it: {"error":{"code":"agent_name_taken","message":"agent name ${name} is already used; candidates: terminal_id=term_1 pane_id=w1V:pQGR workspace_id=w1V tab_id=w1V:tQGM"}}`);
  const slotTaken = () => Object.assign(new Error('approver role is at its concurrency limit of 1'), { roleAtCapacity: 'approver role is at its concurrency limit of 1 (1 running)' });
  const accountsSpent = () => Object.assign(new Error('every approver account is spent until 12:00Z'), { capacityExhausted: true });
  for (const [form, refusal, wait] of [['role capacity', slotTaken, /concurrency limit of 1 \(1 running\)/], ['capacityExhausted', accountsSpent, /every approver account is spent/]] as const) {
    const work = instanceItem('GY-1884', false, true), closed: string[] = [], ended: string[] = [];
    let launches = 0;
    const state = emptyDaemonState(loopConfig());
    await runCycle(loopConfig(), state, instanceEffects(() => work, {
      decide: async () => ({ id: decisionId }),
      decisions: async () => ({ decisions: [{ id: decisionId, action: 'rework', state: 'requested', input: {}, approvedBy: null }] }),
      approver: async () => { launches += 1; throw launches === 1 ? heldName() : refusal(); },
      approverLaunch: async () => ({ account: null, runtime: 'claude', session: 'registry-1885', pane: 'w1V:pQGR' }),
      endRegistrySession: async session => { ended.push(session); },
      closeSession: pane => { closed.push(pane); },
    }), () => instanceClock);
    assert.deepEqual([ended, closed, launches], [['registry-1885'], ['w1V:pQGR'], 2], `${form}: the leftover is ended and closed and the launch made once more`);
    const watch = Object.values(state.approvals).find(entry => entry.decision === decisionId)!;
    assert.match(watch.capacity ?? '', wait, `${form}: the watch keeps the capacity wait, so it stays in the oldest-first relaunch queue`);
    assert.equal(watch.launches, 0, `${form}: a launch no slot or account took is not counted against the bound`);
    assert.equal(Object.values(state.actions).filter(action => action.kind === 'decision' && action.state === 'failed').length, 0, `${form}: no failed decision action: ${JSON.stringify(Object.fromEntries(Object.entries(state.actions).filter(([, action]) => action.kind === 'decision')))}`);
    assert.ok(Object.values(state.actions).some(action => action.kind === 'decision' && action.state === 'done' && /closed leftover approver pane w1V:pQGR/.test(action.detail) && /approver (slot|capacity)/.test(action.detail)), `${form}: the recovery is named beside the wait`);
    assert.deepEqual(decisionInstances(state), [], `${form}: a capacity wait judged nothing`);
  }
});

test('manual:fault-class-decision — owed-decision|GY-1834|2026-10-16T22:35:33.279Z: the new head the owed rework names is produced, so the line never stands past its bound', async () => {
  // The instance: the reviewer's change request owed GY-1834 a new head; for 52 minutes nothing
  // produced it or settled the decision, because the approver launch met the same held-name refusal
  // the GY-1884 instance names, and the decision stood unjudged past the wait bound.
  const decisionId = '969b64a9-0000-4000-8000-000000001834';
  const name = approverSessionName({ key: 'GY-1834' } as Work, decisionId);
  const heldName = () => new Error(`No session can be launched as ${JSON.stringify(name)}: the runtime refused it: {"error":{"code":"agent_name_taken","message":"agent name ${name} is already used; candidates: terminal_id=term_65e050436138156a0 pane_id=w1V:pQGR workspace_id=w1V tab_id=w1V:tQGM. A session name must start with a lowercase letter, use only lowercase letters, digits, '-' or '_', and be 1-32 characters. Retry with graphyard master approver GY-1834 ${decisionId}"}}`);
  // The action row the fault line is dated from, new when the first cycle runs (the round is in
  // motion there), so it stands past the bound only if the decision never lands.
  const rowKey = 'request-rework:GY-1834';
  const at = (offsetMs: number) => new Date(instanceClock + offsetMs).toISOString();
  const withRow = (item: Work, when: string): Work => {
    const action: NextAction = { kind: 'request-rework', work: item.id, key: item.key, gate: 'review', refusal: 'Outstanding change requests must be resolved through a new review',
      reason: `${item.key} needs a new head: graphyard-reviewer[bot] requested changes on ${instanceSha.slice(0, 12)}; the next head is reviewed afresh`,
      inputs: { kind: 'request-rework', pr: 1834, sha: instanceSha, detail: `graphyard-reviewer[bot] requested changes on ${instanceSha.slice(0, 12)}; the next head is reviewed afresh` }, llmRole: 'approve-decision', binding: rowKey };
    return { ...item, nextAction: { ...action, needsHuman: humanNeeded(action)! }, actionQueue: { actions: [{ id: `row-${item.key}`, key: item.key, work: item.id, kind: 'request-rework', gate: 'review', binding: rowKey, inputs: action.inputs, reason: action.reason,
      refusal: action.refusal, state: 'requested', claim: null, result: null, resolution: null, resolvedAt: null, attempts: 0, history: [], requestedAt: when, requestedBy: 'graphyard' }], history: [] } } as unknown as Work;
  };
  let judged = false; // the control plane applied the rework once an approver could be launched
  const item = () => {
    const base = instanceItem('GY-1834', judged, !judged);
    if (judged) return base; // the applied rework moves the item to the dispatch the hold authorizes
    return withRow(base, at(0));
  };
  const launches: string[] = [], closed: string[] = [];
  const state = emptyDaemonState(loopConfig());
  const fx = () => instanceEffects(item, {
    decide: async () => ({ id: decisionId }),
    decisions: async () => ({ decisions: judged ? [{ id: decisionId, action: 'rework', state: 'applied', input: {}, approvedBy: 'graphyard-approver-graphyard' }] : [{ id: decisionId, action: 'rework', state: 'requested', input: {}, approvedBy: null }] }),
    approver: async () => { launches.push(decisionId); if (launches.length === 1) throw heldName(); judged = true; return { agentName: name, pane: 'w1V:pNEW' }; },
    closeSession: pane => { closed.push(pane); },
  });
  await runCycle(loopConfig(), state, fx(), () => instanceClock);
  assert.deepEqual(closed, ['w1V:pQGR'], 'the held name is recovered, as the GY-1884 instance requires');
  // The rework judged and applied, the item waits for a worker on the hold: a fresh attempt is the
  // lever, and no decision is owed any more.
  await runCycle(loopConfig(), state, fx(), () => instanceClock + 90_000);
  assert.equal(judged, true, 'the decision was judged');
  // The instance's own instant: 52 minutes after the row was requested, the line has nothing to name.
  const late = instanceClock + 52 * 60_000;
  await runCycle(loopConfig(), state, fx(), () => late);
  const reported = humanNeededAttention({ work: [item()], now: at(52 * 60_000) });
  assert.deepEqual(reported.map(line => line.text), [], 'the new head was produced, so nothing is owed any more');
  assert.deepEqual(decisionInstances(state), [], 'the line the instance counted never stands');

  // The mechanism the instance counted is the classifier's own: had the decision stood unlanded —
  // as it did against the base, whose launches stayed refused — the same instant counts it.
  const unlanded = withRow(instanceItem('GY-1834', false, true), at(0));
  const standingLine = humanNeededAttention({ work: [unlanded], now: at(52 * 60_000) });
  assert.match(standingLine[0]?.text ?? '', /a new head for GY-1834 has been owed for 52m/, JSON.stringify(standingLine));
  const counted = cycleFaults(emptyDaemonState(loopConfig()), [unlanded], late, { config: loopConfig(), reported: standingLine }).filter(fault => fault.faultClass === 'decision');
  assert.deepEqual(counted.map(fault => fault.kind), ['owed-decision'], 'the instance, reproduced as the base held it');
});

// GY-2015 names this file for its proof: manual:fault-class-decision. The master loop filed 3
// decision faults in 24 hours on 18 October 2026, 04:20–04:29Z. Each was an `owed-decision` line
// for an item refused at the test gate with `merge writer has not trialled …` (trialRefusal,
// model/gates.ts) — the control-plane test gate's refusal until the merge ledger holds a passing
// trial of exactly that head on exactly that base tip. All three stood on the same base tip
// 9bc46db8f4e8, refused within a 14-minute window, owed 30–36 minutes: the serial merge writer
// (mergeQueue: oldest first, one merge in flight, an open intent blocks the queue) trialled one
// head at a time (merge + build + the fast tests, GY-1832 re-queues on no verdict), and every
// later head counted an unanswered decision at the 30-minute bound while its only answerer — the
// writer reaching it — was exactly what the loop was watching do its work. The named resolution
// (graphyard diagnose, concerns.ts humanNeeded) is run by nothing and could not hurry a trial.
//
// The shared cause: the owed-decision fault had no suppression keyed to the writer's own motion
// (faults.ts keyed rework, escalation and containment turns, never the writer's). The candidate
// keys it to demonstrated movement — a trial in flight, a delivery, a refusal recorded, a trial
// failure — reading the writer summary the loop itself keeps (state.mergeWriter, the GY-1966
// pattern), inside the bound (GY-1315's inMotionUntil); and when the writer itself cannot move
// past the bound, one writer-level stall on subject `merge-writer` stands for the queue instead
// of an owed decision per head. Each instance is replayed as the item and the writer stood when
// the loop recorded it, with the line master status reported. Against the base each subtest
// fails: the instance reproduces.
//
// GY-2053 extends the accounting to the flight the same loop recorded that afternoon: the same
// shape fired again at 09:32:04.594Z from one fault pass — a 36m52s flight (a timeout-plus-retrial
// chain) whose flat 30-minute inMotionUntil had expired 47s before the pass, two queued heads
// behind it counted, and the front head's merge-gate push refusal (`merge writer has not pushed
// …`, pushRefusal) had never been held at all, because the hold required the test gate. The hold
// now covers both control-plane refusals of a head the queue holds or has in flight, and the
// bound is the writer's own configured worst case for one flight ((retrials + 1) × the
// trial timeout plus a cycle, mergeWriterFlightBoundMs) with the attempt progress (a retrial's
// intent, a trial verdict, a push, a reconcile) recorded beside every ledger write keeping the
// movement fresh inside a multi-attempt flight — a hold expires only when no flight is in progress
// and no movement stands inside that bound.

const gy2015Base = '9bc46db8f4e8'.padEnd(40, '0');
const gy2015Heads: Record<string, string> = { 'GY-1999': '19b8c5d6eaa2'.padEnd(40, '0'), 'GY-2007': 'bc6e928cd5b4'.padEnd(40, '0'), 'GY-2001': '9d824e1ed743'.padEnd(40, '0') };
const gy2015Instances = [
  { subject: 'GY-1999', at: '2026-10-18T04:20:07.533Z', owed: '36m', owedMs: 36 * 60_000 },
  { subject: 'GY-2007', at: '2026-10-18T04:24:07.832Z', owed: '35m', owedMs: 35 * 60_000 },
  { subject: 'GY-2001', at: '2026-10-18T04:28:58.411Z', owed: '30m', owedMs: 30 * 60_000 },
];

/** The item as the instance stood: a candidate the test gate refuses because the merge writer has not trialled its head on the base tip yet. */
function trialRefused(subject: string, requestedAt: string, heads: Record<string, string> = gy2015Heads): Work {
  const sha = heads[subject]!;
  const work = standing({ subject, detail: '', owedMs: 0, owed: '' }, requestedAt);
  const refusal = trialRefusal(sha, gy2015Base);
  const action: NextAction = { kind: 'escalate', work: work.id, key: subject, gate: 'test', refusal,
    reason: `${subject} is refused at the test gate and no executor step answers it: ${refusal}`,
    inputs: { kind: 'escalate', trigger: 'test', detail: refusal } as NextAction['inputs'], llmRole: null,
    binding: `test:1:${sha.slice(0, 12)}:${gy2015Base.slice(0, 12)}:${refusal}` };
  Object.assign(work, { stage: 'test', candidate: { sha, baseSha: gy2015Base, pr: 2015, branch: `graphyard/${subject.toLowerCase()}-1`, author: 'implementer' },
    nextAction: { ...action, needsHuman: humanNeeded(action)! } });
  Object.assign(work.actionQueue!.actions[0], { kind: 'escalate', gate: 'test', binding: action.binding, refusal, reason: action.reason });
  return work;
}

/**
 * GY-2053: the item as GY-2011 stood at 09:32:04 — its test gate passed, the merge gate refuses
 * `merge writer has not pushed <head>` (pushRefusal) until the ledger records the push reconciled,
 * and the push is the writer's own next step, never a judgment.
 */
function pushRefused(subject: string, requestedAt: string, heads: Record<string, string> = gy2015Heads): Work {
  const sha = heads[subject]!;
  const work = trialRefused(subject, requestedAt, heads);
  const refusal = pushRefusal(sha);
  const action: NextAction = { kind: 'escalate', work: work.id, key: subject, gate: 'merge', refusal,
    reason: `${subject} is refused at the merge gate and no executor step answers it: ${refusal}`,
    inputs: { kind: 'escalate', trigger: 'merge', detail: refusal } as NextAction['inputs'], llmRole: null,
    binding: `merge:1:${sha.slice(0, 12)}:${refusal}` };
  Object.assign(work, { stage: 'merge', nextAction: { ...action, needsHuman: humanNeeded(action)! } });
  Object.assign(work.actionQueue!.actions[0], { kind: 'escalate', gate: 'merge', binding: action.binding, refusal, reason: action.reason });
  return work;
}

/** The writer's own motion bound, as the loop now holds it: the configured worst case for one flight at the default settings — (3 retrials + 1) × 20-minute trial timeout plus a 20-second cycle — inside which GY-2011's 37-minute flight stays in motion. Read lazily, so the base exercise loads this file. */
const gy2015MotionBound = () => mergeWriterModule.mergeWriterFlightBoundMs({ intervalSeconds: 20 });

/** The writer state the loop held while the instance stood: the serial queue with all three heads, one trial in flight, the last delivery recorded. */
function gy2015Writer(observedAt: string, inFlight = true): MergeWriterSummary {
  const now = Date.parse(observedAt);
  const queue = Object.entries(gy2015Heads).map(([subject, sha], index) => ({ key: subject, id: `work-${subject}`, head: sha.toLowerCase(),
    submittedAt: new Date(now - (72 - index * 6) * 60_000).toISOString(), waitingMs: (72 - index * 6) * 60_000 }));
  return {
    lastMergeAt: new Date(now - 9 * 60_000).toISOString(), queue,
    inFlight: inFlight ? { key: queue[0]!.key, id: queue[0]!.id, head: queue[0]!.head, startedAt: new Date(now - 2 * 60_000).toISOString() } : null,
    refusals: [{ key: 'GY-1978', head: 'a'.repeat(40), reason: 'base moved 3 times', at: new Date(now - 14 * 60_000).toISOString() }],
    reworks: [], progress: undefined, motionBoundMs: gy2015MotionBound(),
  };
}

for (const entry of gy2015Instances) test(`manual:fault-class-decision — owed-decision|${entry.subject}|${entry.at} is no fault while the merge writer moves toward its head`, () => {
  const now = Date.parse(entry.at);
  const work = trialRefused(entry.subject, new Date(now - entry.owedMs).toISOString());
  const writer = gy2015Writer(entry.at);
  const reported = humanNeededAttention({ work: [work], now: entry.at }, writer);
  // The line master status reported is the instance's own text, so the replay is the instance;
  // the writer's newest movement bounds it (GY-1315), the flight started two minutes before, inside
  // the writer's own worst-case bound for one flight (GY-2053), not the flat default any more.
  assert.deepEqual(reported.map(line => line.text),
    [`${entry.subject} is refused at the test gate and no executor step answers it: merge writer has not trialled ${gy2015Heads[entry.subject]!.slice(0, 12)} on ${gy2015Base.slice(0, 12)} — no executor may run it; resolving ${entry.subject}'s test refusal has been owed for ${entry.owed}`]);
  assert.equal(reported[0]!.inMotionUntil, new Date(now + owed.mergeWriterMotionBound(writer)).toISOString(), 'a live flight holds the line a bound past this reading');
  assert.equal(owed.mergeWriterMotionBound(writer), gy2015MotionBound(), "the summary's own bound, not the flat default");
  const counted = cycleFaults(emptyDaemonState(config()), [work], now, { config: config(), reported }).filter(fault => fault.faultClass === 'decision');
  assert.deepEqual(counted.map(fault => fault.kind), [], `${entry.subject}'s head was queued behind the writer's serial trials when the loop recorded it`);
  // The queue's one stall line does not stand beside moving heads: the writer is at work.
  assert.equal(mergeWriterStallAttention(writer, now), null);
});

test('manual:fault-class-decision — the queue\'s one writer-level stall stands for held heads once the writer itself cannot move', () => {
  // The bound past: no trial in flight and no movement for 90 minutes — past the writer's own
  // worst-case bound for a flight — so the writer cannot serve the queue it still holds. The
  // per-item lines are gone (the stall stands for them), and the cycle counts one stalled step
  // on the writer, no owed decision per head.
  const at = '2026-10-18T05:20:00.000Z', now = Date.parse(at);
  const writer = { ...gy2015Writer(at, false), lastMergeAt: new Date(now - 90 * 60_000).toISOString(), refusals: [], reworks: [], inFlight: null };
  const works = gy2015Instances.map(entry => trialRefused(entry.subject, new Date(now - entry.owedMs - 2 * 60 * 60_000).toISOString()));
  const reported = humanNeededAttention({ work: works, now: at }, writer);
  assert.deepEqual(reported.map(line => line.text), [], 'the stall stands for the held heads, not beside them');
  const stall = mergeWriterStallAttention(writer, now)!;
  assert.match(stall.text, /queue holds 3 head\(s\) it cannot move: no trial is in flight and its newest movement is the last merge was delivered/);
  assert.match(stall.text, /GY-1999's head 19b8c5d6eaa2 has waited \d+ minutes at the front/);
  assert.equal(stall.kind, 'stalled-step');
  assert.match(stall.next!, /merge-writer step/);
  const counted = cycleFaults(emptyDaemonState(config()), works, now, { config: config(), reported: [...reported, stall] });
  assert.deepEqual(counted.map(fault => `${fault.kind}|${fault.subject}`), ['stalled-step|merge-writer'], 'one writer-level stall for the queue');
  // The writer's newest movement is the reading the stall text carries; the writer's own bound is what it stands past.
  assert.equal(mergeWriterMovement(writer)!.at, Date.parse(writer.lastMergeAt));
  assert.ok(now - mergeWriterMovement(writer)!.at > owed.mergeWriterMotionBound(writer));
});

test('manual:fault-class-decision — a trial refusal whose head the writer does not hold, and every other test-gate refusal, still count', () => {
  // The genuine gap the writer cannot answer: its queue holds nothing for the item (the writer
  // will never reach that head on its own), so the owed decision stands as it did.
  const entry = gy2015Instances[0]!;
  const now = Date.parse(entry.at);
  const work = trialRefused(entry.subject, new Date(now - entry.owedMs).toISOString());
  const writer = { ...gy2015Writer(entry.at), queue: gy2015Writer(entry.at).queue.slice(1), inFlight: null }; // GY-1999 absent from the queue and from the flight
  const counted = cycleFaults(emptyDaemonState(config()), [work], now, { config: config(), reported: humanNeededAttention({ work: [work], now: entry.at }, writer) }).filter(fault => fault.faultClass === 'decision');
  assert.deepEqual(counted.map(fault => fault.kind), ['owed-decision'], 'a head the queue does not hold is nobody\'s motion');
  // A test-gate refusal that is not the writer's trial refusal is never held: the rerun-grounded
  // escalate of a failed required check counts at once, writer moving or not.
  const rerun = trialRefused(entry.subject, new Date(now - entry.owedMs).toISOString());
  const refusal = 'rerun: failed again after rerunning its failed jobs';
  const action: NextAction = { kind: 'escalate', work: rerun.id, key: rerun.key, gate: 'test', refusal,
    reason: `${rerun.key} is refused at the test gate and no executor step answers it: ${refusal}`,
    inputs: { kind: 'escalate', trigger: 'test', detail: refusal } as NextAction['inputs'], llmRole: null, binding: 'test:rerun' };
  Object.assign(rerun, { nextAction: { ...action, needsHuman: humanNeeded(action)! } });
  Object.assign(rerun.actionQueue!.actions[0], { kind: 'escalate', gate: 'test', binding: action.binding, refusal, reason: action.reason });
  const rerunCounted = cycleFaults(emptyDaemonState(config()), [rerun], now, { config: config(), reported: humanNeededAttention({ work: [rerun], now: entry.at }, gy2015Writer(entry.at)) }).filter(fault => fault.faultClass === 'decision');
  assert.deepEqual(rerunCounted.map(fault => fault.kind), ['owed-decision'], 'a non-trial test refusal is a judgment nobody takes');
  // Without the writer summary — an older caller, or a status read before the writer ran — every line stands as before.
  const unthreaded = cycleFaults(emptyDaemonState(config()), [work], now, { config: config(), reported: humanNeededAttention({ work: [work], now: entry.at }) }).filter(fault => fault.faultClass === 'decision');
  assert.deepEqual(unthreaded.map(fault => fault.kind), ['owed-decision'], 'no writer summary, no suppression');
});

test('manual:fault-class-decision — owedAttention carries the writer stall and drops only the held heads it replaces', () => {
  const at = '2026-10-18T05:20:00.000Z', now = Date.parse(at);
  const writer = { ...gy2015Writer(at, false), lastMergeAt: new Date(now - 90 * 60_000).toISOString(), refusals: [], reworks: [], inFlight: null };
  const works = gy2015Instances.map(entry => trialRefused(entry.subject, new Date(now - entry.owedMs - 2 * 60 * 60_000).toISOString()));
  const owed = owedAttention({ work: works, now: at }, works.map(item => ({ key: item.key, attention: null })), [] as never[], writer);
  assert.deepEqual(owed.items.map(item => `${item.subject}`), ['merge-writer'], 'the stall is the queue\'s one line');
  // A queue with a trial in flight keeps the held heads as items, each bounded by the writer's movement (the
  // fault count skips them); a queue at all without a writer summary keeps them unbounded, as before.
  const moving = owedAttention({ work: works, now: at }, works.map(item => ({ key: item.key, attention: null })), [] as never[], gy2015Writer(at));
  assert.deepEqual(moving.items.map(item => item.subject), works.map(item => item.key));
  assert.deepEqual(moving.items.map(item => !!item.inMotionUntil), works.map(() => true), 'each held line carries the movement bound');
  assert.deepEqual(owedAttention({ work: works, now: at }, works.map(item => ({ key: item.key, attention: null })), [] as never[]).items.map(item => item.subject), works.map(item => item.key), 'no writer summary, every line stands');
  assert.deepEqual(owedAttention({ work: works, now: at }, works.map(item => ({ key: item.key, attention: null })), [] as never[]).items.map(item => !!item.inMotionUntil), works.map(() => false));
});

// GY-2053 names this file for its proofs: the same accounting fired again at 09:32:04.594Z from one
// fault pass while the writer was mid-flight on GY-2011 — a 36m52s flight (a timeout-plus-retrial
// chain) whose flat 30-minute inMotionUntil had expired 47s before the pass, so the two heads queued
// behind it counted, and whose own head's merge-gate push refusal had never been held at all, because
// the hold required the test gate. No decision was owed: the writer's trials are its own serial work.
// The tests replay that shape and hold the writer's own work out of the class for the whole live flight.

/** The base tip and the three heads of the 09:32:04Z shape, as the incident's own journal names them. */
const gy2053Base = 'c26cd7bcac37'.padEnd(40, '0');
const gy2053Heads: Record<string, string> = { 'GY-2011': '66f37f2604f1'.padEnd(40, '0'), 'GY-2004': '0b0a397ad79f'.padEnd(40, '0'), 'GY-2012': 'c1f59287e8c5'.padEnd(40, '0') };
const gy2053Flight = '2026-10-18T09:01:17.024Z', gy2053Pass = '2026-10-18T09:32:04.594Z', gy2053Settled = '2026-10-18T09:38:09.377Z';

/**
 * The writer as the 09:32:04Z shape held it: the serial queue oldest first with GY-2011 at the front
 * and its flight 30m47s in, no progress named yet (a flight of one attempt names none until its first
 * retrial), the bound the writer's own summary now carries — its configured worst case for one flight
 * at the default settings, (3 retrials + 1) × 20-minute trial timeout plus a 20-second cycle.
 */
function writer2053(at: string, overrides: Partial<MergeWriterSummary> = {}): MergeWriterSummary {
  const now = Date.parse(at);
  const queue = Object.entries(gy2053Heads).map(([subject, sha], index) => ({ key: subject, id: `work-${subject}`, head: sha.toLowerCase(),
    submittedAt: new Date(now - (38 + (2 - index) * 4) * 60_000).toISOString(), waitingMs: (38 + (2 - index) * 4) * 60_000 }));
  return { queue, inFlight: { key: 'GY-2011', id: 'work-GY-2011', head: gy2053Heads['GY-2011']!.toLowerCase(), startedAt: gy2053Flight },
    lastMergeAt: new Date(now - 37 * 60_000).toISOString(), refusals: [], reworks: [], progress: undefined,
    motionBoundMs: mergeWriterModule.mergeWriterFlightBoundMs({ intervalSeconds: 20 }), ...overrides };
}

/** The decision-class faults one observation counts, with the lines `master status` derived for it. */
function observedFaults(works: Work[], at: string, writer: MergeWriterSummary | null) {
  const reported = humanNeededAttention({ work: works, now: at }, writer);
  return { reported, counted: cycleFaults(emptyDaemonState(config()), works, Date.parse(at), { config: config(), reported }).filter(fault => fault.faultClass === 'decision') };
}

/** The two heads behind the flight, refused at the test gate; GY-2011 as the pass counted it, refused at the merge gate. */
const queued2053 = (requestedAt: string) => ['GY-2004', 'GY-2012'].map(subject => trialRefused(subject, requestedAt, gy2053Heads));
const front2053 = (requestedAt: string) => pushRefused('GY-2011', requestedAt, gy2053Heads);

test('manual:fault-class-decision — owed-decision|GY-2004, GY-2012 and GY-2011 at 09:32:04.594Z are no fault inside the writer\'s 37-minute flight', () => {
  const now = Date.parse(gy2053Pass), writer = writer2053(gy2053Pass), bound = owed.mergeWriterMotionBound(writer);
  assert.ok(now - Date.parse(gy2053Flight) > mergeWriterMotionBoundMs && now - Date.parse(gy2053Flight) < bound,
    'the flight had outlived the flat 30-minute bound the pass counted it against and stands inside the writer\'s own worst case');
  const works = [...queued2053(new Date(now - 38 * 60_000).toISOString()), front2053(new Date(now - 38 * 60_000).toISOString())];
  const { reported, counted } = observedFaults(works, gy2053Pass, writer);
  assert.deepEqual(reported.map(line => line.subject), ['GY-2004', 'GY-2011', 'GY-2012'], 'both queued trial refusals and the front head\'s push refusal stand, each named');
  assert.deepEqual(reported.map(line => line.inMotionUntil), works.map(() => new Date(now + bound).toISOString()),
    'each is held the writer\'s own worst case past this reading while the flight is alive, not the flat bound');
  assert.deepEqual(counted.map(fault => fault.kind), [], 'no owed-decision instance opens while the flight is alive');
  assert.equal(mergeWriterStallAttention(writer, now), null, 'the stall waits for a writer with no flight');
  // A retrial inside the flight keeps the hold: the retrial's recorded intent is the newest movement.
  const retried = writer2053(gy2053Pass, { progress: { at: new Date(Date.parse(gy2053Flight) + 20 * 60_000).toISOString(),
    what: mergeWriterModule.attemptProgressLine({ key: 'GY-2011' }, { kind: 'intent', head: gy2053Heads['GY-2011']!, baseTip: gy2053Base, mergeSha: 'd'.repeat(40), risk: 'low', at: gy2053Pass } as never) } });
  assert.equal(mergeWriterMovement(retried)!.at, Date.parse(gy2053Flight) + 20 * 60_000, 'the retrial is the newest movement');
  assert.deepEqual(observedFaults(works, gy2053Pass, retried).counted.map(fault => fault.kind), []);
  // The same instant with the lines the base reported — each held the flat 30-minute bound from the
  // flight's start, so its inMotionUntil had expired 47s before the pass — reproduces the instances.
  assert.equal(owed.mergeWriterMotionBound(writer2053(gy2053Pass, { motionBoundMs: undefined })), mergeWriterMotionBoundMs);
  const based = reported.map(line => ({ ...line, inMotionUntil: new Date(Date.parse(gy2053Flight) + mergeWriterMotionBoundMs).toISOString() }));
  assert.deepEqual(cycleFaults(emptyDaemonState(config()), works, now, { config: config(), reported: based }).filter(fault => fault.faultClass === 'decision').map(fault => `${fault.kind}|${fault.subject}`).sort(),
    ['owed-decision|GY-2004', 'owed-decision|GY-2011', 'owed-decision|GY-2012'], 'the three instances, replayed as the base counted them');
});

test('manual:fault-class-decision — the hold expires only when no flight is in progress and no movement stands inside the writer\'s own bound', () => {
  const now = Date.parse(gy2053Pass), works = queued2053(new Date(now - 38 * 60_000).toISOString());
  // The flight settled (its refusal recorded 36m52s after it started) and the next head's flight is
  // seconds in: the newest movement is fresh, so every still-held line stands and the class is quiet.
  const next = writer2053(gy2053Settled, { queue: writer2053(gy2053Settled).queue.slice(1),
    inFlight: { key: 'GY-2004', id: 'work-GY-2004', head: gy2053Heads['GY-2004']!.toLowerCase(), startedAt: gy2053Settled },
    refusals: [{ key: 'GY-2011', head: gy2053Heads['GY-2011']!.toLowerCase(), reason: 'trial failed: tests tests/item-page-structure.test.ts', at: gy2053Settled }] });
  assert.deepEqual(observedFaults(works, gy2053Settled, next).counted.map(fault => fault.kind), [], 'the next flight is movement in the bound\'s own terms');
  // Past the bound with no flight and no movement, the same hold expires: the queue's one stall
  // stands for the held heads, and the class counts the stall once, not a decision per head.
  const stalledAt = Date.parse(gy2053Settled) + owed.mergeWriterMotionBound(next) + 60_000, stalled = { ...next, inFlight: null };
  for (const work of works) assert.equal(owed.mergeWriterHolds(work, stalled, stalledAt), 'stalled', `${work.key}: no flight and the movement is past the bound`);
  assert.deepEqual(humanNeededAttention({ work: works, now: new Date(stalledAt).toISOString() }, stalled).map(line => line.subject), [], 'the stall stands for the held heads, not beside them');
  const stall = mergeWriterStallAttention(stalled, stalledAt)!;
  assert.match(stall.text, /queue holds 2 head\(s\) it cannot move/);
  assert.deepEqual(cycleFaults(emptyDaemonState(config()), works, stalledAt, { config: config(), reported: [stall] }).map(fault => `${fault.kind}|${fault.subject}`),
    ['stalled-step|merge-writer'], 'one line for the queue the writer cannot move');
  // The hold does not expire while a flight is alive, whatever the movement's age: the flight itself is the writer moving.
  const alive = { ...stalled, inFlight: next.inFlight };
  for (const work of works) assert.equal(owed.mergeWriterHolds(work, alive, stalledAt), 'moving', `${work.key}: the flight outlives any bound`);
  assert.equal(mergeWriterStallAttention(alive, stalledAt), null, 'no stall line stands beside a live flight');
  // The fault reader sees the same: a live flight whose newest movement aged past the bound (a timed-out
  // attempt's retry, which records nothing until it returns) still opens no owed decision, trial or push.
  const aliveRead = observedFaults([...works, front2053(new Date(now - 38 * 60_000).toISOString())], new Date(stalledAt).toISOString(), { ...alive, queue: [...alive.queue, writer2053(gy2053Pass).queue[0]!] });
  assert.ok(aliveRead.reported.length === 3 && aliveRead.reported.every(line => Date.parse(line.inMotionUntil!) > stalledAt), 'every held line stays in motion past this reading');
  assert.deepEqual(aliveRead.counted.map(fault => fault.kind), [], 'no owed-decision instance opens while the flight is alive');
});

test('manual:fault-class-decision — a merge-gate push refusal is held exactly like a trial refusal, and every push refusal the writer does not own still counts', () => {
  const now = Date.parse(gy2053Pass), writer = writer2053(gy2053Pass);
  // GY-2011 as the pass counted it: merge gate refused `merge writer has not pushed 66f37f2604f1` —
  // the writer's own next step, its queue held the head at the front and its flight was working it.
  const front = front2053(new Date(now - 38 * 60_000).toISOString());
  assert.equal(owed.mergeWriterHolds(front, writer, now), 'moving', 'the front head, in flight, is the writer\'s work');
  assert.equal(owed.mergeWriterHolds(pushRefused('GY-2004', new Date(now - 31 * 60_000).toISOString(), gy2053Heads), writer, now), 'moving', 'a queued head\'s push refusal waits for the writer too');
  assert.deepEqual(observedFaults([front], gy2053Pass, writer).counted.map(fault => fault.kind), [], 'the held push refusal opens nothing');
  assert.ok(Date.parse(observedFaults([front], gy2053Pass, writer).reported[0]!.inMotionUntil!) > now, 'the push refusal is bounded like the trial refusal beside it');
  // A push refusal whose head is in neither the queue nor the flight is a genuine unanswered decision.
  const unheld = { ...writer, queue: writer.queue.slice(1), inFlight: null };
  assert.equal(owed.mergeWriterHolds(front, unheld, now), null, 'a head the queue does not hold is nobody\'s motion');
  const unheldRead = observedFaults([front], gy2053Pass, unheld);
  assert.equal(unheldRead.reported[0]!.inMotionUntil, undefined, 'no bound rides a line nobody\'s motion defers');
  assert.deepEqual(unheldRead.counted.map(fault => fault.kind), ['owed-decision']);
  // A merge-gate refusal that is not the writer's push refusal is never held either: GitHub's own
  // `not observed` refusal is a gate nobody is working, writer moving or not; and without the writer
  // summary — an older caller, or a status read before the writer ran — every push refusal stands as before.
  const unobserved = pushRefused('GY-2004', new Date(now - 31 * 60_000).toISOString(), gy2053Heads);
  const action = unobserved.nextAction as NextAction;
  Object.assign(unobserved, { nextAction: { ...action, refusal: githubUnobservedRefusal, inputs: { ...action.inputs, kind: 'escalate', trigger: 'merge', detail: githubUnobservedRefusal } } });
  Object.assign(unobserved.actionQueue!.actions[0], { refusal: githubUnobservedRefusal });
  assert.equal(owed.mergeWriterHolds(unobserved, writer, now), null, 'only the exact push refusal is the writer\'s next step');
  assert.deepEqual(observedFaults([unobserved], gy2053Pass, writer).counted.map(fault => fault.kind), ['owed-decision']);
  assert.equal(owed.mergeWriterHolds(front, null, now), null);
  assert.deepEqual(observedFaults([front], gy2053Pass, null).counted.map(fault => fault.kind), ['owed-decision']);
});

test('manual:fault-class-decision — every ledger write a flight makes is attempt progress, and the movement it reports keeps the queue quiet', () => {
  const item = { key: 'GY-2011' }, head = gy2053Heads['GY-2011']!;
  // The steps one flight records, in the order the executor writes them: the intent, the trial's
  // no-verdict record (a timeout), the retrial's intent on the new tip, the push, the reconcile.
  const steps = [
    { kind: 'intent', head, baseTip: gy2053Base, mergeSha: 'd'.repeat(40), risk: 'low', at: gy2053Flight },
    { kind: 'trial', head, baseTip: gy2053Base, mergeSha: 'd'.repeat(40), outcome: 'timeout', phase: 'tests', reason: 'the trial outlived its bound', phases: {}, attempts: [], durationMs: 20 * 60_000 },
    { kind: 'intent', head, baseTip: 'f'.repeat(40), mergeSha: '9'.repeat(40), risk: 'low', at: gy2053Pass },
    { kind: 'pushed', mergeSha: '9'.repeat(40), pushedAt: gy2053Pass },
    { kind: 'reconciled', mergeSha: '9'.repeat(40), observedTip: gy2053Base },
  ] as const;
  const words = [/recorded its merge intent on base tip c26cd7bcac37/, /recorded its trial \(timeout\)/, /recorded its merge intent/, /was recorded pushed/, /was reconciled: the base holds it/];
  let at = Date.parse(gy2053Flight);
  for (let index = 0; index < steps.length; index++) {
    at += 60_000;
    const stepAt = new Date(at).toISOString();
    const writer = writer2053(stepAt, { progress: { at: stepAt, what: mergeWriterModule.attemptProgressLine(item, steps[index] as never) } });
    assert.equal(mergeWriterMovement(writer)!.at, at, `${steps[index]!.kind}: the newest attempt step is the newest movement`);
    assert.match(mergeWriterMovement(writer)!.what, words[index]!, `${steps[index]!.kind}: named in the reader's words`);
    // A flight alive with fresh progress holds every queued head, however long the flight has run in all.
    assert.deepEqual(observedFaults(queued2053(new Date(at - 39 * 60_000).toISOString()), stepAt, writer).counted.map(fault => fault.kind), [],
      `${steps[index]!.kind}: no owed line stands beside a live flight`);
    assert.equal(mergeWriterStallAttention(writer, at), null, `${steps[index]!.kind}: the stall waits for a writer with no attempt alive`);
  }
});

test('integration:owed-decision-writer-flight-replay — the 09:32:04Z shape stays quiet across a full serial queue drain', () => {
  const state = emptyDaemonState(config()), bound = mergeWriterModule.mergeWriterFlightBoundMs({ intervalSeconds: 20 });
  const decided = (at: string, works: Work[], writer: MergeWriterSummary) => {
    const { reported, counted } = observedFaults(works, at, writer);
    trackFaults(state.faults, counted, at);
    return { reported, counted };
  };
  let queue = writer2053(gy2053Pass).queue, cursor = Date.parse(gy2053Settled);
  // The drain: each flight settles, the writer starts the next head the same cycle, and every
  // observation between — retrial after retrial, the queue emptying — stays quiet in the class.
  for (const key of Object.keys(gy2053Heads)) {
    const head = gy2053Heads[key]!, failed = key === 'GY-2011', settleAt = cursor + (failed ? Date.parse(gy2053Settled) - Date.parse(gy2053Flight) : 21 * 60_000);
    const settleIso = new Date(settleAt).toISOString(), remaining = queue.slice(1), next = remaining[0] ?? null;
    const writer: MergeWriterSummary = { queue: remaining,
      inFlight: next ? { key: next.key, id: next.id, head: next.head, startedAt: settleIso } : null,
      lastMergeAt: settleIso,
      refusals: [{ key, head: head.toLowerCase(), reason: failed ? 'trial failed: tests tests/item-page-structure.test.ts' : 'base moved 3 times', at: settleIso }],
      reworks: failed ? [{ key, id: `work-${key}`, head: head.toLowerCase(), reason: 'trial failed: tests tests/item-page-structure.test.ts', refusedAt: settleIso, attempts: 1, lastError: null }] : [],
      progress: { at: settleIso, what: mergeWriterModule.attemptProgressLine({ key }, failed
        ? { kind: 'refused', head, reason: 'trial failed: tests tests/item-page-structure.test.ts' } as never
        : { kind: 'reconciled', mergeSha: '9'.repeat(40), observedTip: gy2053Base } as never) },
      motionBoundMs: bound };
    const works = queued2053(new Date(Date.parse(gy2053Pass) - 38 * 60_000).toISOString()).filter(item => remaining.some(entry => entry.key === item.key));
    assert.deepEqual(decided(settleIso, works, writer).counted.map(fault => fault.kind), [], `${key} settled: the writer's next flight is movement, and nothing is owed`);
    for (let step = 1; step <= 3; step++) {
      const at = settleAt + step * 5 * 60_000;
      const retried: MergeWriterSummary = { ...writer, progress: { at: new Date(at).toISOString(), what: mergeWriterModule.attemptProgressLine({ key: next?.key ?? key }, { kind: 'intent', head: next?.head ?? head, baseTip: gy2053Base, mergeSha: 'd'.repeat(40), risk: 'low', at: new Date(at).toISOString() } as never) } };
      assert.deepEqual(decided(new Date(at).toISOString(), works, retried).counted.map(fault => fault.kind), [], `${key}'s flight, +${step * 5}m: the retrial's intent is movement`);
    }
    queue = remaining; cursor = settleAt;
  }
  assert.deepEqual(queue, [], 'the serial queue drained, one head at a time');
  // The whole replay filed not one decision instance: the writer's own flight was never a judgment.
  assert.deepEqual(state.faults.instances.filter(instance => instance.faultClass === 'decision'), []);
});
