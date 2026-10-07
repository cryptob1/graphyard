import assert from 'node:assert/strict';
import test from 'node:test';
import { actionIdleMs, type ActionRow } from '../src/model/actions.js';
import type { Work } from '../src/model.js';
import { deliveryRecord, exclusionClass, populationRule, throughputClaim, throughputStall, throughputStallBound, verifyThroughput } from '../src/throughput.js';

// GY-1455: the measurement applies the admission rule the approvers settled (GY-1449 revision
// 48a9e55a, GY-1454 AC-1), built here from plain documents so every shape is visible at a glance.
const minute = 60_000;
const base = Date.parse('2026-10-07T12:00:00.000Z');
const at = (minutes: number) => new Date(base + minutes * minute).toISOString();
const now = base + 120 * minute;
const sha = (seed: string) => seed.repeat(40).slice(0, 40);
const controlPlaneKinds = ['escalate', 'request-rework', 'resync', 'request-review', 'dispatch', 'approve-scope', 'reclaim', 'merge'];

function row(kind: string, history: ActionRow['history']): ActionRow {
  return { id: `${kind}-${history.length}-${history[0]!.at}`, kind, work: 'w', key: 'GY-1', inputs: { kind }, gate: 'build', refusal: null, reason: '', binding: `${kind}:0`,
    requestedBy: 'graphyard', requestedAt: history[0]!.at, state: 'done', claim: null, attempts: 1, resolvedAt: history.at(-1)!.at, result: 'done', resolution: 'settled', history } as unknown as ActionRow;
}
const executed = (kind: string, from: number) => row(kind, [
  { at: at(from), event: 'requested', requester: 'graphyard', executor: null, result: null, reason: '' },
  { at: at(from + 1), event: 'claimed', requester: 'graphyard', executor: 'executor-a', result: null, reason: 'attempt 1 claimed by executor-a on host-a' },
  { at: at(from + 2), event: 'completed', requester: 'graphyard', executor: 'executor-a', result: 'done', reason: '' },
]);
const superseded = (kind: string, from: number) => row(kind, [
  { at: at(from), event: 'requested', requester: 'graphyard', executor: null, result: null, reason: '' },
  { at: at(from + 1), event: 'cancelled', requester: 'graphyard', executor: null, result: null, reason: 'now needs another action' },
]);
const session = (id: string, role: string | null) => ({ id, kind: 'coordination', role, principal: id, epoch: null, runtime: 'claude', host: 'host-m', workspace: null, tab: null, pane: null,
  agentName: null, head: null, attach: null, transcript: null, startedAt: at(5) });

function delivery(key: string, shape: { history?: ActionRow[]; sessions?: unknown[]; blocked?: number; requirements?: number; reworkRounds?: number } = {}): Work {
  return {
    id: key.toLowerCase(), key, stage: 'done', implementers: ['worker-1'], workspaces: [], sessions: shape.sessions ?? [],
    submission: { pr: Number(key.split('-')[1]) }, candidate: null, updatedAt: at(40),
    delivery: { mergeSha: sha('a'), mergedAt: at(30) },
    pipeline: { attempts: [{ epoch: 1, owner: 'worker-1', claimedAt: at(0), endedAt: at(10), end: 'submitted' }], submittedAt: at(10), reworkRounds: shape.reworkRounds ?? 0,
      interventions: { blocked: shape.blocked ?? 0, requirements: shape.requirements ?? 0 }, backfill: null },
    actionQueue: { actions: [], history: shape.history ?? [executed('request-review', 11)] },
  } as unknown as Work;
}

/** One delivery of each shape AC-1 names, with whether it is admitted and the exclusion classes it carries. */
function shapes() {
  return {
    plain: delivery('GY-1'),
    supersededControlPlane: delivery('GY-2', { history: [executed('request-review', 11), ...controlPlaneKinds.map((kind, index) => superseded(kind, 12 + index))] }),
    approverSession: delivery('GY-3', { sessions: [session('approver:GY-3', 'approver')] }),
    masterSession: delivery('GY-4', { sessions: [session('master-1', 'master')] }),
    operatorSession: delivery('GY-5', { sessions: [session('operator-1', 'operator')] }),
    rolelessSession: delivery('GY-6', { sessions: [session('coordinator-1', null)] }),
    blocked: delivery('GY-7', { blocked: 1 }),
    requirements: delivery('GY-8', { requirements: 1 }),
    reworked: delivery('GY-9', { reworkRounds: 2 }),
    unexecuted: delivery('GY-10', { history: [superseded('dispatch', 11)] }),
  };
}

test('unit:throughput-admission-rule — control-plane actions superseded before any executor ran them and approver sessions admit a delivery; master, operator or role-less sessions, blocked reports, requirements revisions, extra rework rounds and no executed action still exclude it, each with its reason; the GY-87 budgets are unchanged', () => {
  const records = Object.fromEntries(Object.entries(shapes()).map(([name, work]) => [name, deliveryRecord(work, now)]));
  const classes = (name: string) => records[name]!.exclusions.map(entry => exclusionClass(entry).reason);

  for (const name of ['plain', 'supersededControlPlane', 'approverSession']) {
    assert.equal(records[name]!.admitted, true, `${name} is admitted: ${records[name]!.exclusions.join('; ')}`);
    assert.deepEqual(records[name]!.exclusions, []);
  }
  assert.equal(records.supersededControlPlane!.actions.filter(action => action.supersededUnexecuted).length, controlPlaneKinds.length, 'every control-plane kind really was superseded unexecuted');

  const session = 'a coordination session other than an approver\'s was recorded on it';
  assert.deepEqual(classes('masterSession'), [session]);
  assert.match(records.masterSession!.exclusions[0]!, /^a master coordination session \(master-1 on host-m\) was recorded on it$/);
  assert.deepEqual(classes('operatorSession'), [session]);
  assert.match(records.operatorSession!.exclusions[0]!, /^an operator coordination session \(operator-1 on host-m\) was recorded on it$/);
  assert.deepEqual(classes('rolelessSession'), [session]);
  assert.match(records.rolelessSession!.exclusions[0]!, /\(coordinator-1 on host-m, no role recorded\)/);
  assert.deepEqual(classes('blocked'), ['a blocked report handed it to a master or operator to clear']);
  assert.deepEqual(classes('requirements'), ['a requirements revision was applied to it while it was under way']);
  assert.deepEqual(classes('reworked'), ['it took N rework rounds, so it is not one of the routine deliveries the claim is stated over']);
  assert.deepEqual(classes('unexecuted'), ['no executor completed an action on it, so it is no evidence about an executor-driven pipeline']);
  for (const name of ['masterSession', 'operatorSession', 'rolelessSession', 'blocked', 'requirements', 'reworked', 'unexecuted']) assert.equal(records[name]!.admitted, false, name);

  // The budgets are GY-87's own and this change leaves them exactly as stated.
  assert.equal(throughputClaim.submitToMergeP50Ms, 30 * minute);
  assert.equal(throughputClaim.idleActionableMs, actionIdleMs);
  assert.equal(actionIdleMs, 5 * minute);
  assert.equal(throughputClaim.minimumDeliveries, 10);
});

test('unit:throughput-rule-stated — populationRule names every exclusion class the measurement can emit, states that superseded control-plane actions and approver sessions do not exclude, and no superseded-action class is emitted as a coordinator fingerprint', () => {
  // Where each emittable class is named as an exclusion in the rule. A new class the measurement
  // emits without a line here fails below, so the rule cannot drift from the code again.
  const named: Record<string, string> = {
    'the item is not delivered': 'merged pull request of this repository (delivered',
    'its delivery records no merge commit': 'a merge commit',
    'no pull request number is recorded for it': 'a pull request number',
    'its key gy-N is not a work-item key of this repository': 'a work-item key',
    'no worker ever held it, so nothing implemented it': 'a worker that held it',
    'its timeline records no submission': 'a recorded submission',
    'it took N rework rounds, so it is not one of the routine deliveries the claim is stated over': 'at most one rework round',
    'no executor completed an action on it, so it is no evidence about an executor-driven pipeline': 'at least one action an executor claimed and completed',
    'a coordination session other than an approver\'s was recorded on it': 'excluded for a coordination session whose role is master, operator or anything but approver (or that records no role)',
    'a blocked report handed it to a master or operator to clear': 'a blocked report',
    'a requirements revision was applied to it while it was under way': 'a requirements revision applied while it was under way',
  };
  const unreal = { ...delivery('GY-11', { history: [] }), stage: 'build', delivery: null, submission: null, key: 'gy-11', implementers: [], pipeline: null } as unknown as Work;
  const missingCommit = { ...delivery('GY-12'), delivery: { mergeSha: 'pending', mergedAt: at(30) } } as unknown as Work;
  const emitted = new Map<string, boolean>();
  for (const work of [...Object.values(shapes()), unreal, missingCommit])
    for (const entry of deliveryRecord(work, now).exclusions) { const kind = exclusionClass(entry); emitted.set(kind.reason, kind.coordinator); }

  assert.deepEqual([...emitted.keys()].sort(), Object.keys(named).sort(), 'every class the measurement emits is listed, and every listed class is emitted');
  for (const [reason, phrase] of Object.entries(named)) assert.ok(populationRule.includes(phrase), `populationRule names "${reason}" as an exclusion (${phrase})`);
  assert.ok(![...emitted.keys()].some(reason => /superseded/.test(reason)), 'no superseded-action class is emitted');
  assert.deepEqual([...emitted].filter(([, coordinator]) => coordinator).map(([reason]) => reason).sort(), [
    'a blocked report handed it to a master or operator to clear',
    'a coordination session other than an approver\'s was recorded on it',
    'a requirements revision was applied to it while it was under way',
  ]);
  // The rule says what does not exclude, in the words of the approved revision.
  assert.match(populationRule, /a control-plane action \(escalate, request-rework, resync, request-review, dispatch, approve-scope, reclaim, merge\) superseded before any executor ran it and an approver session never exclude it/);
  // The admission rule is one sentence; the second says how the window is reported.
  assert.equal(populationRule.split(/(?<=\.) /).length, 2);

  // The needs-decision the loop raises over a window that cannot admit quotes the rule it applied.
  const masters = Array.from({ length: throughputStallBound }, (_, index) => delivery(`GY-${100 + index}`, { sessions: [session(`master-${index}`, 'master')] }));
  const report = verifyThroughput(masters, now, { deployed: { revision: sha('b'), version: '1', origin: 'https://example.invalid', observedAt: at(0), containsClaim: true, reason: null }, since: at(-60) });
  const stall = throughputStall(report)!;
  assert.equal(report.population.rule, populationRule);
  assert.ok(stall.text.includes(populationRule), 'the needs-decision quotes the rule');
});
