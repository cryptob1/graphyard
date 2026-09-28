import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ejectionReason } from '../src/merge-queue.js';
import { requiredProofs } from '../src/model/bootstrap.js';
import { attestationDecision } from '../src/daemon/decisions.js';
import type { Evidence, Observation, Work } from '../src/model.js';

// GY-917, the P1 and P2 follow-ups from the review of GY-910 (PR #482). GY-910 held a trusted
// `manual:` record with executed = 0 out of the merge queue's ejections only when a criterion of
// the item itself named the proof: for a proof inherited from a bootstrap obligation nothing
// requested the attestation (attestationDecision returned null without a local criterion, and the
// attest precondition refused one), so the entry was ejected into a strand nothing could answer —
// the proof group's failed state refused a producer relaunch, proofRework excluded the finding and
// the ejection record barred the same candidate from re-entering. The attestation path now routes
// the inherited criterion (attestationDecision names the obligation, the attest precondition
// accepts a proof the ledger requires, the exercise record covers it), so the hold no longer
// narrows: every unexecuted `manual:` record holds its entry for an attestation the loop can
// request. And superseded evidence decides nothing: a trusted pass appended for the same candidate
// is the record currentEvidence selects — the one the acceptance and producer paths already read —
// so the earlier failure no longer ejects or holds the already-proven entry.

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

test('unit:queue-holds-inherited-manual-for-attestation — an inherited manual record with executed = 0 holds for the attestation the loop now requests', () => {
  const all = [deferringItem(), inheritingItem({}, [{ id: 'AC-1', text: 'The queue tests pass', proofs: [UNIT] }])];
  const work = bound(all[1]);
  // The scenario is the reviewer's, not a synthetic one: the proof reaches the item only through
  // the bootstrap obligation its planned files touch.
  assert.ok(inheritedCriteria(work, all), 'the manual proof is inherited from the bootstrap obligation');
  // GY-917: the attestation is requested for the inherited proof, naming its obligation — the
  // answerability the queue's hold rests on.
  assert.equal(attestationDecision(work)?.input?.proof, MANUAL, 'the attestation of the inherited record is requested');
  assert.match(attestationDecision(work)!.reason, /inherited obligation/, 'the reason names the inherited obligation the local criteria do not');
  // The entry is held for that attestation, not ejected into the strand GY-910's narrowing made.
  assert.equal(ejectionReason(work, ciAppIds, all), null, 'an inherited executed = 0 record holds the entry');
  assert.equal(ejectionReason(work, ciAppIds), null, 'the hold reads the item alone, as the attestation request does');

  // GY-875 keeps its ground where it always worked: the same executed = 0 record on a proof the
  // item names itself holds the entry for the attestation the loop requests, naming the criterion.
  const local = bound(inheritingItem({}, [{ id: 'AC-1', text: 'The follow-ups are triaged', proofs: [MANUAL] }, { id: 'AC-2', text: 'The queue tests pass', proofs: [UNIT] }]));
  assert.equal(ejectionReason(local, ciAppIds, [local]), null, 'an attestable record still holds the entry');
  assert.equal(attestationDecision(local)?.input?.proof, MANUAL, 'the hold is answered by the attestation of that record');
  assert.match(attestationDecision(local)!.reason, /AC-1/, 'the reason names the local criterion');
});

test('unit:queue-ejects-inherited-judged-manual — a judged inherited failure ejects as before', () => {
  const all = [deferringItem(), inheritingItem({}, [{ id: 'AC-1', text: 'The queue tests pass', proofs: [UNIT] }])];
  // A record the producer judged with cases executed is a failure of the change (GY-868) whether
  // or not any criterion names it, and ejects exactly as before.
  const judged = bound(inheritingItem({ executed: 3 }, [{ id: 'AC-1', text: 'The queue tests pass', proofs: [UNIT] }]));
  assert.match(ejectionReason(judged, ciAppIds, [judged])!, new RegExp(`Proof ${MANUAL} failed on speculative tip`));
  assert.match(ejectionReason(judged, ciAppIds)!, new RegExp(`Proof ${MANUAL} failed on speculative tip`), 'the ejection does not depend on the ledger slice');
});

test('unit:queue-ignores-superseded-manual-failure — a trusted pass appended for the same candidate answers the earlier failure', () => {
  // GY-917 P2: currentEvidence takes the last applicable record, so the acceptance and producer
  // paths already read the pass; the ejection check must too, or it ejects a proven candidate on
  // the record it replaced — ejected, held, either way the strand the finding names.
  const superseded = bound(inheritingItem({ id: 'e1' }, [{ id: 'AC-1', text: 'The follow-ups are triaged', proofs: [MANUAL] }], {
    evidence: [
      { id: 'e1', proof: MANUAL, sha: head, baseSha: base, policyRevision: 1, result: 'fail' as const, executed: 0, skipped: 0, producer: 'trusted-producer', trusted: true, at },
      { id: 'e2', proof: MANUAL, sha: head, baseSha: base, policyRevision: 1, result: 'pass' as const, executed: 0, skipped: 0, producer: 'attester', trusted: true, at: '2026-09-28T01:00:00.000Z' },
    ],
  })) as Work;
  assert.equal(ejectionReason(superseded, ciAppIds, [superseded]), null, 'the superseded failure neither ejects nor holds the proven entry');
  // The same answer holds for a judged failure the attestation later overturned.
  const judgedSuperseded = bound(inheritingItem({ id: 'e1', executed: 3 }, [{ id: 'AC-1', text: 'The queue tests pass', proofs: [UNIT] }], {
    evidence: [
      { id: 'e1', proof: MANUAL, sha: head, baseSha: base, policyRevision: 1, result: 'fail' as const, executed: 3, skipped: 0, producer: 'trusted-producer', trusted: true, at },
      { id: 'e2', proof: MANUAL, sha: head, baseSha: base, policyRevision: 1, result: 'pass' as const, executed: 2, skipped: 0, producer: 'attester', trusted: true, at: '2026-09-28T01:00:00.000Z' },
    ],
  })) as Work;
  assert.equal(ejectionReason(judgedSuperseded, ciAppIds, [judgedSuperseded]), null, 'a newer trusted pass decides, exactly as the test gate reads the newest run');
  // A failure with nothing after it is still adverse: supersession never excuses what it cannot see.
  const current = bound(inheritingItem({ executed: 3 }, [{ id: 'AC-1', text: 'The queue tests pass', proofs: [UNIT] }]));
  assert.match(ejectionReason(current, ciAppIds, [current])!, new RegExp(`Proof ${MANUAL} failed on speculative tip`));
});
