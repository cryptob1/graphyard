import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActionRow } from '../src/model/actions.js';
import type { Work } from '../src/model.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { openThroughputOwner, populationRule, recordThroughputMeasurement, throughputClaimVisibility, throughputOwnerItem, throughputStall, throughputStallBound, verifyThroughput, type ThroughputReport } from '../src/throughput.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// Time-bomb allowance (GY-1694): the 2026-10-07 base is past and every measurement takes an explicit now/clock; the Date.now() cycles drive a stubbed measureThroughput, so no fixture instant meets the wall clock.

// GY-1465: the throughput needs-decision applies the population rule settled by requirements
// revision 48a9e55a (superseded control-plane actions are loop machinery of record), and while one
// stands with no open owner the loop files the owner within its cycle, so it is never masterless.
const minute = 60_000;
const base = Date.parse('2026-10-07T12:00:00.000Z');
const at = (minutes: number) => new Date(base + minutes * minute).toISOString();
const now = base + 120 * minute;
const sha = (seed: string) => seed.repeat(40).slice(0, 40);
const revision = sha('e');
const deployed = { revision, version: '1', origin: 'https://example.invalid', observedAt: at(0), containsClaim: true, reason: null };
const controlPlaneKinds = ['escalate', 'request-rework', 'resync', 'request-review', 'dispatch', 'approve-scope', 'reclaim', 'merge'];
/** The words a binary predating the settled rule recorded for a superseded row (the 15:30 measurement's family). */
const preRuleExclusion = (kind: string) => `its ${kind} action was superseded before any executor ran it (now needs another action), so something outside the queue moved the item on`;
const preRule = 'A delivery is counted when it is a merged pull request of this repository with a recorded submission, at most one rework round, at least one action an executor claimed and completed, and no trace of a coordinator on it: no action superseded before an executor ran it, no coordination session recorded, no blocked report and no requirements revision while it was under way. Every delivery the window holds is listed either way, with its own figures and, when it is excluded, the reason.';

function row(kind: string, history: ActionRow['history']): ActionRow {
  return { id: `${kind}-${history[0]!.at}`, kind, work: 'w', key: 'GY-1', inputs: { kind }, gate: 'build', refusal: null, reason: '', binding: `${kind}:0`,
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
function delivery(key: string, shape: { history?: ActionRow[]; blocked?: number } = {}): Work {
  return {
    id: key.toLowerCase(), key, title: `Delivery ${key}`, stage: 'done', gates: [], violations: [], policy: { checks: [], review: true }, implementers: ['worker-1'], workspaces: [], sessions: [],
    submission: { pr: Number(key.split('-')[1]) }, candidate: null, updatedAt: at(40),
    delivery: { mergeSha: sha('a'), mergedAt: at(30) },
    pipeline: { attempts: [{ epoch: 1, owner: 'worker-1', claimedAt: at(0), endedAt: at(10), end: 'submitted' }], submittedAt: at(10), reworkRounds: 0,
      interventions: { blocked: shape.blocked ?? 0, requirements: 0 }, backfill: null },
    actionQueue: { actions: [], history: shape.history ?? [executed('request-review', 11)] },
  } as unknown as Work;
}
/** A window past the stall bound whose every delivery carries only the superseded control-plane family. */
const supersededWindow = () => Array.from({ length: throughputStallBound }, (_, index) =>
  delivery(`GY-${400 + index}`, { history: [executed('request-review', 11), ...controlPlaneKinds.map((kind, offset) => superseded(kind, 12 + offset))] }));
/** A window every delivery of which a blocked report handed to a master: a stall under the settled rule. */
const blockedWindow = () => Array.from({ length: throughputStallBound }, (_, index) => delivery(`GY-${500 + index}`, { blocked: 1 }));
/** The owner's settled criterion, imported dynamically so the proof runs (and fails as a case) on a tree without it. */
const ownerCriterion = async () => ((await import('../src/throughput.js')) as { throughputOwnerCriterion?: string }).throughputOwnerCriterion;
const settledFamily = /superseded control-plane actions \(dispatch, escalate, rework, resync, review, merge, approve-scope, reclaim\) are the loop machinery of record and do not exclude a delivery/;
const measure = (work: Work[]) => verifyThroughput(work, now, { deployed, since: at(-60) });
/** The report a binary predating the rule wrote over the superseded window: every delivery excluded, for that family alone. */
function preRuleReport(rule: string): ThroughputReport {
  const report = measure(supersededWindow());
  const excluded = report.deliveries.map(record => ({ ...record, admitted: false, exclusions: controlPlaneKinds.map(preRuleExclusion) }));
  return { ...report, verdict: 'unverified', deliveries: excluded, excluded, population: { ...report.population, rule, admitted: 0, excluded: excluded.length } };
}

test('unit:throughput-rule-settled-superseded-actions — a delivery set excluded solely on control-plane actions superseded before an executor ran them is judged under the settled rule: 0 exclusions, every delivery admitted, no needs-decision, even over a report whose binary still named that family', () => {
  const report = measure(supersededWindow());
  assert.equal(report.population.rule, populationRule);
  assert.equal(report.population.delivered, throughputStallBound);
  assert.equal(report.population.excluded, 0, 'the superseded family excludes nothing');
  assert.equal(report.excluded.length, 0);
  for (const record of report.deliveries) {
    assert.equal(record.admitted, true);
    assert.deepEqual(record.exclusions, []);
    assert.equal(record.actions.filter(action => action.supersededUnexecuted).length, controlPlaneKinds.length, 'each kind really was superseded unexecuted');
  }
  assert.equal(report.population.admitted, throughputStallBound);
  assert.equal(throughputStall(report), null);

  // A report recorded by a binary that predates the rule — whatever rule string it carries — is
  // re-judged under the settled one: a delivery whose only exclusions are that family is no
  // coordinator's trace, so the window can accumulate and no needs-decision stands on it.
  for (const rule of [preRule, populationRule]) assert.equal(throughputStall(preRuleReport(rule)), null, `no stall under ${rule === populationRule ? 'the settled' : 'the pre-revision'} rule string`);
  // A delivery a master did drive stays excluded, and the settled re-judging never names the superseded family as a reason.
  const blocked = measure(blockedWindow());
  const mixed = { ...blocked, excluded: blocked.excluded.map(record => ({ ...record, exclusions: [...record.exclusions, preRuleExclusion('escalate')] })) };
  const stall = throughputStall(mixed)!;
  assert.ok(stall, 'a coordinator fingerprint beside the family still stalls');
  assert.deepEqual(stall.reasons, [{ reason: 'a blocked report handed it to a master or operator to clear', deliveries: throughputStallBound, coordinator: true }]);
  assert.doesNotMatch(stall.finding, /superseded before any executor ran it(?! and an approver)/, 'the family is not counted as an exclusion');
});

test('integration:throughput-attention-settled-rule — master status raises no needs-decision attention over a measurement whose only exclusions are the superseded control-plane family, and none over the pre-revision measurement that excluded them', () => {
  const file = '.graphyard/measurements/throughput/t.json', serving = { revision, version: '1' };
  // Under the settled rule the window verifies: the attention retires.
  const verified = throughputClaimVisibility({ report: measure(supersededWindow()), file }, serving, throughputStallBound, null, null);
  assert.equal(verified.verdict, 'verified');
  assert.equal(verified.stall, null);
  assert.equal(verified.attention, null, 'no attention at all');
  // A pre-revision measurement of the serving release (the 15:30 record: 0 admitted, excluded on the family alone) asks no decision either.
  for (const rule of [preRule, populationRule]) {
    const standing = throughputClaimVisibility({ report: preRuleReport(rule), file }, serving, throughputStallBound, null, null);
    assert.equal(standing.stall, null);
    assert.ok(standing.attention, 'still unverified until re-measured');
    assert.doesNotMatch(standing.attention!.text, /needs decision/);
    assert.equal(standing.attention!.approvedBy ?? null, null, 'not the decide-then-approver path');
    assert.doesNotMatch(standing.attention!.next, /master decide/);
  }
  // Where a master really drove every delivery the needs-decision stands, but judged under the
  // settled rule: the family a pre-revision binary recorded beside the fingerprint is not quoted as an exclusion.
  const blocked = measure(blockedWindow());
  const mixed = { ...blocked, excluded: blocked.excluded.map(record => ({ ...record, exclusions: [...record.exclusions, ...controlPlaneKinds.map(preRuleExclusion)] })) };
  const decision = throughputClaimVisibility({ report: mixed, file }, serving, throughputStallBound, null, { key: 'GY-7310' });
  assert.match(decision.attention!.text, new RegExp(`needs decision on GY-7310: .*Exclusions: ${throughputStallBound} × a blocked report handed it to a master or operator to clear\\. Population rule`));
  assert.doesNotMatch(decision.attention!.text, /× its \S+ action was superseded/, 'no superseded control-plane action is counted as an exclusion');
});

test('unit:throughput-attention-names-owner — the needs-decision attention names the open owner item as the GY-N its decide-then-approver path acts on, and the owner item carries the settled AC-1', async () => {
  const file = '.graphyard/measurements/throughput/t.json', serving = { revision, version: '1' }, report = measure(blockedWindow());
  const owned = throughputClaimVisibility({ report, file }, serving, throughputStallBound, null, { key: 'GY-7300' });
  assert.equal(owned.stall!.owner, 'GY-7300');
  assert.match(owned.attention!.text, /needs decision on GY-7300: session-free deliveries cannot accumulate/);
  assert.equal(owned.attention!.role, 'master'); assert.equal(owned.attention!.approvedBy, 'approver');
  assert.match(owned.attention!.next, /graphyard master decide GY-7300 requirements .* graphyard master approver GY-7300 DECISION$/, 'the ask names no loop closure: the owner stays as it is (GY-2186)');
  assert.doesNotMatch(owned.attention!.next, /GY-N\b/);
  const masterless = throughputClaimVisibility({ report, file }, serving, throughputStallBound, null, null);
  assert.match(masterless.attention!.text, /needs decision on the item that owns the verification \(the loop files it\)/);
  assert.match(masterless.attention!.next, /master decide GY-N requirements/);
  // Between measurements the line promises the owner within one cycle while a needs-decision stands.
  const progress = throughputClaimVisibility(null, serving, 3, null, null);
  assert.match(progress.attention!.text, /No open item owns the verification \(the loop files none, GY-2186\)/);
  // The owner the loop files for that path carries the settled AC-1 with its manual proof.
  const criterion = await ownerCriterion();
  assert.match(criterion ?? '', settledFamily);
  // Like the settled rule, an approver's coordination session never excludes; one recording no role does.
  assert.match(populationRule, /an approver session never exclude/);
  assert.match(criterion ?? '', /no coordination session other than an approver's recorded on it \(one recording no role excludes\)/);
  assert.deepEqual(throughputOwnerItem(revision, 0).criteria, [{ id: 'AC-1', text: criterion, proofs: ['manual:throughput-claim-verified'] }]);

  // GY-1630: where the loop holds the decision effects it requests the decision itself, so the
  // attention names the loop as the stall decision's agent-owner, never a master session to hand-drive it.
  const loopOwned = throughputClaimVisibility({ report, file }, serving, throughputStallBound, null, { key: 'GY-7300' }, null, null, true);
  assert.equal(loopOwned.attention!.role, 'control plane'); assert.equal(loopOwned.attention!.approvedBy, 'approver');
  assert.match(loopOwned.attention!.next, /^The loop requests the requirements decision on GY-7300 itself and routes it to the independent approver/);
  assert.doesNotMatch(loopOwned.attention!.next, /graphyard master (decide|approver)/);
  assert.match(populationRule, /an approver session never exclude/);
});
