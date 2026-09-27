import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Work } from '../src/model.js';
// @ts-expect-error Dependency-free report script.
import { attributeDeliveryRounds, classifyDeliveryReworkReason, deliveryWaitingTimeByCase, extractFlowFacts, parseArguments, render, classifyGY643ReworkReason } from '../scripts/delivery-causes.mjs';

// GY-879: delivery-flow causes classified from the events ledger. Tests are named for the proofs they produce —
// unit:rework-causes-classified (AC-1) and unit:wait-causes-classified (AC-2).

const id = (key: string) => `00000000-0000-4000-8000-${key.padStart(12, '0')}`;
const A = id('a00000000001'), B = id('b00000000001'), C = id('c00000000001'), D = id('d00000000001');
const submittedAt = '2026-09-26T08:00:00.000Z';
const deliveredItem = (id: string, key: string, rounds: number) => ({
  id, key, title: `Fixture ${key}`, description: '', type: 'feature', priority: 1, dependencies: [], plannedFiles: ['src/x.ts'],
  stage: 'done', createdAt: '2026-09-26T07:00:00.000Z', updatedAt: '2026-09-26T10:00:00.000Z', stageEnteredAt: '2026-09-26T10:00:00.000Z',
  epoch: rounds + 1, gates: [], violations: [], workspaces: [], sessions: [], policy: { checks: ['test', 'typecheck'], review: true },
  submission: { epoch: 1, pr: 400 },
  delivery: { pr: 400, mergeSha: key.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40), mergedAt: '2026-09-26T10:00:00.000Z', mergedAtRepository: '2026-09-26T10:00:00.000Z' },
  pipeline: { attempts: [], submittedAt, resubmittedAt: submittedAt, reworkRounds: rounds, interventions: { blocked: 0, requirements: 0 } },
});
const fixtureWork = [
  { ...deliveredItem(A, 'GY-901', 2), pipeline: { attempts: [], submittedAt: '2026-09-26T06:00:00.000Z', resubmittedAt: submittedAt, reworkRounds: 2, interventions: { blocked: 0, requirements: 0 } } },
  deliveredItem(B, 'GY-902', 2),
  deliveredItem(C, 'GY-903', 1),
  { ...deliveredItem(D, 'GY-904', 0), pipeline: { attempts: [], submittedAt: null, resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } } },
];

const row = (seq: number, workId: string, at: string, reason: string) => ({ seq: String(seq), work_id: workId, actor: 'graphyard-master', kind: 'rework', created_at: at, details: { reason, previousWorkerStopped: true } });

// Fixture rework events carrying real decision texts and markers for AC-1 causes
const fixtureReworkEvents = [
  // Pre-submission rows are not rounds
  row(10, A, '2026-09-26T05:30:00.000Z', 'GY-901: graphyard-reviewer[bot] requested changes on 1f0f369dd3.'),

  // GY-901 round 1: stale observation (marker: "older than two minutes")
  row(11, A, '2026-09-26T08:10:00.000Z', '[Decided from the GitHub observation taken at 2026-09-26T08:09:00.000Z.] GY-901: the last GitHub observation before the merge is a stale observation, older than two minutes.'),

  // GY-901 round 2: gate disagreement (marker: "reconciliation refused")
  row(12, A, '2026-09-26T09:10:00.000Z', '[Decided from the GitHub observation.] GY-901: reconciliation of the merge record refused on decision y.'),

  // GY-902 round 1: base breakage (marker: "Base refresh only")
  row(13, B, '2026-09-26T08:20:00.000Z', 'Base refresh only: the candidate\'s required test check failed on tests main has since fixed (the fixed-date reset).'),

  // GY-902 round 2: own-change-ci (marker: "required CI check")
  row(14, B, '2026-09-26T09:20:00.000Z', '[Decided from the GitHub observation.] GY-902: required CI check test failed on candidate ddd4.'),

  // GY-903 round 1: lost-approval (marker: "does not exercise")
  row(15, C, '2026-09-26T09:30:00.000Z', '[Decided from the GitHub observation.] GY-903: the producer recorded evidence that does not exercise its criterion on eee5.'),
];

// Fixture events for waiting time calculation (AC-2)
const fixtureFullEvents = [
  { seq: '100', work_id: A, actor: 'graphyard', kind: 'lease.claimed', created_at: '2026-09-26T08:00:00.000Z', details: { epoch: 1 }, payload: {} },
  { seq: '101', work_id: A, actor: 'graphyard', kind: 'gates.changed', created_at: '2026-09-26T08:10:00.000Z', details: { stage: 'build', unmet: ['test'] } },
  { seq: '102', work_id: A, actor: 'graphyard', kind: 'gates.changed', created_at: '2026-09-26T08:30:00.000Z', details: { stage: 'build', unmet: ['review'] } },
  { seq: '103', work_id: A, actor: 'graphyard', kind: 'gates.changed', created_at: '2026-09-26T09:00:00.000Z', details: { stage: 'build', unmet: ['merge'] } },
  { seq: '104', work_id: A, actor: 'graphyard', kind: 'gates.changed', created_at: '2026-09-26T10:00:00.000Z', details: { stage: 'done', unmet: [] } },
  { seq: '105', work_id: A, actor: 'github', kind: 'merged', created_at: '2026-09-26T10:00:00.000Z', details: {} },
];

test('unit:rework-causes-classified — the classifier reads a fixture ledger and asserts every cause', async () => {
  // The new AC-1 causes: gate-disagreement and stale-observation
  const staleObs = classifyDeliveryReworkReason('the last observation is a stale observation, older than two minutes');
  assert.equal(staleObs.cause, 'stale-observation');

  const gateDisagreement = classifyDeliveryReworkReason('reconciliation of the record refused on decision y');
  assert.equal(gateDisagreement.cause, 'gate-disagreement');

  // The extended taxonomy: own-change splits into review vs CI
  const ownReview = classifyDeliveryReworkReason('GY-x: graphyard-reviewer[bot] requested changes on ccc3. The verdict stands against the current head.');
  assert.equal(ownReview.cause, 'own-change-review');

  const ownCI = classifyDeliveryReworkReason('GY-x: required CI check test failed on candidate a.');
  assert.equal(ownCI.cause, 'own-change-ci');

  // GY-643 causes still classify correctly
  const conflict = classifyDeliveryReworkReason('GitHub reports that candidate a conflicts with base branch tip b.');
  assert.equal(conflict.cause, 'conflict-with-base');

  const baseBreak = classifyDeliveryReworkReason('Base refresh only: the required test check failed on tests main has since fixed.');
  assert.equal(baseBreak.cause, 'base-breakage');

  const docsBudget = classifyDeliveryReworkReason('unit:docs-word-budget reports README+docs total 12058 words against a 12000 budget.');
  assert.equal(docsBudget.cause, 'docs-budget');

  const lostApproval = classifyDeliveryReworkReason('the producer recorded evidence that does not exercise its criterion on a.');
  assert.equal(lostApproval.cause, 'lost-approval');

  // Negation discipline: "not a flake" is not ci-flake, and should be classified as own-change-review
  const notFlake = classifyDeliveryReworkReason('the check is not flaky; it fails because the change removed the fixture.');
  assert.equal(notFlake.cause, 'own-change-review', 'negated flake is not classified as ci-flake');

  // Other
  const other = classifyDeliveryReworkReason('some unknown reason with no markers');
  assert.equal(other.cause, 'other');

  // The fixture ledger: rework rounds classified and attributed to items
  const classify = (reason: string) => classifyDeliveryReworkReason(reason);
  const entries = attributeDeliveryRounds(fixtureWork, fixtureReworkEvents, classify);

  // Check counts and measured status
  assert.deepEqual(entries.map((entry: any) => [entry.key, entry.rounds.length, entry.measured]), [['GY-901', 2, true], ['GY-902', 2, true], ['GY-903', 1, true], ['GY-904', 0, false]]);

  // Check causes in fixture
  assert.equal(entries[0].rounds[0].cause, 'stale-observation', 'GY-901 round 1 is stale-observation');
  assert.equal(entries[0].rounds[1].cause, 'gate-disagreement', 'GY-901 round 2 is gate-disagreement');
  assert.equal(entries[1].rounds[0].cause, 'base-breakage', 'GY-902 round 1 is base-breakage');
  assert.equal(entries[1].rounds[1].cause, 'own-change-ci', 'GY-902 round 2 is own-change-ci');
  assert.equal(entries[2].rounds[0].cause, 'lost-approval', 'GY-903 round 1 is lost-approval');

  // Command-line surface
  assert.deepEqual(parseArguments(['--items', '50']), { items: 50, record: null, json: false });
  assert.throws(() => parseArguments(['--items', '0']), /positive integer/);
});

test('unit:wait-causes-classified — waiting time is split by cause and flows are extracted', async () => {
  // Extract flow facts from full events
  const flowFacts = extractFlowFacts(fixtureFullEvents);
  const gateFacts = flowFacts.filter((f: any) => f.kind === 'gates.changed');
  assert.ok(gateFacts.length > 0, 'gate facts extracted');

  // Calculate waiting time for the fixture item
  const mergedAt = '2026-09-26T10:00:00.000Z';
  const claimedAt = '2026-09-26T08:00:00.000Z';
  const waiting = deliveryWaitingTimeByCase(flowFacts, mergedAt, claimedAt, null);

  // Waiting should have some time in various categories
  assert.ok(waiting.ms > 0, 'waiting time calculated');
  assert.ok(waiting.byWaitCause.ci > 0 || waiting.byWaitCause.review > 0, 'waiting time attributed to at least one cause');

  // Render report format
  const report = {
    population: { items: 100, delivered: 4, measured: 3, unmeasured: 1 },
    window: { since: '2026-09-26T08:00:00.000Z', until: '2026-09-26T12:00:00.000Z' },
    statement: null,
    rework: {
      rounds: 5,
      largest: [
        { cause: 'stale-observation', label: 'stale-observation', count: 1, share: 0.2 },
        { cause: 'gate-disagreement', label: 'gate-disagreement', count: 1, share: 0.2 },
        { cause: 'base-breakage', label: 'base-breakage', count: 1, share: 0.2 },
        { cause: 'own-change-ci', label: 'own-change-ci', count: 1, share: 0.2 },
        { cause: 'lost-approval', label: 'lost-approval', count: 1, share: 0.2 },
      ],
      rawMedian: 1,
      rawP90: 2,
    },
    waiting: {
      totalMs: 0,
      largest: [],
    },
    pipeline: {
      submitToMerge: { p50Ms: 6300000, p90Ms: 66600000 },
    },
  };

  const text = render(report as any);
  assert.match(text, /Rework rounds/);
  assert.match(text, /Waiting time/);
  assert.match(text, /Pipeline speed/);
  assert.match(text, /stale-observation/);
  assert.match(text, /gate-disagreement/);
});
