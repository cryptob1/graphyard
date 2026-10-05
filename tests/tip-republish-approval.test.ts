import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHub } from '../src/github.js';
import { dismissedApproval, queueRef, reviewDismissal, type QueueSpeculation } from '../src/merge-queue.js';
import type { Observation, Work } from '../src/model.js';

// Each test is named for the proof it produces: unit:self-dismissed-approval-restored (GY-519 AC-2).
// The merge queue no longer places entries (GitHub delivery merges on CI and review), so the
// republication flows GY-519's other proofs drove through it are gone; what remains is the
// restore rule itself, read from the timeline and applied to a hand-built queued record.

const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const treeOf = (sha: string) => sha40(`7${sha.slice(0, 2)}`);
const MAIN1 = sha40('e1'), MAIN2 = sha40('e2');
const H = sha40('1a'), A = sha40('2a'), B = sha40('2b'), C = sha40('2c');
const reviewer = 'graphyard-reviewer[bot]';
const X1 = 1002;
const at = '2026-09-26T08:00:00.000Z';

const github = new GitHub({ repository: 'owner/project', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used-in-adapter-test' });
github.controlPlaneLogin = async () => 'graphyard[bot]';

function observation(work: Work, candidate: { sha: string; baseSha: string }, overrides: Partial<Observation> = {}): Observation {
  const base: Observation = { clockOffset: { min: 0, max: 0 }, candidate: { ...candidate, pr: work.submission!.pr, branch: work.workspaces[0].branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null, prState: 'open', draft: false,
    baseTip: candidate.baseSha, baseTree: treeOf(candidate.baseSha), baseTipContained: true, files: ['src/tip.ts'], scopeFiles: [], at: new Date().toISOString(), ...overrides };
  const reviews = base.reviews ?? [];
  if (reviews.every(entry => Number.isSafeInteger(entry.id) && entry.id! > 0)) base.reviewIds = reviews.map(entry => entry.id as number);
  return base;
}

test('unit:self-dismissed-approval-restored — a dismissal the control plane\'s own republication made is restored across the head change, and never for a moved author head, a changed patch, or anyone else\'s dismissal or push', async () => {
  // The timeline facts the observation collects: GitHub's merge-base dismissals and the force-pushes, each named as the App's or not.
  github.request = (async (path: string) => {
    if (/^\/issues\/\d+\/timeline/.test(path)) return [
      { event: 'review_dismissed', actor: { login: 'graphyard[bot]' }, created_at: at, dismissed_review: { review_id: X1, dismissal_message: 'The merge-base changed after approval.', state: 'approved', dismissal_commit_id: B } },
      { event: 'head_ref_force_pushed', actor: { login: 'graphyard[bot]' }, created_at: at, before: A, after: B },
      { event: 'review_dismissed', actor: { login: 'alice' }, created_at: at, dismissed_review: { review_id: 2003, dismissal_message: 'The merge-base changed after approval.', state: 'approved', dismissal_commit_id: B } },
      { event: 'head_ref_force_pushed', actor: { login: 'alice' }, created_at: at, before: B, after: C },
    ];
    throw new Error(`Unexpected request ${path}`);
  }) as typeof github.request;
  const dismissals = await github.reviewDismissals(700);
  assert.equal(dismissals.unread, null);
  assert.equal(dismissals.read.get(X1)?.mergeBase, true);
  assert.equal(dismissals.read.get(X1)?.byApp, true, 'the App\'s own dismissal is named as its own');
  assert.equal(dismissals.read.get(2003)?.byApp, false, 'a person\'s dismissal is not the App\'s');
  assert.deepEqual(dismissals.forcePushes.map(entry => [entry.before, entry.after, entry.byApp]), [[A, B, true], [B, C, false]]);

  // The republication race: the approval of tip A landed between the pre-push read and the
  // force-push, so tip B's carry carries none of it; the dismissed approval, read from the timeline
  // as the App's own, restores it as the binding one, carried from A to B.
  const speculation: QueueSpeculation = { ref: queueRef('GY-9'), tip: B, tipTree: treeOf(B), base: MAIN2, baseTree: treeOf(MAIN2), predecessors: [], policyRevision: 1, publishedAt: at, reviewedHead: H,
    merge: { from: H, parents: [H, MAIN2], author: 'graphyard[bot]', authoredByApp: true, conflicts: false, baseChanges: ['docs/other.md'], diff: { reviewed: 'patch-1', tip: 'patch-1' } },
    carry: { from: { sha: H, baseSha: MAIN1 }, to: { sha: B, baseSha: MAIN2 }, policyRevision: 1, at, predecessor: 'base branch', changedFiles: ['docs/other.md'], reviewedFiles: ['src/tip.ts'],
      approval: { carried: false, reason: 'no approval was bound to the replaced head' }, evidence: [], ground: { rule: 'diff unchanged', patchId: 'patch-1', tipPatchId: 'patch-1' } } };
  const dismissedReview = { id: X1, reviewer, sha: A, state: 'DISMISSED', submittedAt: at,
    dismissal: { reason: 'The merge-base changed after approval.', mergeBase: true, verdict: 'approved' as const, commit: B, at, by: 'graphyard[bot]', byApp: true } };
  assert.equal(reviewDismissal(dismissedReview)?.byApp, true);

  // Each negative: restore is refused when the author head moved, the patch changed, the push or
  // the dismissal was not the App's, or no App push chain leads from the approved tip.
  const candidate = { sha: B, baseSha: MAIN2, pr: 700, branch: 'graphyard/gy-9-1', author: 'implementer' };
  const shaped = (overrides: { historyFrom?: string; ground?: 'diff unchanged' | 'diff changed'; pushes?: { byApp: boolean; before: string; after: string }[]; dismissalByApp?: boolean }): Work => ({
    key: 'GY-9', policy: { checks: ['test'], review: true, reviewProvider: 'github' }, policyRevision: 1, submission: { epoch: 1, pr: 700 }, reworkRequested: false, candidate,
    queue: { sequence: 9, enqueuedAt: at, policyRevision: 1, speculation: { ...speculation,
      carry: { ...speculation.carry!, ground: { rule: overrides.ground ?? 'diff unchanged', patchId: 'patch-1', tipPatchId: 'patch-1' } } } },
    queueHistory: [{ at, event: 'predicted' as const, sequence: 9, tip: A, predecessors: [], from: overrides.historyFrom ?? H }, { at, event: 'predicted' as const, sequence: 9, tip: B, predecessors: [], from: H }],
    observation: { ...observation({ submission: { epoch: 1, pr: 700 }, workspaces: [{ host: 'h', path: '/w', branch: 'graphyard/gy-9-1', epoch: 1, owner: 'w' }] } as Work, candidate),
      reviews: [{ ...dismissedReview, dismissal: { ...dismissedReview.dismissal, byApp: overrides.dismissalByApp ?? true } }] as unknown as NonNullable<Work['observation']>['reviews'],
      headForcePushes: (overrides.pushes ?? [{ byApp: true, before: A, after: B }]).map(entry => ({ at, by: entry.byApp ? 'graphyard[bot]' : 'alice', byApp: entry.byApp, before: entry.before, after: entry.after })) },
  } as unknown as Work);
  assert.ok(dismissedApproval(shaped({}))!.originalSha === A, 'sanity: the positive shape restores');
  assert.equal(dismissedApproval(shaped({ historyFrom: sha40('h9') })), null, 'the author head moved under the approved tip: nothing restores');
  assert.equal(dismissedApproval(shaped({ ground: 'diff changed' })), null, 'the patch changed since the approval: nothing restores');
  assert.equal(dismissedApproval(shaped({ dismissalByApp: false })), null, 'a person dismissed the approval: nothing restores');
  assert.equal(dismissedApproval(shaped({ pushes: [{ byApp: false, before: A, after: B }] })), null, 'a person force-pushed the tip away: nothing restores');
  assert.equal(dismissedApproval(shaped({ pushes: [] })), null, 'no App push chain leads from the approved tip: nothing restores');
  // The unchanged-head restore keeps its own shape: the approval of the head itself, no originalSha.
  const unchanged = dismissedApproval({ ...shaped({ dismissalByApp: false }), observation: { ...observation({ submission: { epoch: 1, pr: 700 }, workspaces: [{ host: 'h', path: '/w', branch: 'graphyard/gy-9-1', epoch: 1, owner: 'w' }] } as Work, candidate), reviews: [{ ...dismissedReview, sha: B, dismissal: { ...dismissedReview.dismissal, byApp: false } }] as unknown as NonNullable<Work['observation']>['reviews'] } } as unknown as Work)!;
  assert.deepEqual({ reviewer: unchanged.reviewer, reviewId: unchanged.reviewId, sha: unchanged.sha, originalSha: unchanged.originalSha ?? null }, { reviewer, reviewId: X1, sha: B, originalSha: null });
});
