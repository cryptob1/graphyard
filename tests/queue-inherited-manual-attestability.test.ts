import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ejectionReason } from '../src/merge-queue.js';
import { requiredProofs } from '../src/model/bootstrap.js';
import { attestationDecision } from '../src/daemon/decisions.js';
import type { Evidence, Observation, Work } from '../src/model.js';

// GY-910, the P1 follow-up from the review of GY-875 (PR #461): the GY-875 hold exempts every
// trusted `manual:` record with executed = 0 from ejection, but the attestation it is held for is
// requested only for a proof a criterion of the item itself names (attestationDecision,
// attestationExercise). A producer-runnable `manual:` proof inherited from a bootstrap obligation
// is named by no local criterion, so for it attestationDecision returns null, proofRework excludes
// every unexercised manual finding, and the proof group's failed state refuses a producer relaunch:
// the held entry and every entry behind it were queued forever. The hold now exempts only a proof
// the item can attest locally; any other executed = 0 record is the adverse conclusion it reads as
// and ejects, so the order moves.

const head = 'a'.repeat(40), base = 'b'.repeat(40), at = '2026-09-28T00:00:00.000Z';
const ciAppIds = [15368];
const MANUAL = 'manual:review-followups-triaged';
const UNIT = 'unit:queue-inherited-manual-attestability-guard';

function observation(work: Work, overrides: Partial<Observation> = {}): Observation {
  return {
    candidate: { ...work.candidate! }, checks: [{ name: 'test', result: 'success', appId: 15368 }],
    reviews: [{ reviewer: 'reviewer', sha: work.candidate!.sha, state: 'APPROVED' }],
    merged: false, mergeSha: null, mergeable: true, protected: true, prState: 'open', draft: false,
    baseTip: base, files: ['src/followups.ts'], scopeFiles: [], at, conversations: { required: true, unresolved: [] }, ...overrides,
  } as unknown as Observation;
}

function queueEntry(): Work['queue'] {
  return { sequence: 1, enqueuedAt: at, policyRevision: 1, speculation: { ref: 'refs/graphyard/queue/GY-901', tip: head, base, baseTree: base, predecessors: [], policyRevision: 1, publishedAt: at } };
}

function inheritingItem(evidence: Partial<Evidence>, criteria: Work['criteria'], extra: Partial<Work> = {}): Work {
  const candidate = { sha: head, baseSha: base, pr: 910, branch: 'graphyard/gy-910-1', author: 'worker' };
  return {
    id: 'gy-910', key: 'GY-910', title: 'Inherited follow-up triage', description: '', type: 'bug', priority: 0, dependencies: [],
    criteria, policy: { checks: ['test'], review: true }, plannedFiles: ['src/'], stage: 'merge', revision: 4, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [], candidate,
    submission: { epoch: 1, pr: 910 }, reworkRequested: false, scenarioRequirements: [], blocker: null, gates: [], violations: [],
    producerProofs: [MANUAL],
    evidence: [{ id: 'e1', proof: MANUAL, sha: head, baseSha: base, policyRevision: 1, result: 'fail' as const, executed: 0, skipped: 0, producer: 'trusted-producer', trusted: true, at, ...evidence }],
    queue: queueEntry(),
    queueSequence: 1,
    observation: null,
    ...extra,
  } as unknown as Work;
}

/** The item whose bootstrap criterion deferred the proof onto the src/ contract and has not proven it. */
function deferringItem(): Work {
  const candidate = { sha: '1'.repeat(40), baseSha: '2'.repeat(40), pr: 900, branch: 'graphyard/gy-900-1', author: 'worker' };
  return {
    id: 'gy-900', key: 'GY-900', title: 'The deferring change', description: '', type: 'chore', priority: 0, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'The harness follow-ups are triaged', proofs: [MANUAL],
      bootstrap: { reason: 'the harness this proof needs is introduced by this change', contractPaths: ['src/'], declaredBy: 'operator', declaredAt: at, policyRevision: 1 } }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['docs/'], stage: 'merge', revision: 2, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [], candidate,
    submission: { epoch: 1, pr: 900 }, reworkRequested: false, scenarioRequirements: [], blocker: null, gates: [], violations: [],
    producerProofs: [], evidence: [], queue: queueEntry(), queueSequence: 0, observation: null,
  } as unknown as Work;
}

const bound = (work: Work): Work => { work.observation = observation(work); return work; };
const inheritedCriteria = (work: Work, all: Work[]) => requiredProofs(work, all).includes(MANUAL);

test('unit:queue-ejects-unattestable-inherited-manual — an inherited manual record no criterion names ejects; the same record on a locally named proof is still held', () => {
  const all = [deferringItem(), inheritingItem({}, [{ id: 'AC-1', text: 'The queue tests pass', proofs: [UNIT] }])];
  const work = bound(all[1]);
  // The scenario is the reviewer's, not a synthetic one: the proof reaches the item only through
  // the bootstrap obligation its planned files touch.
  assert.ok(inheritedCriteria(work, all), 'the manual proof is inherited from the bootstrap obligation');
  // Nothing can answer the record at the item: the attestation path names no criterion for it,
  // which is exactly why the queue must not hold the entry for that attestation.
  assert.equal(attestationDecision(work), null, 'no attestation can be requested for a proof no local criterion names');
  assert.match(ejectionReason(work, ciAppIds, all)!, new RegExp(`Proof ${MANUAL} failed on speculative tip`), 'an unattestable inherited record ejects the entry');

  // GY-875 keeps its ground where the hold can be answered: the same executed = 0 record on a
  // proof the item names itself holds the entry for the attestation the loop requests.
  const local = bound(inheritingItem({}, [{ id: 'AC-1', text: 'The follow-ups are triaged', proofs: [MANUAL] }, { id: 'AC-2', text: 'The queue tests pass', proofs: [UNIT] }]));
  assert.equal(ejectionReason(local, ciAppIds, [local]), null, 'an attestable record still holds the entry');
  assert.equal(attestationDecision(local)?.input?.proof, MANUAL, 'the hold is answered by the attestation of that record');
});

test('unit:queue-ejects-inherited-carried-manual — a carried inherited manual record ejects too, and a judged failure ejects as before', () => {
  const all = [deferringItem(), inheritingItem({}, [{ id: 'AC-1', text: 'The queue tests pass', proofs: [UNIT] }])];
  // A record the producer judged with cases executed is a failure of the change (GY-868) whether
  // or not any criterion names it, and ejects exactly as before.
  const judged = bound(inheritingItem({ executed: 3 }, [{ id: 'AC-1', text: 'The queue tests pass', proofs: [UNIT] }]));
  assert.match(ejectionReason(judged, ciAppIds, [judged])!, new RegExp(`Proof ${MANUAL} failed on speculative tip`));
  // The inherited case ejects with or without the deferring item in view: the predicate reads the
  // item's own criteria, so the hold and the attestation path cannot diverge again.
  const work = bound(all[1]);
  assert.match(ejectionReason(work, ciAppIds)!, new RegExp(`Proof ${MANUAL} failed on speculative tip`), 'the ejection does not depend on the ledger slice');
});
