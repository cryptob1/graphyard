import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyReworkReason, deriveFacts, gateFactStep, mergeReadyGate, recentDelivered } from '../src/flow-analytics.js';
import { queueSequencingReason } from '../src/merge-queue.js';
import { nearestRankPercentiles, pipelineSpeedSummary } from '../src/pipeline-speed.js';
import type { Work } from '../src/model.js';
// @ts-expect-error Dependency-free report script.
import { attributeDeliveryRounds, classifyDeliveryReworkReason, collect, deliveryWaitingTimeByCase, deliveryReworkCauses, parseArguments, render, summarizeWaiting, waitCauses } from '../scripts/delivery-causes.mjs';

// GY-879: delivery-flow causes classified from the events ledger. Each test is named for the proof
// it produces — unit:rework-causes-classified (AC-1) and unit:wait-causes-classified (AC-2) — and
// asserts exact counts and millisecond sums, so a stubbed classifier or a stubbed waiting split
// fails the proof instead of passing vacuously.

const classify = (reason: string) => classifyDeliveryReworkReason(reason, classifyReworkReason);
const id = (key: string) => `00000000-0000-4000-8000-${key.padStart(12, '0')}`;
const A = id('a00000000001'), B = id('b00000000001'), C = id('c00000000001'), D = id('d00000000001'), E = id('e00000000001');
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const minute = 60_000;

// One delivered item per row of the population, in the Work shape the snapshot serves.
const deliveredItem = (workId: string, key: string, over: Record<string, any> = {}): Work => ({
  id: workId, key, title: `Fixture ${key}`, description: '', type: 'feature', priority: 1, dependencies: [], plannedFiles: ['scripts/delivery-causes.mjs'],
  stage: 'done', createdAt: '2026-09-26T04:00:00.000Z', updatedAt: '2026-09-26T10:00:00.000Z', stageEnteredAt: '2026-09-26T10:00:00.000Z',
  epoch: 3, gates: [], violations: [], workspaces: [], sessions: [], policy: { checks: ['test', 'typecheck'], review: true },
  submission: { epoch: 1, pr: 400 },
  delivery: { pr: 400, mergeSha: sha40(key), mergedAt: '2026-09-26T10:00:00.000Z', mergedAtRepository: '2026-09-26T10:00:00.000Z' },
  pipeline: { attempts: [], submittedAt: '2026-09-26T06:00:00.000Z', resubmittedAt: '2026-09-26T06:00:00.000Z', reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } },
  ...over,
} as unknown as Work);

const attempt = (epoch: number, claimedAt: string, endedAt: string) => ({ epoch, owner: `w${epoch}`, claimedAt, endedAt, end: 'submitted' as const });
const fixtureWork: Work[] = [
  // GY-901: 4 h window, three attempts (60 min execution inside it), two rework rounds, every
  // waiting cause except gate disagreement on its timeline.
  deliveredItem(A, 'GY-901', {
    createdAt: '2026-09-26T04:00:00.000Z', delivery: { pr: 400, mergeSha: sha40('GY-901'), mergedAt: '2026-09-26T10:00:00.000Z', mergedAtRepository: '2026-09-26T10:00:00.000Z' },
    pipeline: { attempts: [attempt(1, '2026-09-26T05:00:00.000Z', '2026-09-26T06:00:00.000Z'), attempt(2, '2026-09-26T07:00:00.000Z', '2026-09-26T07:30:00.000Z'), attempt(3, '2026-09-26T08:00:00.000Z', '2026-09-26T08:30:00.000Z')], submittedAt: '2026-09-26T06:00:00.000Z', resubmittedAt: '2026-09-26T08:30:00.000Z', reworkRounds: 2, interventions: { blocked: 0, requirements: 0 } },
  }),
  // GY-902: 2 h window, an open approver decision across it, one review round, a merge refusal
  // recorded in the unauthorized-merge vocabulary.
  deliveredItem(B, 'GY-902', {
    createdAt: '2026-09-26T05:30:00.000Z', delivery: { pr: 401, mergeSha: sha40('GY-902'), mergedAt: '2026-09-26T09:00:00.000Z', mergedAtRepository: '2026-09-26T09:00:00.000Z' },
    pipeline: { attempts: [attempt(1, '2026-09-26T07:00:00.000Z', '2026-09-26T07:30:00.000Z'), attempt(2, '2026-09-26T08:10:00.000Z', '2026-09-26T08:40:00.000Z')], submittedAt: '2026-09-26T07:00:00.000Z', resubmittedAt: '2026-09-26T08:40:00.000Z', reworkRounds: 1, interventions: { blocked: 0, requirements: 0 } },
  }),
  // GY-903: 30 min window with no attempt records (its timeline was backfilled without attempts),
  // so its execution is unmeasured and named rather than converted into waiting.
  deliveredItem(C, 'GY-903', {
    createdAt: '2026-09-26T06:30:00.000Z', delivery: { pr: 402, mergeSha: sha40('GY-903'), mergedAt: '2026-09-26T08:30:00.000Z', mergedAtRepository: '2026-09-26T08:30:00.000Z' },
    pipeline: { attempts: [], submittedAt: '2026-09-26T08:00:00.000Z', resubmittedAt: '2026-09-26T08:00:00.000Z', reworkRounds: 2, interventions: { blocked: 0, requirements: 0 } },
  }),
  // GY-904: delivered with no recorded submission — unmeasured everywhere, named, never dropped.
  deliveredItem(D, 'GY-904', {
    createdAt: '2026-09-26T05:00:00.000Z',
    pipeline: { attempts: [], submittedAt: null, resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } },
  }),
  // GY-905: delivered with attempt records but its events are pruned — nothing to fold, named as
  // unmeasured. (An item with neither attempts nor events is named unmeasured-execution first:
  // pipeline-speed's own awaiting-backfill-before-events-pruned precedence.)
  deliveredItem(E, 'GY-905', {
    createdAt: '2026-09-26T07:00:00.000Z', delivery: { pr: 404, mergeSha: sha40('GY-905'), mergedAt: '2026-09-26T08:30:00.000Z', mergedAtRepository: '2026-09-26T08:30:00.000Z' },
    pipeline: { attempts: [attempt(1, '2026-09-26T08:05:00.000Z', '2026-09-26T08:25:00.000Z')], submittedAt: '2026-09-26T08:00:00.000Z', resubmittedAt: '2026-09-26T08:00:00.000Z', reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } },
  }),
];

// The recorded reason texts quote the control plane's own templates (src/daemon/decisions.ts,
// src/engine.ts) so the classifier reads exactly what real rounds carry.
const staleObservationReason = '[Decided from the GitHub observation taken at 2026-09-26T06:29:00.000Z of candidate 0000000000000000000000000000000000000001; if the item has moved since, this request no longer describes it.] GY-901: rework waits for a fresh GitHub observation — the last GitHub observation (taken at 2026-09-26T06:29:00.000Z of head 000000000000) is a stale observation, older than two minutes, and the branch may have moved past that head. [decision d1, approved: the wait is real.]';
const gateDisagreementReason = '[Decided from the GitHub observation taken at 2026-09-26T07:59:00.000Z.] GY-901: Reconciliation by decision d2 refused: gate merge had not passed: violations stood: Merge observed without a prior authorization for this candidate. The control plane and the merge record disagree about whether the merge was authorized, so the item returns to a worker. [decision d2]';
const ownReviewReason = '[Decided from the GitHub observation taken at 2026-09-26T07:59:00.000Z.] GY-902: graphyard-reviewer[bot] requested changes on 0000000000000000000000000000000000000002. The verdict stands against the current head, so the item returns to a worker. [decision d3, approved: blocking finding holds.]';
const notFlakeReason = 'GY-903: the check is not flaky; it fails because the change removed the fixture. The verdict stands against the current head. [decision d4, approved: deterministic.]';
const ownCiReason = '[Decided from the GitHub observation taken at 2026-09-26T08:19:00.000Z.] GY-903: required CI check typecheck failed on candidate 0000000000000000000000000000000000000003. The check fails because the change dropped a type: fix what CI found. [decision d5, approved: own change.]';

const reworkRow = (seq: number, workId: string, at: string, reason: string) => ({ seq: String(seq), work_id: workId, actor: 'graphyard-master', kind: 'rework', created_at: at, details: { reason, previousWorkerStopped: true } });
const fixtureReworkRows = [
  // Before the item's first submission: not a round, however causal it reads.
  reworkRow(10, A, '2026-09-26T05:30:00.000Z', 'GY-901: graphyard-reviewer[bot] requested changes on 1f0f369dd3.'),
  reworkRow(11, A, '2026-09-26T06:30:00.000Z', staleObservationReason),
  reworkRow(12, A, '2026-09-26T08:00:00.000Z', gateDisagreementReason),
  reworkRow(13, B, '2026-09-26T08:00:00.000Z', ownReviewReason),
  reworkRow(14, C, '2026-09-26T08:10:00.000Z', notFlakeReason),
  reworkRow(15, C, '2026-09-26T08:20:00.000Z', ownCiReason),
];

// Full-payload rows for the per-item reads: each carries the work snapshot the fact fold projects,
// so gates.changed facts — projected, never raw ledger rows — exist for the interval walk.
let seq = 100;
const gateRow = (name: string, passed: boolean, reasons: string[] = []) => ({ name, passed, reasons });
const fullGates = (unmetGate: string, gateReasons: string[]) => [
  gateRow('ready', true),
  gateRow('build', unmetGate !== 'build', unmetGate === 'build' ? gateReasons : []),
  gateRow('test', unmetGate !== 'test', unmetGate === 'test' ? gateReasons : ['Required check test has not finished']),
  gateRow('review', unmetGate !== 'review', unmetGate === 'review' ? gateReasons : ['Independent approval of the current commit is required']),
  gateRow('acceptance', unmetGate !== 'acceptance', unmetGate === 'acceptance' ? gateReasons : ['required proof outstanding']),
  gateRow('merge', unmetGate !== 'merge', unmetGate === 'merge' ? gateReasons : []),
];
const snapshot = (workId: string, key: string, over: Record<string, any>) => ({
  id: workId, key, title: `Fixture ${key}`, description: '', type: 'feature', priority: 1, dependencies: [], plannedFiles: ['scripts/delivery-causes.mjs'],
  stage: 'building', createdAt: '2026-09-26T04:00:00.000Z', updatedAt: over.at ?? '2026-09-26T04:00:00.000Z', stageEnteredAt: over.at ?? '2026-09-26T04:00:00.000Z',
  epoch: 1, gates: fullGates('build', ['Worker has not submitted implementation for this attempt']), violations: [], workspaces: [], sessions: [],
  policy: { checks: ['test'], review: true }, ready: true, queue: null, reworkRequested: false, blocker: null, ...over,
});
const fullRow = (workId: string, kind: string, at: string, work: Record<string, any>) => ({ seq: String(seq++), work_id: workId, actor: 'graphyard', kind, created_at: at, payload: { work } });

const eventsA = [
  fullRow(A, 'claim', '2026-09-26T05:00:00.000Z', snapshot(A, 'GY-901', { at: '2026-09-26T05:00:00.000Z', gates: fullGates('build', ['Worker has not submitted implementation for this attempt']) })),
  fullRow(A, 'submit', '2026-09-26T06:00:00.000Z', snapshot(A, 'GY-901', { at: '2026-09-26T06:00:00.000Z', submission: { epoch: 1, pr: 400 }, candidate: { pr: 400, sha: sha40('a1'), baseSha: sha40('base') }, gates: fullGates('test', ['Required check test has not finished']) })),
  fullRow(A, 'rework', '2026-09-26T06:30:00.000Z', snapshot(A, 'GY-901', { at: '2026-09-26T06:30:00.000Z', reworkRequested: true, gates: fullGates('build', ['Worker has not submitted implementation for this attempt']) })),
  fullRow(A, 'claim', '2026-09-26T07:00:00.000Z', snapshot(A, 'GY-901', { at: '2026-09-26T07:00:00.000Z', candidate: { pr: 400, sha: sha40('a2'), baseSha: sha40('base') }, gates: fullGates('test', ['Required check test is running for the new head']) })),
  // The GitHub observation rows: the reconciliation pass records the review, queue and merge-gate
  // transitions on `github.observed` rows — the routine kinds the server excludes unless the read
  // names routine=include (src/events-history.ts `eventSelection`).
  fullRow(A, 'github.observed', '2026-09-26T07:30:00.000Z', snapshot(A, 'GY-901', { at: '2026-09-26T07:30:00.000Z', gates: fullGates('review', ['Independent approval of the current commit is required']) })),
  fullRow(A, 'rework', '2026-09-26T08:00:00.000Z', snapshot(A, 'GY-901', { at: '2026-09-26T08:00:00.000Z', reworkRequested: true, gates: fullGates('build', ['Worker has not submitted implementation for this attempt']) })),
  fullRow(A, 'submit', '2026-09-26T08:30:00.000Z', snapshot(A, 'GY-901', { at: '2026-09-26T08:30:00.000Z', candidate: { pr: 400, sha: sha40('a3'), baseSha: sha40('base') }, gates: fullGates('acceptance', ['required proof outstanding']) })),
  // A routine heartbeat whose snapshot repeats the standing gates, candidate and submission:
  // included in the read, yet no new gate fact — routine volume must not disturb the fold.
  fullRow(A, 'heartbeat', '2026-09-26T08:45:00.000Z', snapshot(A, 'GY-901', { at: '2026-09-26T08:45:00.000Z', submission: { epoch: 1, pr: 400 }, candidate: { pr: 400, sha: sha40('a3'), baseSha: sha40('base') }, gates: fullGates('acceptance', ['required proof outstanding']) })),
  fullRow(A, 'github.observed', '2026-09-26T09:00:00.000Z', snapshot(A, 'GY-901', { at: '2026-09-26T09:00:00.000Z', queue: { sequence: 1 }, gates: fullGates('merge', ['Merge queue position 1 of 1: the entry is queued']) })),
  fullRow(A, 'github.observed', '2026-09-26T09:30:00.000Z', snapshot(A, 'GY-901', { at: '2026-09-26T09:30:00.000Z', gates: fullGates('merge', ['GitHub observation missing or older than two minutes']) })),
  fullRow(A, 'github.observed', '2026-09-26T09:45:00.000Z', snapshot(A, 'GY-901', { at: '2026-09-26T09:45:00.000Z', gates: fullGates('merge', ['the merge is held for the approver: decision d9 for GY-901 awaits its independent approval']) })),
];
const eventsB = [
  fullRow(B, 'submit', '2026-09-26T07:00:00.000Z', snapshot(B, 'GY-902', { at: '2026-09-26T07:00:00.000Z', submission: { epoch: 1, pr: 401 }, candidate: { pr: 401, sha: sha40('b1'), baseSha: sha40('base') }, gates: fullGates('test', ['Required check test has not finished']) })),
  fullRow(B, 'github.observed', '2026-09-26T07:30:00.000Z', snapshot(B, 'GY-902', { at: '2026-09-26T07:30:00.000Z', gates: fullGates('review', ['Independent approval of the current commit is required']) })),
  { seq: String(seq++), work_id: B, actor: 'graphyard', kind: 'decision.requested', created_at: '2026-09-26T07:30:00.000Z', payload: { id: 'dz1', action: 'rework', reason: ownReviewReason } },
  { seq: String(seq++), work_id: B, actor: 'graphyard-approver-1', kind: 'decision.approved', created_at: '2026-09-26T07:50:00.000Z', payload: { id: 'dz1', reason: 'the verdict is real' } },
  fullRow(B, 'rework', '2026-09-26T08:00:00.000Z', snapshot(B, 'GY-902', { at: '2026-09-26T08:00:00.000Z', reworkRequested: true, gates: fullGates('build', ['Worker has not submitted implementation for this attempt']) })),
  fullRow(B, 'submit', '2026-09-26T08:40:00.000Z', snapshot(B, 'GY-902', { at: '2026-09-26T08:40:00.000Z', reworkRequested: false, candidate: { pr: 401, sha: sha40('b2'), baseSha: sha40('base') }, gates: fullGates('merge', ['Merge observed without a prior authorization for this candidate']) })),
];
const eventsC = [
  fullRow(C, 'submit', '2026-09-26T08:00:00.000Z', snapshot(C, 'GY-903', { at: '2026-09-26T08:00:00.000Z', submission: { epoch: 1, pr: 402 }, candidate: { pr: 402, sha: sha40('c1'), baseSha: sha40('base') }, gates: fullGates('test', ['Required check test has not finished']) })),
  fullRow(C, 'rework', '2026-09-26T08:10:00.000Z', snapshot(C, 'GY-903', { at: '2026-09-26T08:10:00.000Z', reworkRequested: true, gates: fullGates('build', ['Worker has not submitted implementation for this attempt']) })),
  fullRow(C, 'rework', '2026-09-26T08:20:00.000Z', snapshot(C, 'GY-903', { at: '2026-09-26T08:20:00.000Z', reworkRequested: true, gates: fullGates('build', ['Worker has not submitted implementation for this attempt']) })),
];
const fullEventsByWork: Record<string, any[]> = { [A]: eventsA, [B]: eventsB, [C]: eventsC, [D]: [], [E]: [] };

// The fake control plane answers the exact read contract the script uses: a whole-ledger
// kind=rework read with `details` payloads and cursor paging, and per-item reads with full payloads.
// The per-item branch mirrors the server (src/events-history.ts `eventSelection`): the routine rows
// (`github.observed`, `heartbeat`) are filtered out unless the read names routine=include, and the
// since lower bound is half-open. If the script forgets routine=include, the observation rows
// disappear exactly as they do against the live API and the asserted split stops adding up — so
// this fixture pins the request instead of hiding the bug the reviewer found.
const routineRow = (row: any) => row.kind === 'github.observed' || row.kind === 'heartbeat';
const fakeApi = async (path: string) => {
  if (path === 'work-snapshot') return { work: fixtureWork, now: '2026-09-26T12:00:00.000Z' };
  if (path.startsWith('events?')) {
    const query = new URLSearchParams(path.slice('events?'.length));
    const work = query.get('work');
    if (work === null) {
      assert.equal(query.get('kind'), 'rework');
      assert.equal(query.get('order'), 'asc');
      assert.equal(query.get('payload'), 'details');
      assert.equal(query.get('view'), 'history');
      assert.equal(query.get('since'), '2026-09-26T06:00:00.000Z');
      const start = query.get('cursor') ? fixtureReworkRows.findIndex(row => row.seq === query.get('cursor')) + 1 : 0;
      const page = fixtureReworkRows.slice(start, start + 2);
      return { events: page, page: { hasMore: start + 2 < fixtureReworkRows.length, nextCursor: page.at(-1)?.seq ?? null }, filters: { kinds: ['rework'] } };
    }
    assert.equal(query.get('payload'), 'full');
    assert.equal(query.get('view'), 'page');
    assert.equal(query.get('order'), 'asc');
    assert.equal(query.get('since'), fixtureWork.find(item => item.id === work)?.pipeline?.submittedAt, 'the per-item read opens at the item\'s first submission: the window the split measures');
    const includeRoutine = query.get('routine') === 'include';
    const since = Date.parse(query.get('since') ?? '');
    const rows = (fullEventsByWork[work] ?? [])
      .filter(row => includeRoutine || !routineRow(row))
      .filter(row => Number.isFinite(Date.parse(row.created_at)) ? Date.parse(row.created_at) >= since : true);
    return { events: rows, page: { hasMore: false, nextCursor: null }, filters: { work } };  }
  throw new Error(`unexpected api path ${path}`);
};

const analytics = { recentDelivered, classifyReworkReason, deriveFacts, gateFactStep, mergeReadyGate, queueSequencingReason, pipelineSpeedSummary, nearestRankPercentiles, pageLimit: 300, reworkPages: 10, pageWalkBound: 24 };
const helpers = { deriveFacts, gateFactStep, mergeReadyGate, queueSequencingReason };

test('unit:rework-causes-classified — every rework round of the fixture ledger lands in one of the nine causes, with the marker that decided it', async () => {
  // The layered classifier: the GY-879 causes by their recorded markers, first match wins.
  assert.equal(classify(staleObservationReason).cause, 'stale-observation');
  assert.equal(classify(staleObservationReason).marker, 'stale observation named');
  assert.equal(classify(gateDisagreementReason).cause, 'gate-disagreement');
  assert.equal(classify(gateDisagreementReason).marker, 'reconciliation refusal record');
  assert.equal(classify('GY-x: Merge observed without a prior authorization for this candidate.').cause, 'gate-disagreement');
  assert.equal(classify('GY-x: the record at 2026-09-26T09:00:00.000Z (the merge cutoff) did not either.').cause, 'gate-disagreement');
  assert.equal(classify('GY-x: violations stood: the merge record did not carry an authorization.').cause, 'gate-disagreement');
  assert.equal(classify('GY-x: required proof unit:x had no live trusted evidence at the cutoff.').cause, 'gate-disagreement');
  // A historical-authorization refusal quoting observation freshness is a gate disagreement, not a
  // stale-observation round; the bare freshness refusal is the stale-observation round.
  assert.equal(classify('GY-x: gate merge had not passed: the last GitHub observation before the merge was older than two minutes.').cause, 'gate-disagreement');
  assert.equal(classify('GY-x: the merge gate refuses: GitHub observation missing or older than two minutes.').cause, 'stale-observation');
  // Negation discipline: "not stale", "no disagreement" and an unrelated "no longer" never fire.
  assert.equal(classify('GY-x: the observation is not stale, the records agree — no disagreement between the merge record and the gates.').cause, 'other');
  assert.equal(classify('GY-x: the guidance no longer describes the module layout; reruns passed; no flake.').cause, 'other');
  assert.equal(classify('GY-x: the branch has not moved past the observed head; nothing waits.').cause, 'other');
  // GY-643's taxonomy underneath, with own-change split and flake reduced onto other (counted, never guessed).
  assert.equal(classify('GY-x: GitHub reports that candidate a conflicts with base branch tip b.').cause, 'conflict-with-base');
  assert.equal(classify('Base refresh only: the required test check failed on tests main has since fixed.').cause, 'base-breakage');
  assert.equal(classify('GY-x: unit:docs-word-budget reports README+docs total 12058 words against a 12000 budget.').cause, 'docs-budget');
  assert.equal(classify('GY-x: the producer recorded evidence that does not exercise its criterion on a.').cause, 'lost-approval-or-proof');
  assert.equal(classify('Launch readiness flake; clear and retry.').cause, 'other', 'a flake is not one of the nine causes; it stays counted under other');
  assert.equal(classify('GY-x: graphyard-reviewer[bot] requested changes on c. The verdict stands against the current head.').cause, 'own-change-review');
  assert.equal(classify('GY-x: graphyard-reviewer[bot] requested changes on c: required CI check test failed on candidate a. Fix what CI found.').cause, 'own-change-ci');
  assert.equal(classify('GY-x: the change exceeds the module budget of src/engine.ts by 12 lines.').cause, 'own-change-ci');
  assert.equal(classify('GY-x: the check is not flaky; it fails because the change removed the fixture.').cause, 'own-change-review', 'a negated flake is classified by the rest of its text');
  assert.equal(classify('GY-x: something happened.').cause, 'other', 'an unmatched round is other, counted, never guessed');
  assert.equal(classifyDeliveryReworkReason('anything without a base classifier').cause, 'other');

  // The fixture ledger: rounds only at or after the first submission, attributed and counted.
  const entries = attributeDeliveryRounds(fixtureWork, fixtureReworkRows, classify);
  assert.deepEqual(entries.map((entry: any) => [entry.key, entry.rounds.length, entry.measured]),
    [['GY-901', 2, true], ['GY-902', 1, true], ['GY-903', 2, true], ['GY-904', 0, false], ['GY-905', 0, true]],
    'pre-submission rows are not rounds; an item with no recorded submission is unmeasured, not silent');
  assert.deepEqual(entries[0].rounds.map((round: any) => round.cause), ['stale-observation', 'gate-disagreement']);
  assert.deepEqual(entries[1].rounds.map((round: any) => round.cause), ['own-change-review']);
  assert.deepEqual(entries[2].rounds.map((round: any) => round.cause), ['own-change-review', 'own-change-ci']);
  assert.equal(entries[0].rounds[0].seq, '11');
  assert.equal(entries[0].rounds[0].at, '2026-09-26T06:30:00.000Z');

  // The closed nine-cause taxonomy, zeros and all, over the whole population.
  const counts = Object.fromEntries(deliveryReworkCauses.map((cause: string) => [cause, 0]));
  for (const entry of entries) for (const round of entry.rounds) counts[round.cause] += 1;
  assert.deepEqual(counts, { 'own-change-review': 2, 'own-change-ci': 1, 'base-breakage': 0, 'conflict-with-base': 0, 'docs-budget': 0, 'lost-approval-or-proof': 0, 'gate-disagreement': 1, 'stale-observation': 1, other: 0 });

  // Command-line surface.
  assert.deepEqual(parseArguments(['--items', '50']), { items: 50, record: null, json: false });
  assert.deepEqual(parseArguments(['--record', '/tmp/r', '--json']), { items: 100, record: '/tmp/r', json: true });
  assert.throws(() => parseArguments(['--items', '0']), /positive integer/);
  assert.throws(() => parseArguments(['--unknown']), /Unknown argument/);
});

test('unit:wait-causes-classified — each delivery\'s waiting time splits by cause with exact millisecond sums, and the report prints every share', async () => {
  // GY-901: 4 h window. 1 h execution (attempts 2 and 3), 3 h waiting across six causes.
  const waitA = deliveryWaitingTimeByCase(fixtureWork[0], eventsA, helpers);
  assert.equal(waitA.measured, true);
  assert.equal(waitA.coverage, 'measured');
  assert.equal(waitA.windowMs, 240 * minute);
  assert.equal(waitA.executionMs, 60 * minute);
  assert.deepEqual(waitA.byCause, {
    'no-worker-slot': 30 * minute, ci: 30 * minute, review: 30 * minute, proof: 30 * minute,
    'approver-decision': 15 * minute, 'merge-queue': 30 * minute, observation: 15 * minute, 'gate-disagreement': 0,
  });
  assert.equal(waitA.totalWaitMs, 180 * minute);
  assert.equal(waitA.executionMs + waitA.totalWaitMs, waitA.windowMs, 'execution plus the whole split sums to the window, so nothing is double counted or lost');
  assert.deepEqual(waitA.slices.map((slice: any) => slice.cause),
    ['ci', 'no-worker-slot', 'execution', 'review', 'execution', 'proof', 'merge-queue', 'observation', 'approver-decision'],
    'the sweep attributes every slice between recorded facts to exactly one bucket');

  // GY-902: 2 h window; the open approver decision overrides the review step for 20 minutes and the
  // unauthorized-merge refusal is gate-disagreement, not merge queue.
  const waitB = deliveryWaitingTimeByCase(fixtureWork[1], eventsB, helpers);
  assert.equal(waitB.measured, true);
  assert.deepEqual(waitB.byCause, {
    'no-worker-slot': 10 * minute, ci: 0, review: 10 * minute, proof: 0,
    'approver-decision': 20 * minute, 'merge-queue': 0, observation: 0, 'gate-disagreement': 20 * minute,
  });
  assert.equal(waitB.executionMs, 60 * minute);
  assert.equal(waitB.executionMs + waitB.totalWaitMs, waitB.windowMs);

  // GY-903: a submitted, delivered window with no attempt records — its execution is unknown, so
  // the window is not convertible into a waiting split: named unmeasured-execution, contributing
  // nothing, never turned into fabricated waiting time.
  const waitC = deliveryWaitingTimeByCase(fixtureWork[2], eventsC, helpers);
  assert.equal(waitC.measured, false);
  assert.equal(waitC.coverage, 'unmeasured-execution');
  assert.equal(waitC.windowMs, 30 * minute);
  assert.deepEqual(waitC.byCause, { 'no-worker-slot': 0, ci: 0, review: 0, proof: 0, 'approver-decision': 0, 'merge-queue': 0, observation: 0, 'gate-disagreement': 0 });
  assert.equal(waitC.totalWaitMs, 0);
  assert.equal(waitC.executionMs, 0);

  // Unmeasured items are named by coverage, never silently dropped from the population.
  assert.deepEqual(
    [deliveryWaitingTimeByCase(fixtureWork[3], [], helpers).coverage, deliveryWaitingTimeByCase(fixtureWork[4], [], helpers).coverage],
    ['no-submission', 'events-pruned']);

  // The aggregate: totals, shares of the waiting hours, per-delivery percentiles per cause —
  // built in the population's own order (GY-903, GY-905, GY-902, GY-901, GY-904 by accepted merge).
  // Only GY-902 and GY-901 are measured: the unmeasured-execution delivery adds no fabricated
  // waiting minute to any bucket.
  waitA.key = 'GY-901'; waitB.key = 'GY-902'; waitC.key = 'GY-903';
  const waitD = deliveryWaitingTimeByCase(fixtureWork[3], [], helpers); waitD.key = 'GY-904';
  const waitE = deliveryWaitingTimeByCase(fixtureWork[4], [], helpers); waitE.key = 'GY-905';
  const waits = [waitC, waitE, waitB, waitA, waitD];
  const summary = summarizeWaiting(waits, nearestRankPercentiles);
  assert.deepEqual(summary.byCause, {
    'no-worker-slot': 40 * minute, ci: 30 * minute, review: 40 * minute, proof: 30 * minute,
    'approver-decision': 35 * minute, 'merge-queue': 30 * minute, observation: 15 * minute, 'gate-disagreement': 20 * minute,
  });
  assert.equal(summary.totalWaitMs, 240 * minute);
  assert.equal(summary.executionMs, 120 * minute);
  assert.equal(summary.executionMs + summary.totalWaitMs, summary.windowMs);
  assert.equal(summary.executionShare, Number((120 / 360).toFixed(4)), 'execution share of the open time (120 min execution of the 360 min measured windows)');
  assert.equal(summary.waitP50Ms, 60 * minute, 'per-delivery waiting among measured items: GY-902 60 min, GY-901 180 min');
  assert.equal(summary.waitP90Ms, 180 * minute);
  assert.equal(summary.largest[0].cause, 'no-worker-slot');
  assert.equal(summary.largest[0].ms, 40 * minute);
  assert.equal(Math.abs(waitCauses.reduce((total: number, cause: string) => total + (summary.shares[cause] ?? 0), 0) - 1) < 0.001, true, 'the printed shares cover every waiting minute');
  assert.deepEqual(summary.unmeasured, [
    { key: 'GY-903', coverage: 'unmeasured-execution' }, { key: 'GY-905', coverage: 'events-pruned' }, { key: 'GY-904', coverage: 'no-submission' }]);
  assert.deepEqual(summary.unmeasuredExecution, ['GY-903']);

  // The whole report over the fake control plane: the paged reads, the fold, both splits, and the
  // pipeline-speed headline restated beside them.
  const report = await collect(fakeApi, { items: 100 }, analytics);
  assert.deepEqual(report.population, { items: 100, delivered: 5, measured: 4, unmeasured: 1 });
  assert.equal(report.window.since, '2026-09-26T06:00:00.000Z');
  assert.equal(report.eventsComplete, true);
  assert.equal(report.pages, 3, 'the rework read walked every page of the fixture ledger');
  assert.equal(report.statement, null);
  assert.equal(report.rework.rounds, 5);
  assert.deepEqual(report.rework.byCause, { 'own-change-review': 2, 'own-change-ci': 1, 'base-breakage': 0, 'conflict-with-base': 0, 'docs-budget': 0, 'lost-approval-or-proof': 0, 'gate-disagreement': 1, 'stale-observation': 1, other: 0 });
  assert.deepEqual([report.rework.rawMedian, report.rework.rawP90, report.rework.ownChangeMedian, report.rework.ownChangeP90], [1, 2, 0, 2]);
  assert.deepEqual(report.waiting.byCause, summary.byCause);
  assert.deepEqual(report.waiting.unmeasured, summary.unmeasured);
  assert.deepEqual(report.preRelease, { totalMs: 6 * 60 * minute, measured: 4, unmeasured: 1 }, 'pre-release time (created to first submission) is reported from the documents, outside the seven-way split');
  // The pipeline-speed headline is the shared module's own: only items with attempt records are
  // measured there (GY-903 holds no attempts, so it awaits backfill in that report).
  assert.equal(report.pipelineSpeed.measured, 3);
  assert.equal(report.pipelineSpeed.unmeasured, 2);
  assert.equal(report.pipelineSpeed.submitToMerge.p50Ms, 120 * minute);
  assert.equal(report.pipelineSpeed.submitToMerge.p90Ms, 240 * minute);

  // The rendered report prints every cause with its share, including the zeros.
  const text = render(report);
  assert.match(text, /Delivery causes over the last 100 delivered items \(5 delivered, 4 measured/);
  assert.match(text, /Rework rounds: 5 classified; raw median 1 p90 2; own-change median 0 p90 2\./);
  assert.match(text, /own-change-review: 2 rounds/);
  assert.match(text, /stale-observation: 1 round/);
  assert.match(text, /base-breakage: 0 rounds/, 'a zero cause is printed, so shares are comparable across runs');
  assert.match(text, /Waiting time: 4 h of waiting against 2 h of execution across 2 measured deliveries/);
  assert.match(text, /no-worker-slot: 0\.7 h \(p50/);
  assert.match(text, /gate-disagreement: 0\.3 h/);
  assert.match(text, /Unmeasured: GY-903 \(unmeasured-execution\), GY-905 \(events-pruned\), GY-904 \(no-submission\)/);
  assert.match(text, /Pipeline speed: submit→merge p50 120 min p90 4 h over 3 measured deliveries \(2 unmeasured\)/);
});
