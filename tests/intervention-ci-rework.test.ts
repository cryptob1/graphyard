import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';
import { computeInterventionReport, foldInterventions, type InterventionLedgerRow } from '../src/interventions.js';
import { interventionPolicyDefaults } from '../src/model/interventions.js';
import { failedCheckRework, situatedInput } from '../src/daemon/decisions.js';
import { humanNeeded } from '../src/model/concerns.js';
import type { NextAction } from '../src/model/action-kinds.js';

// GY-1387 names this file for its proof: manual:intervention-pattern-rework-test. Between
// 2026-09-30 and 2026-10-07 the report counted 430 rework interventions at the test stage, 375 of
// them the loop's own round for a required check that failed on the head (`failedCheckRework`),
// requested by the loop and applied by the risk lane or its approver. Nobody stepped in: CI found a
// defect and the control plane returned the head to a worker by itself. The fold now reads such a
// rework as the product working, as it reads a scope widening the loop approved; a rework a master
// asks for by hand still counts, whatever its grounds.

const H = 'a'.repeat(40), B = 'b'.repeat(40), OLD = 'c'.repeat(40);
const now = '2026-10-07T03:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse('2026-10-06T12:00:00.000Z') + minutes * 60_000).toISOString();
const item = (n: number, stage: Work['stage'] = 'build'): Work => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, key: `GY-${n}`, title: `Item ${n}`, stage,
  policy: { checks: ['test', 'typecheck'], review: true }, submission: { epoch: 1, pr: n, sha: H }, candidate: { sha: H, baseSha: B, pr: n }, reworkRequested: false,
  gates: [{ name: 'test', passed: false, reasons: [], ciAppIds: [15368] }],
  observation: { at: at(0), candidate: { sha: H, baseSha: B, pr: n }, merged: false, prState: 'open', checks: [{ name: 'test', result: 'failure', appId: 15368, id: 5 }, { name: 'typecheck', result: 'success', appId: 15368 }] } } as unknown as Work);

/** The input the loop sends for the rework a failed required check calls for: the production binding. */
function loopInput(work: Work) {
  const ci = failedCheckRework(work);
  assert.ok(ci, 'the failed required check calls for the loop\'s rework');
  return situatedInput({ action: 'rework', binding: ci.binding, input: { previousWorkerStopped: true } as any });
}
let seq = 0;
/** A decision requested at the test stage and, unless `open`, the rework that applied it. */
function rows(work: Work, input: unknown, options: { open?: boolean; sent?: string } = {}): InterventionLedgerRow[] {
  const id = `${work.id.slice(0, 30)}${String(++seq).padStart(6, '0')}`;
  const document = { key: work.key, stage: 'test', title: work.title, epoch: 1, candidate: { sha: options.sent ?? H, pr: work.candidate!.pr } };
  const requested: InterventionLedgerRow = { seq: ++seq, workId: work.id, actor: 'graphyard-master-graphyard-operator', kind: 'decision.requested', at: at(seq), details: {}, payload: { id, action: 'rework', input }, stageBefore: 'test', work: null };
  if (options.open) return [requested];
  return [requested, { seq: ++seq, workId: work.id, actor: 'graphyard-master-graphyard-operator', kind: 'rework', at: at(seq), details: { reason: 'returned to a worker' }, stageBefore: 'test', work: { ...document, stage: 'build' } }];
}

test('unit:intervention-ci-rework — the loop\'s own rework for a required check that failed on the head is no intervention; a hand rework, or one whose binding names another head, still is', () => {
  const loop = item(1), hand = item(2), stale = item(3), held = item(4, 'test'), sent = item(5);
  const folded = foldInterventions([
    ...rows(loop, loopInput(loop)),
    ...rows(hand, { previousWorkerStopped: true }),
    ...rows(stale, { previousWorkerStopped: true, binding: `${OLD}:ci:test` }),
    ...rows(held, loopInput(held), { open: true }),
    // The binding names the failed head, but the rework sent back another: it was not the loop's round for that head.
    ...rows(sent, loopInput(sent), { sent: OLD }),
  ], [loop, hand, stale, held, sent], now);
  const reworks = folded.interventions.filter(entry => entry.kind === 'rework');
  assert.deepEqual(reworks.map(entry => entry.work?.key).sort(), ['GY-2', 'GY-3', 'GY-5']);
  assert.ok(reworks.every(entry => entry.stage === 'test' && entry.resolvedAt !== null), 'only applied hand reworks are counted, at the test stage');
  assert.ok(!folded.interventions.some(entry => entry.work?.key === 'GY-4'), 'the loop\'s requested CI rework is not reported as waiting on anybody');
});

test('unit:intervention-ci-rework-pattern — a week of the loop\'s failed-check reworks crosses no rework pattern at the test stage', () => {
  const work = Array.from({ length: 40 }, (_, index) => item(100 + index));
  const folded = foldInterventions(work.flatMap(entry => [...rows(entry, loopInput(entry)), ...rows(entry, loopInput(entry))]), work, now);
  const report = computeInterventionReport(folded, work, interventionPolicyDefaults, { days: 7, now });
  assert.equal(report.total, 0);
  assert.ok(!report.patterns.some(pattern => pattern.kind === 'rework' && pattern.stage === 'test' && pattern.crossed));
  // The same week asked for by hand is what the pattern exists to catch.
  const byHand = foldInterventions(work.flatMap(entry => rows(entry, { previousWorkerStopped: true })), work, now);
  assert.ok(computeInterventionReport(byHand, work, interventionPolicyDefaults, { days: 7, now }).patterns.some(pattern => pattern.kind === 'rework' && pattern.stage === 'test' && pattern.crossed));
});

test('unit:intervention-ci-rework-owed — the owed line for a failed required check tells the master the loop requests the rework, with the hand command only as a fallback', () => {
  const action = (gate: string): NextAction => ({ kind: 'request-rework', work: 'w', key: 'GY-9', gate, refusal: null, reason: 'GY-9 needs a new head', inputs: { kind: 'request-rework' } as any, llmRole: 'approve-decision', binding: 'b' });
  const failed = humanNeeded(action('test'))!, review = humanNeeded(action('review'))!;
  assert.equal(failed.decision, review.decision, 'the owed decision the rework guard reads is unchanged');
  assert.match(failed.resolve, /^the loop requests this rework for the failed required check itself and supervises its approver; only once it is still owed past 30 minutes: graphyard master decide GY-9 rework REASON/);
  assert.match(review.resolve, /^graphyard master decide GY-9 rework REASON, then graphyard master approver GY-9 DECISION$/);
});
