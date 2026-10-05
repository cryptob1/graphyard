import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Observation, Work } from '../src/model.js';
import { mergeBaseDismissal, missingBaseAncestry } from '../src/merge-base-ancestry.js';
import { buildMasterStatus } from '../src/master.js';

// GY-145. The test is named for the proof it produces: unit:merge-base-dismissal-reported.

const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
// P: the base the head was built on. M: the base branch tip now, tree-identical to P but not an
// ancestor of the head (the predecessor landed as a new commit). TIP: the candidate head.
const P = sha40('c1'), M = sha40('c2'), TIP = sha40('d1'), TREE = sha40('7e1');
const at = '2026-09-23T10:00:00.000Z';
const PR = 116;
const reviewer = 'graphyard-reviewer[bot]';

function candidateAt(observation: Partial<Observation> = {}): Work {
  const candidate = { sha: TIP, baseSha: P, pr: PR, branch: 'graphyard/gy-100-1', author: 'implementer' };
  return { id: 'work-100', key: 'GY-100', title: 'Candidate head', description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'x', proofs: ['unit:x'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' },
    stage: 'merge', revision: 9, policyRevision: 4, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null,
    workspaces: [], candidate, submission: { epoch: 1, pr: PR }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [],
    gates: [{ name: 'ready', passed: true, reasons: [] }],
    observation: { candidate: { ...candidate }, checks: [], reviews: [{ id: 31, reviewer, sha: TIP, state: 'APPROVED', submittedAt: at }], merged: false, mergeSha: null, mergeable: true, protected: true,
      files: ['src/x.ts'], scopeFiles: [], at, prState: 'open', draft: false, baseTip: M, baseTree: TREE, baseTipContained: true, baseTipAncestor: false, ...observation },
  } as Work;
}

test('unit:merge-base-dismissal-reported — an approval GitHub dismissed for a merge-base change is an attention item naming the dismissal time and the commits', () => {
  const dismissedAt = '2026-09-23T10:05:00.000Z';
  const item = candidateAt({ reviews: [{ id: 31, reviewer, sha: TIP, state: 'DISMISSED', submittedAt: at,
    dismissal: { reason: 'The merge-base changed after approval.', mergeBase: true, verdict: 'approved', commit: M, at: dismissedAt, by: null } } as Observation['reviews'][number]] });
  assert.deepEqual(missingBaseAncestry(item), { head: TIP, baseTip: M, boundBase: P });
  const dismissal = mergeBaseDismissal(item);
  assert.deepEqual(dismissal && [dismissal.reviewer, dismissal.reviewId, dismissal.sha, dismissal.at, dismissal.commit, dismissal.baseTip, dismissal.boundBase], [reviewer, 31, TIP, dismissedAt, M, M, P]);
  const status = buildMasterStatus({ work: [item], now: dismissedAt }, [], []);
  const entry = status.attentionItems.find(line => line.subject === 'GY-100');
  assert.ok(entry, 'the dismissal is an attention item against the item');
  assert.match(entry.text, new RegExp(`^GY-100: GitHub dismissed ${reviewer.replace(/[[\]]/g, '\\$&')}'s approval of ${TIP.slice(0, 12)} \\(review #31\\) at ${dismissedAt} for a merge-base change attributed to commit ${M.slice(0, 12)}; bound base ${P.slice(0, 12)}, base branch tip ${M.slice(0, 12)}\\.`));
  assert.match(entry.text, /does not contain base branch tip .* by ancestry/);
  assert.match(entry.text, /; a fresh review of the head is requested$/);
  assert.equal(entry.role, 'master');
  assert.equal(status.work.find(row => row.key === 'GY-100')!.attention, entry.text);
  // A change request someone dismissed, or a dismissal with a person's reason, is not reported as one.
  const withdrawn = candidateAt({ reviews: [{ id: 32, reviewer, sha: TIP, state: 'DISMISSED', submittedAt: at, dismissal: { reason: 'merge base moved, will re-review', mergeBase: false, verdict: 'approved', commit: null, at: dismissedAt, by: 'someone' } } as Observation['reviews'][number]] });
  assert.equal(mergeBaseDismissal(withdrawn), null);
  // An observation from before GY-145 carries no ancestry answer and reports none missing.
  assert.equal(missingBaseAncestry(candidateAt({ baseTipAncestor: undefined })), null);
  // A head that contains the base tip says the approval is restored as the binding one.
  const contained = candidateAt({ baseTipAncestor: true, reviews: item.observation!.reviews });
  assert.match(mergeBaseDismissal(contained) ? buildMasterStatus({ work: [contained], now: dismissedAt }, [], []).attentionItems.find(line => line.subject === 'GY-100')!.text : '', /The head contains .* so the approval is restored as the binding one$/);
});
