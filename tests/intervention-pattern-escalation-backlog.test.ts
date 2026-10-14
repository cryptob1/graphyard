import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldInterventions, type InterventionLedgerRow } from '../src/interventions.js';
import { detectPatterns } from '../src/interventions/report.js';
import { interventionPolicyDefaults } from '../src/model/interventions.js';
import type { Work } from '../src/model.js';

// GY-1570 names this file for its proof: manual:intervention-pattern-escalation-backlog. Three
// escalation interventions were counted at the backlog stage between 2026-10-02 and 2026-10-09, each
// a requirement-weakening raised by applying a requirements decision the independent approver had
// approved:
//
//   - GY-1335 (raised#2319101, resolved#2320735) and GY-1338 (raised#2321095, resolved#2322297),
//     2026-10-06: applied before GY-1347/GY-1348 reached the host, so the escalation named no
//     decision and stood until the master put a second resolve decision to the approver (82 and 63
//     min). Removed at the source by GY-1347 (the engine stamps the escalation with the approved
//     decision that raised it) and GY-1348 (that approval resolves it in its own flow), proven over
//     the real engine by unit:decision-requirements-approval-resolves-weakening.
//   - GY-1423 (raised#2350200, resolved#2350202), 2026-10-07: already the GY-1348 path, resolved by
//     the approval 62 ms after the application raised it. Nobody stepped in, but the fold still
//     counted every `escalation.resolved` row as an escalation intervention. The fold now reads one
//     whose resolving decision is the decision that raised it as the approval's audit line
//     (`approved-decision-weakening`, src/intervention-exemptions.ts).
//
// With all three on today's path, the backlog stage records no escalation intervention for them.

const approver = 'graphyard-approver-graphyard', master = 'graphyard-master-graphyard-operator';
const instances = [
  { key: 'GY-1423', at: '2026-10-07T05:57:26.104Z', resolvedAt: '2026-10-07T05:57:26.166Z', decision: '257a79cc-4f7d-441b-966c-72ad72c040bb', reason: 'Requirement revision retires AC-2, AC-3 and narrows proofs for no criterion', seq: 2350200 },
  { key: 'GY-1338', at: '2026-10-06T03:38:24.729Z', resolvedAt: '2026-10-06T04:41:52.885Z', decision: '1f7bbe0f-00cc-4258-b8e5-c06231ebd14f', reason: 'Requirement revision retires AC-1, AC-3, AC-4, AC-6 and narrows proofs for no criterion', seq: 2321095 },
  { key: 'GY-1335', at: '2026-10-06T02:07:25.037Z', resolvedAt: '2026-10-06T03:29:00.193Z', decision: 'ec973978-b52f-4e61-a5dd-5fc9afbcd144', reason: 'Requirement revision retires AC-1, AC-2, AC-5 and narrows proofs for no criterion', seq: 2319101 },
] as const;
const now = '2026-10-09T04:39:21.023Z';
const item = (key: string) => ({ id: `work-${key}`, key, title: key, stage: 'backlog', epoch: 0, blocker: null, scopeRequest: null, escalations: [], containmentQuarantine: null, humanRequest: null, candidate: null }) as unknown as Work;

/**
 * The rows the ledger holds for one instance: the requirements application that raised the
 * escalation, then its resolution. `stamped` is today's engine (GY-1347): the escalation names the
 * approved decision. `resolvedBy` is the decision whose approval resolved it — the same one on
 * today's path (GY-1348), a second resolve decision on the path GY-1335 and GY-1338 took.
 */
function rows(instance: typeof instances[number], options: { stamped: boolean; resolvedBy: string }): InterventionLedgerRow[] {
  const escalation = { trigger: 'requirement-weakening', reason: instance.reason, at: instance.at, actor: master, ...(options.stamped ? { decision: instance.decision } : {}) };
  const workId = `work-${instance.key}`;
  return [
    { seq: instance.seq, workId, actor: master, kind: 'requirements', at: instance.at, stageBefore: 'backlog', details: { reason: 'rescoped' }, work: { key: instance.key, stage: 'backlog', epoch: 0, blocker: null, escalations: [escalation] } },
    { seq: instance.seq + 2, workId, actor: master, kind: 'escalation.resolved', at: instance.resolvedAt, stageBefore: 'backlog',
      details: { trigger: 'requirement-weakening', escalation, resolvedBy: master, approvedBy: approver, decision: options.resolvedBy, sessionKind: 'ai', reason: `Raised by requirements decision ${options.resolvedBy}`, at: instance.resolvedAt } },
  ];
}
const work = instances.map(entry => item(entry.key));
const escalationsAtBacklog = (ledger: InterventionLedgerRow[]) => foldInterventions(ledger, work, now).interventions.filter(entry => entry.kind === 'escalation' && entry.stage === 'backlog');

test('manual:intervention-pattern-escalation-backlog — a requirement-weakening resolved by the approval of the decision that raised it is no escalation intervention, so the backlog stage stays under the threshold', () => {
  const ledger = instances.flatMap(entry => rows(entry, { stamped: true, resolvedBy: entry.decision }));
  assert.deepEqual(escalationsAtBacklog(ledger), []);
  const pattern = detectPatterns(foldInterventions(ledger, work, now).interventions, work, interventionPolicyDefaults, now).find(entry => entry.kind === 'escalation' && entry.stage === 'backlog');
  assert.ok(!pattern || pattern.count < interventionPolicyDefaults.threshold, `the backlog escalation rate is below ${interventionPolicyDefaults.threshold} per ${interventionPolicyDefaults.windowDays} days`);
});

test('manual:intervention-pattern-escalation-backlog — GY-1423 as the ledger recorded it: raised and resolved by decision 257a79cc in one approval, 62 ms apart, counts nothing', () => {
  assert.deepEqual(escalationsAtBacklog(rows(instances[0], { stamped: true, resolvedBy: instances[0].decision })), []);
});

test('manual:intervention-pattern-escalation-backlog — somebody stepping in still counts: a weakening no approved decision raised, or one a second decision resolved, is an escalation intervention', () => {
  // GY-1335 and GY-1338 as the ledger recorded them, before GY-1347 stamped the decision: a second resolve decision answered each.
  for (const instance of instances.slice(1)) {
    const counted = escalationsAtBacklog(rows(instance, { stamped: false, resolvedBy: 'second-resolve-decision' }));
    assert.deepEqual(counted.map(entry => [entry.work?.key, entry.trigger, entry.waitedMs]), [[instance.key, 'requirement-weakening', Date.parse(instance.resolvedAt) - Date.parse(instance.at)]], instance.key);
  }
  // Stamped, but resolved by a different decision than the one that raised it: somebody answered it.
  assert.equal(escalationsAtBacklog(rows(instances[1], { stamped: true, resolvedBy: 'another-decision' })).length, 1);
  // Still standing past the last row (the approval's resolve never ran): it waits on somebody.
  const standing = { ...item('GY-1338'), escalations: [{ trigger: 'requirement-weakening', reason: instances[1].reason, at: instances[1].at, actor: master, decision: instances[1].decision }] } as unknown as Work;
  const open = foldInterventions(rows(instances[1], { stamped: true, resolvedBy: instances[1].decision }).slice(0, 1), [standing], now).interventions.filter(entry => entry.kind === 'escalation');
  assert.equal(open.length, 1);
  assert.equal(open[0].resolvedAt, null);
});
