import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Observation, Work } from '../src/model.js';
import * as reviewConflicts from '../src/model/review-conflict.js';
import { openReviewConflict, reconcileReviewConflict, reviewConflictAttention, type ReviewConflict } from '../src/model/review-conflict.js';
import { agentRequestAttention } from '../src/cli/loop-report.js';
import type { AgentRequest } from '../src/model/agent-requests.js';

// GY-1364: on 2026-10-06 master status listed review-conflict lines for GY-100 (head e9a5521c608c,
// PR #116) and GY-947 (head f68b3e9ef5be, PR #521), both delivered, and a note on GY-1318, also
// Done, "decided by nobody". No action could clear any of them. Each test is named for its proof.
// `settledReviewConflict` is read through a namespace so the file loads on a base that lacks it.

const settledReviewConflict = (item: Work): string | null => {
  assert.equal(typeof reviewConflicts.settledReviewConflict, 'function', 'settledReviewConflict is exported');
  return reviewConflicts.settledReviewConflict(item);
};

const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('e9a5521c608c'), B = sha40('b1'), H2 = sha40('c2');
const reviewer = 'graphyard-reviewer[bot]';
const now = '2026-10-06T10:00:00.000Z';

function observation(sha: string, reviews: Observation['reviews'] = []): Observation {
  return { candidate: { sha, baseSha: B, pr: 116, branch: 'graphyard/gy-100-1', author: 'implementer' }, checks: [], reviews, merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/a.ts'], scopeFiles: [], at: now, prState: 'open', draft: false, baseTip: B, baseTree: sha40('7b'), baseTipContained: true };
}
function work(overrides: Partial<Work> = {}): Work {
  const candidate = { sha: H, baseSha: B, pr: 116, branch: 'graphyard/gy-100-1', author: 'implementer' };
  return { id: 'work-100', key: 'GY-100', title: 'Dismissed review match', description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Review', proofs: ['unit:x'] }], policy: { checks: [], review: true, reviewProvider: 'github' }, stage: 'review', revision: 7, policyRevision: 3,
    createdAt: now, updatedAt: now, stageEnteredAt: now, ready: true, epoch: 1, lease: null,
    workspaces: [], candidate, submission: { epoch: 1, pr: 116 }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: observation(H), blocker: null,
    gates: [], violations: [], ...overrides } as Work;
}
const conflict = (sha: string): ReviewConflict => ({ state: 'conflicted', key: 'GY-100', pr: 116, sha, baseSha: B, policyRevision: 3, reviewer, requestId: 'req-1',
  verdicts: [{ id: 501, reviewer, state: 'APPROVED', submittedAt: '2026-09-23T08:00:00Z', observedAt: now, requestId: 'req-1' }, { id: 502, reviewer, state: 'CHANGES_REQUESTED', submittedAt: '2026-09-23T08:01:00Z', observedAt: now, requestId: 'req-1' }],
  at: now, reason: 'two verdicts' });

test('unit:delivered-review-conflict-settled — a conflict on a Done item or on a head the item left is not attention; one on the live head still is and still withholds both verdicts', () => {
  const delivered = work({ stage: 'done', reviewConflict: conflict(H) });
  assert.match(settledReviewConflict(delivered)!, /e9a5521c608c was delivered/);
  assert.deepEqual(reviewConflictAttention([delivered], []), []);

  const moved = work({ key: 'GY-947', candidate: { sha: H2, baseSha: B, pr: 521, branch: 'graphyard/gy-947-2', author: 'implementer' }, reviewConflict: conflict(H) });
  assert.match(settledReviewConflict(moved)!, /left e9a5521c608c/);
  assert.deepEqual(reviewConflictAttention([moved], []), []);
  // The conflict itself stays on the record: settled for attention, not erased.
  assert.equal(openReviewConflict(delivered)?.sha, H);

  // A live conflict on the current head is raised (and counted, since counts.reviewConflicts is this list's length).
  const live = work({ reviewConflict: conflict(H), autoDispatch: { review: null, history: [{ kind: 'review', id: 'req-1', sha: H }], producers: [] } as unknown as Work['autoDispatch'] });
  assert.equal(settledReviewConflict(live), null);
  const lines = reviewConflictAttention([delivered, moved, live], []);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].subject, 'GY-100');
  assert.match(lines[0].text, /head e9a5521c608c \(PR #116\) is conflicted/);
  // It still blocks acting on either verdict: both are withheld from what the gates read.
  live.observation = observation(H, [{ id: 501, reviewer, sha: H, state: 'APPROVED', submittedAt: '2026-09-23T08:00:00Z' }, { id: 502, reviewer, sha: H, state: 'CHANGES_REQUESTED', submittedAt: '2026-09-23T08:01:00Z' }]);
  reconcileReviewConflict(live, new Date(now));
  assert.equal(openReviewConflict(live)?.state, 'conflicted');
  assert.deepEqual(live.observation!.reviews, []);
});

test('unit:delivered-note-not-attention — a note on a Done item raises nothing; open asks with a named decider are raised on any item', () => {
  const request = (type: AgentRequest['type'], decider: AgentRequest['decider'], epoch = 6): AgentRequest => ({ id: `${type}-1`, type, epoch, requestedBy: 'graphyard-claude-1', at: '2026-10-05T22:05:00.000Z',
    reason: `${type}: containment fence of epoch 6 whose quarantine could not be settled`, decider, releasedLease: type !== 'note', state: 'open' });
  const note = request('note', { kind: 'rule', who: 'nobody; a note is recorded, not decided', command: null });
  const decision = request('decision', { kind: 'approver', who: 'an independent approver agent', command: 'graphyard decide GY-1318' });
  const human = request('escalation', { kind: 'human', who: 'the operator', command: null });
  human.humanDecision = 'goals-and-priorities';

  const done = work({ key: 'GY-1318', stage: 'done', epoch: 6, agentRequests: [note, decision, human] });
  const live = work({ key: 'GY-1400', stage: 'build', epoch: 6, agentRequests: [{ ...note, id: 'note-2' }] });
  const lines = agentRequestAttention({ work: [done, live], now });
  assert.ok(!lines.some(line => line.subject === 'GY-1318' && /recorded a note/.test(line.text)), 'the note on the Done item is not attention');
  assert.ok(lines.some(line => line.subject === 'GY-1318' && /recorded a decision/.test(line.text) && /decided by an independent approver agent/.test(line.text)));
  assert.ok(lines.some(line => line.subject === 'GY-1318' && /recorded a escalation/.test(line.text) && line.human));
  assert.ok(lines.some(line => line.subject === 'GY-1400' && /recorded a note/.test(line.text)), 'a note on a live item is still reported');
  assert.equal(lines.length, 3);
  // The note stays on the item's record.
  assert.equal(done.agentRequests!.find(entry => entry.type === 'note')!.state, 'open');
});
