import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { containmentInMotion, containmentSettleWaitBoundMs, cycleFaults, emptyDaemonState, reworkDecisionInMotion, reworkDecisionWaitBoundMs } from '../src/master-daemon.js';
// GY-1337's own exports are read through namespaces, so the base exercise runs these replays and each fails on its assertion.
import * as daemon from '../src/master-daemon.js';
import * as decisionReport from '../src/cli/decision-report.js';
import { terminalDecisions } from '../src/cli/decision-report.js';
import { containmentGraceMs } from '../src/model/containment.js';
import { maxApproverLaunches } from '../src/daemon/decisions.js';
// GY-1346's bound is read through the namespace too, so the base exercise loads this file and its replays fail on their assertions.
import * as decisions from '../src/daemon/decisions.js';
import { humanNeededAttention } from '../src/cli/owed-report.js';
import { readDecisions } from '../src/server/decision-ledger.js';
import { humanNeeded, type NextAction } from '../src/model/next-action.js';

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
