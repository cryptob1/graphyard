import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';
import { mechanicalReviewHold, mechanicalRoundStartMs } from '../src/mechanical-findings.js';
import { reportMechanicalPlans } from '../src/daemon/mechanical-plan-report.js';
import { postDeployReader } from '../src/master/post-deploy-readings.js';

// GY-1814. The release-candidate soak failed every run of 2026-10-14 on four tests, with two causes.
//
// The windowed and unwindowed post-deploy follow-ups (tests/soak-observation-window.test.ts) were read,
// escalated and closed by the loop's own readings step (GY-1779) because the simulated intervention report
// answered the loop's reading for the multi-day criterion windows — a `since: null` row the reader reads as
// a definite fail (recorded and escalated) and, an hour past the instant, a full streak it closes the item
// on — where the report those days model holds no measured row for such a window within the day, so the
// loop's reading is untakeable and the item stays on the wait. The blocked-unleased follow-ups were
// dispatched past their instant because the day seeded them without the filer's structured `Post-deploy
// follow-up:` request identity, so they were never loop-owned items. The mechanical-fix day
// (tests/soak-review.test.ts) merged each approved head within milliseconds of its approval landing,
// because the approval is observed and its gates re-evaluated inside one control-plane observation job
// while the loop's plan report runs later in the daemon's decisions step: since GY-1764 the review gate
// holds only a plan the loop reported, so in that window it held nothing. These tests pin the fixed paths:
// the reader's contract for a report that holds no row, and the loop's provisional report of an approval
// the ledger has not answered, with the gate's hold over both.
//
// Every instant in this file is the fixture's own fixed clock below, handed explicitly to the code under
// test; the file takes no wall-clock reading of its own.
const now = Date.parse('2026-10-14T12:00:00.000Z'), minute = 60_000, hour = 60 * minute, day = 24 * hour;
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => seed.repeat(40).slice(0, 40);
const head = sha('a'), base = sha('b'), reviewId = 901, key = 'GY-1814', short = head.slice(0, 12);
const submittedAt = iso(now - 5 * minute);
const candidate = { sha: head, baseSha: base, pr: 1814, branch: 'graphyard/gy-1814-1', author: 'implementer' };
const approval = { reviewer: 'graphyard-reviewer[bot]', sha: head, state: 'APPROVED', id: reviewId, submittedAt, mechanical: 2 };
/** The item as the control plane holds it: `mechanicalPlan` absent unless a test reports one. */
const item = (extra: Partial<Work> = {}): Work => ({
  id: 'work-1814', key, title: 'Widget', description: '', type: 'bug', priority: 1, dependencies: [], plannedFiles: ['src/'],
  criteria: [{ id: 'AC-1', text: 'It works', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' },
  stage: 'review', revision: 3, policyRevision: 1, createdAt: iso(now - 2 * hour), updatedAt: iso(now - minute), stageEnteredAt: iso(now - minute),
  ready: true, epoch: 1, lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 1814 }, reworkRequested: false,
  scenarioRequirements: [], evidence: [], blocker: null, violations: [], gates: [],
  observation: { candidate, reviews: [approval], checks: [], merged: false, prState: 'open', draft: false, at: iso(now - minute) },
  ...extra,
} as unknown as Work);
const observed = (reviews: Partial<typeof approval>[]): Partial<Work> => ({ observation: { candidate, reviews: reviews as typeof approval[], checks: [], merged: false, prState: 'open', draft: false, at: iso(now - minute) } as unknown as Work['observation'] });

test('unit:soak-red-regression — the loop\'s post-deploy reading of an intervention report that holds no row for the pattern is untakeable, never a fail: a row answering no streak yet is the definite fail the loop records and escalates, and a met streak passes', async () => {
  const criterion = { id: 'AC-2', text: 'The cause of the recurring escalation interventions at the build stage is found and removed: the intervention report shows the escalation rate at the build stage below 3 per 3 days after item 1 ships', proofs: ['manual:post-deploy/intervention-pattern-escalation-build'] };
  const proof = 'manual:post-deploy/intervention-pattern-escalation-build', release = sha('c');
  const input = { proof, parent: item(), item: item(), criterion, release, now: new Date(now) };
  // The fixed path (GY-1814): the report holds no measured row for a multi-day criterion window within the
  // day the window covers, so the loop's reading is untakeable — recorded as a wait, never a fail, never an
  // escalation, never a close. The projection the caller already read is what the reader reads.
  const noRow = await postDeployReader(async () => { throw new Error('the report must not be read again for a projection the caller read'); })({ ...input, projection: { read: null } });
  assert.ok('unavailable' in noRow && /holds no row for the escalation reading at the build stage/.test(noRow.unavailable), `a report with no row reads as untakeable: ${JSON.stringify(noRow)}`);
  // The reading the windowed day must never reach: a row that answers "no streak yet" is a definite fail —
  // the loop records it and raises the item's escalation naming the measured values (GY-1779).
  const noStreak = await postDeployReader(async () => { throw new Error('not read'); })({ ...input, projection: { read: { since: null, projected: iso(now + 12 * hour) } } });
  assert.ok('result' in noStreak && noStreak.result === 'fail' && /so the 3-day window has not run/.test(noStreak.detail), `a row with no streak yet reads as a definite fail: ${JSON.stringify(noStreak)}`);
  // And a streak that meets the window passes — the live-window days' reading, which closes the item.
  const streak = await postDeployReader(async () => { throw new Error('not read'); })({ ...input, projection: { read: { since: iso(now - 3 * day), projected: null } } });
  assert.ok('result' in streak && streak.result === 'pass' && /meets the 3-day window/.test(streak.detail), `a met streak reads as a pass: ${JSON.stringify(streak)}`);
});

test('unit:soak-red-regression — the loop reports an approval the ledger has not answered as the plan that holds its head: suppressed when the ledger answered none or supplies no answered list, re-confirmed while it stands, and never past the round window', async () => {
  const plans: ({ reviewId: number; head: string } | null)[] = [];
  const sink = { fail: async () => {}, settle: async () => {} };
  const run = async (mechanicalFixes: () => Promise<{ requests: unknown[]; answered?: { key: string; reviewId: number }[] }>, extra: Partial<Work> = {}) => {
    plans.length = 0;
    await reportMechanicalPlans([item(extra)], [], { mechanicalFixes: mechanicalFixes as never, recordMechanicalPlan: async (_work, plan) => { plans.push(plan); } }, now, sink);
    return plans;
  };
  // The race the soak caught: the approval is observed and its head re-evaluated inside the observation job,
  // before the ledger pass that plans it. The loop reports the approval itself, and the gate holds.
  assert.deepEqual(await run(async () => ({ requests: [], answered: [] })), [{ reviewId, head }], 'an unanswered approval is reported as the plan that holds its head');
  assert.match(mechanicalReviewHold(item({ mechanicalPlan: { reviewId, head, at: iso(now) } }), now) ?? '', new RegExp(`Approval ${reviewId} of ${short} names 2 findings classified mechanical`), 'the reported plan holds the head');
  // An approval the ledger answered without a plan — follow-ups filed, a fresh read present, a fallback — is
  // cleared, never re-held past the answer (GY-1764).
  assert.deepEqual(await run(async () => ({ requests: [], answered: [{ key, reviewId }] })), [null], 'the ledger\'s answer clears the approval');
  assert.equal(mechanicalReviewHold(item({ mechanicalPlan: null, mechanicalAnswered: { reviewId, head } }), now), null, 'and the gate releases on the clear');
  // An effects wiring that supplies no answered list answers everything: the gate never holds what nothing backs.
  assert.deepEqual(await run(async () => ({ requests: [] })), [null], 'a read without an answered list reports none');
  // A matching report stands while the ledger still plans nothing: it is re-confirmed, whatever its stamp.
  assert.deepEqual(await run(async () => ({ requests: [], answered: [] }), { mechanicalPlan: { reviewId, head, at: iso(now - 6 * minute) } }), [{ reviewId, head }], 'a standing matching plan is re-confirmed');
  // Past the round window the approval holds nothing and owes no report: the findings return to follow-ups.
  const late = iso(now - mechanicalRoundStartMs - hour);
  assert.deepEqual(await run(async () => ({ requests: [], answered: [] }), observed([{ ...approval, submittedAt: late }])), [], 'an approval past its round window is not reported');
  assert.equal(mechanicalReviewHold(item(observed([{ ...approval, submittedAt: late }])), now), null, 'and the gate releases past the window');
});

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
  const late = iso(now - mechanicalRoundStartMs - minute);
  assert.equal(mechanicalReviewHold(item(observed([{ ...approval, submittedAt: late }])), now), null, 'an approval past its round window holds nothing');
});
