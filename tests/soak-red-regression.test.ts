import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';
import { mechanicalReviewHold, mechanicalRoundStartMs } from '../src/mechanical-findings.js';

// GY-1814. The release-candidate soak failed every run of 2026-10-14 on the mechanical-fix day.
// The mechanical-fix day (tests/soak-review.test.ts) merged each approved head within milliseconds of its approval landing,
// because the approval is observed and its gates re-evaluated inside one control-plane observation job
// while the loop's plan report runs later in the daemon's decisions step: since GY-1764 the review gate
// holds only a plan the loop reported, so in that window it held nothing. This test pins the fixed path:
// the review gate holds an approval naming mechanical findings from its own observation.
//
// Every instant in this file is the fixture's own fixed clock below, handed explicitly to the code under
// test; the file takes no wall-clock reading of its own.
const now = Date.parse('2026-10-14T12:00:00.000Z'), minute = 60_000, hour = 60 * minute;
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => seed.repeat(40).slice(0, 40);
const head = sha('a'), base = sha('b'), reviewId = 901, key = 'GY-1814', short = head.slice(0, 12);
const submittedAt = iso(now - 5 * minute);
const candidate = { sha: head, baseSha: base, pr: 1814, branch: 'graphyard/gy-1814-1', author: 'implementer' };
const approval = { reviewer: 'graphyard-reviewer[bot]', sha: head, state: 'APPROVED', id: reviewId, submittedAt, mechanical: 2 };
/** The item as the control plane holds it: `mechanicalPlan` absent unless a test reports one. */
const item = (extra: Partial<Work> = {}): Work => ({
  id: 'work-1814', key, title: 'Widget', description: '', type: 'bug', priority: 1, dependencies: [], 
  criteria: [{ id: 'AC-1', text: 'It works', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' },
  stage: 'review', revision: 3, policyRevision: 1, createdAt: iso(now - 2 * hour), updatedAt: iso(now - minute), stageEnteredAt: iso(now - minute),
  ready: true, epoch: 1, lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 1814 }, reworkRequested: false,
  scenarioRequirements: [], evidence: [], blocker: null, violations: [], gates: [],
  observation: { candidate, reviews: [approval], checks: [], merged: false, prState: 'open', draft: false, at: iso(now - minute) },
  ...extra,
} as unknown as Work);
const observed = (reviews: Partial<typeof approval>[]): Partial<Work> => ({ observation: { candidate, reviews: reviews as typeof approval[], checks: [], merged: false, prState: 'open', draft: false, at: iso(now - minute) } as unknown as Work['observation'] });

test('unit:soak-red-regression — the review gate holds an approval naming mechanical findings from its observation until its round window: a reported plan for that approval holds whatever its stamp, a plan for another approval holds, the clear of this approval releases, and the round window releases the rest', async () => {
  // The race the soak caught, closed at the gate: the approval is observed with no report of the loop's yet.
  assert.match(mechanicalReviewHold(item(), now) ?? '', new RegExp(`Approval ${reviewId} of ${short} names 2 findings classified mechanical`), 'an approval the loop has not reported yet holds its head');
  // A matching report holds whatever its stamp: the round is still owed between the loop's confirms.
  assert.match(mechanicalReviewHold(item({ mechanicalPlan: { reviewId, head, at: iso(now - mechanicalRoundStartMs / 2) } }), now) ?? '', /names 2 findings classified mechanical/, 'a matching plan holds past its confirm');
  assert.match(mechanicalReviewHold(item({ mechanicalPlan: { reviewId, head, at: iso(now - mechanicalRoundStartMs) } }), now) ?? '', /names 2 findings classified mechanical/, 'a matching plan holds whatever stamp its last confirm carried');
  // The answers that release: the clear of this approval, and the round window itself.
  assert.match(mechanicalReviewHold(item({ mechanicalPlan: { reviewId: reviewId - 1, head, at: iso(now) } }), now) ?? '', /names 2 findings/, 'a plan for another approval answers nothing here');
  assert.match(mechanicalReviewHold(item({ mechanicalPlan: { reviewId, head: base, at: iso(now) } }), now) ?? '', /names 2 findings/, 'a plan for another head answers nothing here');
  assert.match(mechanicalReviewHold(item({ mechanicalPlan: null, mechanicalAnswered: { reviewId: reviewId - 1, head: base } }), now) ?? '', /names 2 findings/, 'the clear of an earlier head or approval holds the new one (GY-1814)');
  assert.equal(mechanicalReviewHold(item({ mechanicalPlan: null, mechanicalAnswered: { reviewId, head } }), now), null, 'the clear of this approval releases the head');
  assert.equal(mechanicalReviewHold(item({ mechanicalPlan: null, mechanicalAnswered: { reviewId, head: base } }), now), null, 'the clear of a carried approval names the refreshed candidate head, and still releases the approval it answered by review id');
  const late = iso(now - mechanicalRoundStartMs - minute);
  assert.equal(mechanicalReviewHold(item(observed([{ ...approval, submittedAt: late }])), now), null, 'an approval past its round window holds nothing');
});
