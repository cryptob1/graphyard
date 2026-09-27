import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ejectionReason } from '../src/merge-queue.js';
import { mechanicalVerdicts, producerManualFailures } from '../src/model/mechanical-proofs.js';
import { attestationDecision } from '../src/daemon/decisions.js';
import type { Evidence, Observation, Work } from '../src/model.js';

// GY-875. After GY-868 (c1282d8c76) a trusted `manual:` record with executed = 0 is an unexercised
// finding, answered by attestationDecision (GY-523), never rework — but `ejectionReason` still
// ejected on any trusted evidence with result 'fail' bound to the candidate. Nine follow-up items
// (GY-463, 469, 515, 634, 638, 756, 767, 794 and others) were ejected every cycle with
// "Proof manual:review-followups-triaged failed on speculative tip <head>", and each ejection
// asked for a new head no rework would ever be requested for, so the items cycled between merge
// and ejection without landing. The queue now reads such a record exactly as the gates do: it is
// no failure of the change, so the entry is held for its attestation instead of ejected.

const head = 'a'.repeat(40), base = 'b'.repeat(40), at = '2026-09-27T00:00:00.000Z';
const ciAppIds = [15368];
const MANUAL = 'manual:review-followups-triaged';
const UNIT = 'unit:queue-unexercised-manual-guard';

function observation(work: Work, overrides: Partial<Observation> = {}): Observation {
  return {
    candidate: { ...work.candidate! }, checks: [{ name: 'test', result: 'success', appId: 15368 }],
    reviews: [{ reviewer: 'reviewer', sha: work.candidate!.sha, state: 'APPROVED' }],
    merged: false, mergeSha: null, mergeable: true, protected: true, prState: 'open', draft: false,
    baseTip: base, files: ['src/followups.ts'], scopeFiles: [], at, conversations: { required: true, unresolved: [] }, ...overrides,
  } as unknown as Observation;
}

function item(evidence: Partial<Evidence>, extra: Partial<Work> = {}): Work {
  const candidate = { sha: head, baseSha: base, pr: 901, branch: 'graphyard/gy-901-1', author: 'worker' };
  return {
    id: 'gy-901', key: 'GY-901', title: 'Follow-up triage', description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Review follow-ups are triaged', proofs: [MANUAL] }, { id: 'AC-2', text: 'The queue tests pass', proofs: [UNIT] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/'], stage: 'merge', revision: 4, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [], candidate,
    submission: { epoch: 1, pr: 901 }, reworkRequested: false, scenarioRequirements: [], blocker: null, gates: [], violations: [],
    producerProofs: [MANUAL],
    evidence: [{ id: 'e1', proof: MANUAL, sha: head, baseSha: base, policyRevision: 1, result: 'fail' as const, executed: 0, skipped: 0, producer: 'trusted-producer', trusted: true, at, ...evidence }],
    queue: { sequence: 1, enqueuedAt: at, policyRevision: 1, speculation: { ref: 'refs/graphyard/queue/GY-901', tip: head, base, baseTree: base, predecessors: [], policyRevision: 1, publishedAt: at } },
    queueSequence: 1,
    observation: null,
    ...extra,
  } as unknown as Work;
}

function bound(item: Work): Work {
  item.observation = observation(item);
  return item;
}

const gatesReportFailure = (work: Work) =>
  mechanicalVerdicts(work, [work], new Date(at)).some(verdict => verdict.outcome === 'failed') || producerManualFailures(work, [work], new Date(at)).length > 0;
const queueNamesProofFailure = (work: Work) => /Proof \S+ failed on speculative tip/.test(ejectionReason(work, ciAppIds) ?? '');

test('unit:queue-keeps-unexercised-manual — an unexercised manual record holds the entry for its attestation; a judged manual failure and a failed unit proof still eject', () => {
  // A trusted manual: record with executed = 0 judged nothing (GY-868): the entry is held, not
  // ejected, and the wait it is held for is the attestation the loop requests for that record.
  const unexercised = bound(item({}));
  assert.equal(ejectionReason(unexercised, ciAppIds), null, 'an unexercised manual record ejects nothing');
  const attestation = attestationDecision(unexercised);
  assert.equal(attestation?.action, 'attest', 'the held entry waits for the attestation of that record');
  assert.equal(attestation?.input?.proof, MANUAL);

  // A manual: record the producer judged with cases executed is a failure of the change (GY-868)
  // and ejects exactly as before.
  const judged = bound(item({ executed: 3 }));
  assert.match(ejectionReason(judged, ciAppIds)!, new RegExp(`Proof ${MANUAL} failed on speculative tip`));

  // A failed unit: proof ejects exactly as before.
  const unit = bound(item({ proof: UNIT, executed: 2 }));
  assert.match(ejectionReason(unit, ciAppIds)!, new RegExp(`Proof ${UNIT} failed on speculative tip`));
});

test('unit:queue-and-gates-agree-on-proof-failures — ejectionReason names a proof failure exactly when mechanicalVerdicts or producerManualFailures report one', () => {
  const cases: [string, Partial<Evidence>][] = [
    ['manual executed 0', { proof: MANUAL, result: 'fail', executed: 0 }],
    ['manual executed > 0', { proof: MANUAL, result: 'fail', executed: 3 }],
    ['unit failed', { proof: UNIT, result: 'fail', executed: 2 }],
    ['unit passed', { proof: UNIT, result: 'pass', executed: 4, skipped: 0 }],
  ];
  for (const [name, evidence] of cases) {
    const work = bound(item(evidence));
    const gates = gatesReportFailure(work), queue = queueNamesProofFailure(work);
    assert.equal(queue, gates, `${name}: the queue and the acceptance gate disagree (gates ${gates}, queue ${queue})`);
  }
  // And each side reads the four records as the criteria say it must.
  assert.equal(queueNamesProofFailure(bound(item({ proof: MANUAL, result: 'fail', executed: 0 }))), false, 'manual executed 0 is not a failure');
  assert.equal(queueNamesProofFailure(bound(item({ proof: MANUAL, result: 'fail', executed: 3 }))), true, 'a judged manual failure is');
  assert.equal(queueNamesProofFailure(bound(item({ proof: UNIT, result: 'fail', executed: 2 }))), true, 'a failed unit proof is');
  assert.equal(queueNamesProofFailure(bound(item({ proof: UNIT, result: 'pass', executed: 4, skipped: 0 }))), false, 'a passing unit proof is not');
});
