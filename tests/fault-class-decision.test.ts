import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { cycleFaults, emptyDaemonState, reworkDecisionInMotion, reworkDecisionWaitBoundMs } from '../src/master-daemon.js';
import { humanNeededAttention } from '../src/cli/owed-report.js';
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

test('manual:fault-class-decision — an owed escalation is not a rework round and counts at once', () => {
  const work = standing(instances[0], observedAt);
  const action: NextAction = { kind: 'escalate', work: work.id, key: work.key, gate: 'merge', refusal: 'lease lost', reason: `${work.key} lost its lease`,
    inputs: { kind: 'escalate', trigger: 'lease-loss', detail: 'lease lost' } as NextAction['inputs'], llmRole: null, binding: `escalate:${work.key}` };
  work.nextAction = { ...action, needsHuman: humanNeeded(action)! } as Work['nextAction'];
  (work.actionQueue!.actions[0] as { kind: string; binding: string }).kind = 'escalate';
  (work.actionQueue!.actions[0] as { kind: string; binding: string }).binding = action.binding;
  assert.equal(reworkDecisionInMotion(work, Date.parse(observedAt) + 60_000), false);
  assert.deepEqual(decisionFaults(work, new Date(Date.parse(observedAt) + 60_000).toISOString()).faults.map(fault => fault.kind), ['owed-decision']);
});
