import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluate } from '../src/model/gates.js';
import { evaluateLandability } from '../src/model/landability.js';
import { requiredProofs } from '../src/model/bootstrap.js';
import { automatableOutcomes, producerGroupDecisions } from '../src/model/mechanical-proofs.js';
import { laneRequiresProof, lanes, releaseCandidateProof } from '../src/model/policy.js';
import {
  applyCandidateReport, candidateProofPlan, candidateReportRefusal, pendingRelease, pendingReleases, proofSuite, releaseState, type CandidateReport,
} from '../src/model/release-train.js';
import { phaseOf, plainStatus, statusHeld } from '../src/model/plain-status.js';
import { groupOf } from '../src/model/board.js';
import { buildMasterStatus } from '../src/master/status.js';
import {
  assessUat, candidateReport, cutCandidate, followUpItem, proofRunResult, type Ledger, type ReleaseCandidate,
} from '../src/release-candidate.js';
import type { Evidence, Observation, Work } from '../src/model.js';

// GY-1101: the merge gate is build, typecheck, the pre-merge unit set and one independent review;
// integration:/e2e: proofs run once per release candidate, and a merged item is Done only when a
// candidate containing it passes UAT and is promoted. A failed candidate fixes forward.

const at = '2026-10-03T12:00:00.000Z';
const now = new Date(at);
const sha = (digit: string) => digit.repeat(40);
const CI = [1];

const evidence = (proof: string, head: string): Evidence => ({
  id: `${proof}@${head.slice(0, 4)}`, proof, sha: head, baseSha: sha('9'), policyRevision: 1,
  producer: 'independent-producer', trusted: true, result: 'pass', executed: 3, skipped: 0, at,
}) as Evidence;

/** An item whose candidate passed build, typecheck, the pre-merge test check and one review, in the high lane. */
function candidateItem(key: string, proofs: string[], proven: string[], extra: Partial<Work> = {}): Work {
  const head = sha('7');
  const files = ['src/server/routes/own.ts'];
  const candidate = { sha: head, baseSha: sha('9'), pr: 77, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' };
  const observation = {
    candidate, checks: [{ name: 'test', result: 'success', appId: 1 }, { name: 'typecheck', result: 'success', appId: 1 }],
    reviews: [{ reviewer: 'reviewer', sha: head, state: 'APPROVED', submittedAt: at }],
    merged: false, mergeSha: null, mergeable: true, protected: true, files,
    scopeFiles: files.map(path => ({ path, status: 'modified', sha: sha('d'), baseSha: sha('e'), additions: 3, deletions: 1, binary: false })),
    landing: { base: sha('b'), files: [] }, at, prState: 'open', draft: false, baseTip: sha('9'), baseTree: sha('e'), baseTipContained: true,
  } as unknown as Observation;
  return {
    id: key.toLowerCase(), key, title: key, description: '', type: 'feature', priority: 0, dependencies: [],
    criteria: proofs.map((proof, index) => ({ id: `AC-${index + 1}`, text: 'proven', proofs: [proof] })),
    policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: files, stage: 'merge', revision: 4, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, candidate,
    workspaces: [{ host: 'machine-a', path: `/tmp/${key}`, epoch: 1, owner: 'worker', branch: candidate.branch }],
    submission: { epoch: 1, pr: 77 }, reworkRequested: false, scenarioRequirements: [],
    evidence: proven.map(proof => evidence(proof, head)), blocker: null, gates: [], violations: [],
    queue: null, queueSequence: 0, queueHistory: [], queueEjection: null, observation, ...extra,
  } as unknown as Work;
}

/** The same item after its observed merge: stage done, the merge snapshot, and the train record the engine starts. */
function merged(work: Work, mergeSha: string): Work {
  const delivery = { mergedAt: at, mergeSha, authorizationRevision: 4 };
  return { ...work, stage: 'done', delivery, releaseTrain: pendingRelease(work, delivery), queue: null } as Work;
}

const commit = (digit: string, key: string, pr: number) => ({ sha: sha(digit), subject: `Merge pull request #${pr} from cryptob1/graphyard/${key.toLowerCase()}-1`, body: '' });
const promotedCandidate: ReleaseCandidate = { id: '20261003T000000Z', sha: sha('0'), cutAt: at, trigger: 'schedule', since: null, items: [] };
const ledgerOf = (candidates: ReleaseCandidate[], uat: Ledger['uat'] = [], production: Ledger['production'] = []): Ledger => ({ candidates, uat, production });
const apply = (work: Work, report: CandidateReport, when = now) => {
  assert.equal(candidateReportRefusal(work, report), null);
  const { train } = applyCandidateReport(work, report, when);
  return { ...work, releaseTrain: train } as Work;
};

const ownProofs = ['unit:own-fast', 'integration:own-contract', 'e2e:own-journey', 'manual:own-witness'];

test('unit:merge-gate-fast-checks-only — a candidate with build, typecheck, the pre-merge tests and one review merges while its integration: and e2e: proofs have no evidence', () => {
  const work = candidateItem('GY-901', ownProofs, ['unit:own-fast', 'manual:own-witness']);
  const verdict = evaluateLandability(work, [work], now);
  assert.equal(verdict.verdict, 'landable', JSON.stringify(verdict));
  const result = evaluate(work, [work], now, CI);
  for (const gate of ['ready', 'build', 'review', 'test', 'acceptance']) assert.equal(result.gates.find(entry => entry.name === gate)?.passed, true, `${gate}: ${JSON.stringify(result.gates.find(entry => entry.name === gate)?.reasons)}`);
  // Eligible for the merge queue: the merge gate names only the queue's own last hop.
  assert.ok(result.queue, 'the item joins the merge queue');
  assert.doesNotMatch(JSON.stringify(result.gates), /integration:own-contract|e2e:own-journey/);
  // No lane requires a release-candidate proof before merge; unit and manual keep their lane rule.
  for (const lane of lanes) {
    assert.equal(laneRequiresProof(lane, 'integration:own-contract'), false);
    assert.equal(laneRequiresProof(lane, 'e2e:own-journey'), false);
  }
  assert.equal(laneRequiresProof('high', 'manual:own-witness'), true);
  assert.equal(laneRequiresProof('medium', 'unit:own-fast'), true);
  assert.deepEqual(requiredProofs(work, [work]).sort(), ['manual:own-witness', 'unit:own-fast']);
  // So no producer is asked for an integration group per head: only the unit group is mechanical.
  assert.deepEqual([...new Set(automatableOutcomes(work, [work], now).map(entry => entry.group))], ['unit']);
  assert.ok(producerGroupDecisions(work, [work], now).every(decision => decision.group !== 'integration'));
});

test('unit:merge-gate-fast-checks-only — unit proofs stay per pull request and manual attestations keep their current behaviour', () => {
  const noUnit = candidateItem('GY-902', ownProofs, ['manual:own-witness']);
  const unitVerdict = evaluateLandability(noUnit, [noUnit], now);
  assert.equal(unitVerdict.verdict, 'refused');
  assert.match(JSON.stringify(unitVerdict), /unit:own-fast needs trusted passing evidence/);
  const noManual = candidateItem('GY-903', ownProofs, ['unit:own-fast']);
  const manualVerdict = evaluateLandability(noManual, [noManual], now);
  assert.equal(manualVerdict.verdict, 'refused');
  assert.match(JSON.stringify(manualVerdict), /manual:own-witness needs trusted passing evidence/);
  assert.doesNotMatch(JSON.stringify(manualVerdict), /integration:|e2e:/);
});

test('unit:merge-gate-fast-checks-only — merging is never blocked by a release candidate in UAT or one that failed', () => {
  const ready = candidateItem('GY-904', ownProofs, ['unit:own-fast', 'manual:own-witness']);
  const inUat = apply(merged(candidateItem('GY-905', ownProofs, []), sha('5')), { candidate: { id: '20261003T060000Z', sha: sha('c'), items: [{ key: 'GY-905', mergeSha: sha('5'), pr: 5 }] }, uat: null, production: null });
  const failed = apply(merged(candidateItem('GY-906', ownProofs, []), sha('6')), { candidate: { id: '20261003T060000Z', sha: sha('c'), items: [{ key: 'GY-906', mergeSha: sha('6'), pr: 6 }] },
    uat: { result: 'failed', suites: [{ name: proofSuite('integration:own-contract'), passed: false, detail: 'failed' }], followUp: 'GY-999' }, production: null });
  const all = [ready, inUat, failed];
  assert.equal(evaluateLandability(ready, all, now).verdict, 'landable');
  assert.ok(evaluate(ready, all, now, CI).queue);
});

test('unit:merge-gate-fast-checks-only — docs describe the fast merge gate and per-candidate validation', () => {
  const delivery = readFileSync('docs/delivery.md', 'utf8'), github = readFileSync('docs/github.md', 'utf8');
  assert.match(github, /merge gate is build, typecheck, the pre-merge unit set and one independent review/i);
  assert.match(github, /`integration:` and `e2e:` proofs? (are|is) never/i);
  assert.match(delivery, /merged-pending-release/);
  assert.match(delivery, /Done only when/i);
  assert.match(delivery, /release proofs/);
});

test('unit:delivery-done-on-candidate-pass — merge records merged-pending-release, the first containing candidate runs its non-unit proofs, and promotion of a UAT-passed candidate marks it Done', () => {
  const open = candidateItem('GY-910', ownProofs, ['unit:own-fast', 'manual:own-witness']);
  // Merge: immutable stage done, but pending release — not Done, and not shipped on any reader.
  let work = merged(open, sha('1'));
  assert.equal(releaseState(work), 'merged-pending-release');
  assert.deepEqual(work.releaseTrain!.proofs, ['integration:own-contract', 'e2e:own-journey']);
  assert.ok(work.releaseTrain!.proofs.every(releaseCandidateProof));
  assert.equal(phaseOf(work, now.getTime()), 'releasing');
  assert.equal(plainStatus(work, now.getTime()).tone, 'waiting');
  assert.match(plainStatus(work, now.getTime()).sentence, /Merged in PR #77 — waiting for the next release/);
  assert.equal(statusHeld(work, now.getTime() + 10 * 3_600_000).overdue, false, 'pending release is a healthy resting state');
  assert.equal(groupOf(work, now.getTime()), 'moving');

  // Cut: the candidate's commits name the item's merge; its plan requests the item's non-unit proofs against it.
  const cut = cutCandidate({ tip: sha('c'), now: new Date('2026-10-03T13:00:00.000Z'), trigger: 'schedule', latest: promotedCandidate, promoted: promotedCandidate, commits: [commit('1', 'GY-910', 77)] });
  assert.ok(cut.cut);
  const candidate = cut.candidate;
  assert.deepEqual(candidateProofPlan(candidate, [work]), [
    { proof: 'e2e:own-journey', suite: 'proof e2e:own-journey', items: ['GY-910'] },
    { proof: 'integration:own-contract', suite: 'proof integration:own-contract', items: ['GY-910'] },
  ]);
  work = apply(work, candidateReport(ledgerOf([candidate]), candidate));
  assert.equal(releaseState(work), 'merged-pending-release');
  assert.deepEqual(work.releaseTrain!.first, { id: candidate.id, sha: candidate.sha });

  // Master status names the candidate for every pending item.
  const status = buildMasterStatus({ work: [work], now: at }, [], []);
  assert.equal(status.counts.releasePending, 1);
  assert.deepEqual(status.releasePending.map(row => [row.key, row.candidate?.id, row.candidate?.sha, row.candidate?.uat]), [['GY-910', candidate.id, candidate.sha, 'pending']]);
  assert.ok(!status.attentionItems.some(item => item.subject === 'GY-910'), 'a pending release is never attention');

  // UAT passes, the proofs among its suites: still pending until promotion.
  const uat = assessUat(candidate, { deployedSha: candidate.sha, suites: [{ name: 'endpoints', passed: true, detail: 'ok' },
    ...candidateProofPlan(candidate, [work]).map(entry => ({ name: entry.suite, passed: true, detail: '3 cases passed' }))], now });
  assert.equal(uat.result, 'passed');
  work = apply(work, candidateReport(ledgerOf([candidate], [uat]), candidate));
  assert.equal(releaseState(work), 'merged-pending-release');
  assert.equal(work.releaseTrain!.candidate!.uat, 'passed');
  assert.deepEqual(work.releaseTrain!.outcomes.map(entry => [entry.proof, entry.passed]).sort(), [['e2e:own-journey', true], ['integration:own-contract', true]]);
  assert.match(pendingReleases([work])[0].next, /passed UAT; Done when it is promoted/);

  // Promotion: Done.
  work = apply(work, candidateReport(ledgerOf([candidate], [uat], [{ id: candidate.id, sha: candidate.sha, at: '2026-10-03T15:00:00.000Z' }]), candidate));
  assert.equal(releaseState(work), 'released');
  assert.equal(work.releaseTrain!.releasedAt, '2026-10-03T15:00:00.000Z');
  assert.equal(phaseOf(work, now.getTime()), 'shipped');
  assert.equal(buildMasterStatus({ work: [work], now: at }, [], []).counts.releasePending, 0);
  // A promotion reported without a passing UAT record is refused; a delivered item with no record predates the train.
  assert.match(candidateReportRefusal(merged(open, sha('1')), { candidate, uat: null, production: { at } })!, /without a passing UAT record/);
  assert.equal(releaseState({ ...work, releaseTrain: undefined }), 'released');
  assert.equal(releaseState(open), null);
});

test('unit:failed-candidate-fixes-forward — a failing candidate leaves its items pending, files one fix-forward item naming the failing proofs and commit range, and the next passing candidate delivers them', () => {
  const original = merged(candidateItem('GY-920', ownProofs, ['unit:own-fast', 'manual:own-witness']), sha('2'));
  const other = merged(candidateItem('GY-921', ['unit:other'], ['unit:other']), sha('3'));
  const commits = [commit('3', 'GY-921', 78), commit('2', 'GY-920', 77)];
  const first = cutCandidate({ tip: sha('c'), now: new Date('2026-10-03T13:00:00.000Z'), trigger: 'schedule', latest: promotedCandidate, promoted: promotedCandidate, commits });
  assert.ok(first.cut);
  const failedCandidate = first.candidate;
  const uat = assessUat(failedCandidate, { deployedSha: failedCandidate.sha, now, suites: [
    { name: 'endpoints', passed: true, detail: 'ok' },
    { name: proofSuite('integration:own-contract'), passed: false, detail: '1 of 3 cases naming integration:own-contract failed (exit 1)' },
    { name: proofSuite('e2e:own-journey'), passed: true, detail: '2 cases passed' },
  ] });
  assert.equal(uat.result, 'failed');
  // One fix-forward item names the failing proof, the candidate SHA and the commit range since the last promoted candidate.
  const fix = followUpItem(failedCandidate, uat);
  assert.match(fix.title, /failed UAT proof integration:own-contract/);
  assert.match(fix.description, /Failing proofs: integration:own-contract\./);
  assert.match(fix.description, new RegExp(`Commit range: ${sha('0')}\\.\\.${sha('c')} \\(since promoted candidate ${promotedCandidate.id}\\)`));
  assert.match(fix.description, /GY-921 .*GY-920|GY-920.*GY-921/);
  assert.match(fix.description, /stay merged-pending-release and are not reworked or reverted/);
  assert.deepEqual(fix.policy, { checks: ['test', 'typecheck'], review: true });
  uat.followUp = 'GY-930';

  let work = apply(original, candidateReport(ledgerOf([failedCandidate], [uat]), failedCandidate));
  let peer = apply(other, candidateReport(ledgerOf([failedCandidate], [uat]), failedCandidate));
  // Pending, not reworked or reverted: stage, delivery and evidence are exactly the merge's.
  for (const [after, before] of [[work, original], [peer, other]] as const) {
    assert.equal(releaseState(after), 'merged-pending-release');
    assert.equal(after.stage, 'done');
    assert.deepEqual(after.delivery, before.delivery);
    assert.deepEqual(after.evidence, before.evidence);
    assert.equal(after.reworkRequested, false);
  }
  assert.deepEqual(work.releaseTrain!.candidate, { id: failedCandidate.id, sha: failedCandidate.sha, uat: 'failed', failing: ['proof integration:own-contract'], followUp: 'GY-930', promotedAt: null });
  assert.match(plainStatus(work, now.getTime()).sentence, /failed its checks; a fix is on the way and the next release carries this too/);
  assert.equal(plainStatus(work, now.getTime()).tone, 'waiting');
  assert.match(pendingReleases([work])[0].next, /GY-930 fixes forward and the next candidate carries it/);

  // The next candidate is measured from the last promoted one, so it carries both again, plus the fix;
  // only the proof that has not passed yet runs again.
  const fixCommit = { sha: sha('4'), subject: 'Merge pull request #79 from cryptob1/graphyard/gy-930-1', body: '' };
  const second = cutCandidate({ tip: sha('d'), now: new Date('2026-10-03T19:00:00.000Z'), trigger: 'schedule', latest: failedCandidate, promoted: promotedCandidate, commits: [fixCommit, ...commits] });
  assert.ok(second.cut);
  const next = second.candidate;
  assert.deepEqual(next.items.map(item => item.key), ['GY-930', 'GY-921', 'GY-920']);
  assert.deepEqual(candidateProofPlan(next, [work, peer]), [{ proof: 'integration:own-contract', suite: 'proof integration:own-contract', items: ['GY-920'] }]);
  const passed = assessUat(next, { deployedSha: next.sha, now, suites: [{ name: 'endpoints', passed: true, detail: 'ok' }, { name: proofSuite('integration:own-contract'), passed: true, detail: '3 cases passed' }] });
  const ledger = ledgerOf([next, failedCandidate], [passed, uat], [{ id: next.id, sha: next.sha, at: '2026-10-03T21:00:00.000Z' }]);
  work = apply(work, candidateReport(ledger, next));
  peer = apply(peer, candidateReport(ledger, next));
  assert.equal(releaseState(work), 'released');
  assert.equal(releaseState(peer), 'released');
  assert.deepEqual(work.releaseTrain!.first, { id: failedCandidate.id, sha: failedCandidate.sha });
  // Released is terminal: a late report of the failed candidate never moves it back.
  const late = applyCandidateReport(work, candidateReport(ledgerOf([failedCandidate], [uat]), failedCandidate), now);
  assert.equal(late.changed, false);
  assert.equal(late.train.state, 'released');
});

test('unit:failed-candidate-fixes-forward — a proof run passes only when a case naming it ran and none failed', () => {
  const proof = 'integration:own-contract';
  assert.deepEqual(proofRunResult(proof, 0, `ok 1 - ${proof} — passes\nok 2 - ${proof} — also passes\n`), { name: `proof ${proof}`, passed: true, detail: `2 cases naming ${proof} passed` });
  assert.equal(proofRunResult(proof, 0, 'ok 1 - unit:something else\n').passed, false, 'matching nothing is not a pass');
  assert.equal(proofRunResult(proof, 0, `ok 1 - ${proof} # SKIP test name patterns\n`).passed, false);
  assert.equal(proofRunResult(proof, 1, `ok 1 - ${proof} a\nnot ok 2 - ${proof} b\n`).passed, false);
});
