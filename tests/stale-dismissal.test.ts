import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { type Observation, type Work } from '../src/model.js';
import { nameUnobtainableReviews, reconcileAutoDispatch, unansweredRequest, unobtainableReview, type RequestProgress, type SettledReviewSession } from '../src/model/dispatch.js';
import { buildMasterStatus } from '../src/master.js';
import { unansweredRequestAttention, unobtainableReviewAttention } from '../src/cli/master-status.js';

// The test is named for the proof it produces: unit:unobtainable-review-visible. The GitHub dismissal
// reads the two integration proofs drove are gone (GY-2010).

const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), B = sha40('b1');
const treeOf = (sha: string) => sha40(`7${sha.slice(0, 3)}`);
// One fixed clock for the launch and for every GitHub timestamp: the launch cutoff below is a
// comparison between the two, so a test that mixed a real clock with a fake one would prove
// nothing about which review a session could have collected.
const clock = Date.parse('2026-09-21T01:22:07.000Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const PR = 100;

function observation(candidate: { sha: string; baseSha: string }, at: string, overrides: Partial<Observation> = {}): Observation {
  return { candidate: { ...candidate, pr: PR, branch: 'graphyard/gy-100-1', author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/reviewer.ts'], scopeFiles: [], at, prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: treeOf(candidate.baseSha), baseTipContained: true, ...overrides };
}
/** One submitted, observed candidate whose only proof is manual: the review request stands alone. */
function work(overrides: Partial<Work> = {}, at = iso(0)): Work {
  const candidate = { sha: H, baseSha: B, pr: PR, branch: 'graphyard/gy-100-1', author: 'implementer' };
  return { id: 'work-100', key: 'GY-100', title: 'Dismissed review is every session\'s verdict', description: '', type: 'bug', priority: 0, dependencies: [], 
    criteria: [{ id: 'AC-1', text: 'Never matched', proofs: ['manual:stale-dismissal'] }],
    policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 9, policyRevision: 4, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1,
    lease: null, workspaces: [{ host: 'h', path: '/w/gy-100', branch: 'graphyard/gy-100-1', epoch: 1, owner: 'implementer' }], candidate, submission: { epoch: 1, pr: PR }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: observation(candidate, at), blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], violations: [], ...overrides } as Work;
}

test('unit:unobtainable-review-visible — master status names the dismissed review an item cannot get past, how many sessions settled on it and the command that recovers, apart from the reviews that are running', async () => {
  const item = work();
  reconcileAutoDispatch(item, [item], new Date(clock));
  const request = item.autoDispatch!.review!;
  const resolution = 'the approval of a1ffffffffff was dismissed while it was still the candidate; the same commit is reviewed again';
  const session = (review: string, reviewId: number) => ({ review, requestId: request.id, attempt: 1, work: 'GY-100', pr: PR, sha: H, policyRevision: 4, profile: 'claude-reviewer', agentName: 'review-claude-1',
    state: 'failed', verdict: 'DISMISSED', reviewId, requestedAt: iso(0), tokenExpiresAt: iso(3_600_000), closedAt: iso(60_000), resolution, attention: null });
  // Three sessions, every one of them settled on the same review GitHub had already withdrawn.
  const settled = [session('r1', 11), session('r2', 11), session('r3', 11)];
  const exhausted = { requestId: request.id, attempts: 3, started: 3, neverStarted: 0, limit: 4, unstartedLimit: 3, nextAt: null, exhausted: true, last: { state: 'failed', resolution } };
  const status = buildMasterStatus({ work: [item], now: iso(4_500_000) }, [], [], {}, {}, { pending: [], completed: settled }, 'main', undefined,
    { producers: { pending: [], completed: [] }, failures: [], retries: [exhausted] });
  assert.equal(status.counts.dispatchRequested, 1);
  assert.equal(status.counts.dispatchRunning, 0, 'a session settled on a withdrawn verdict is not a review that is running');
  const unobtainable = unobtainableReviewAttention(status.work, settled as SettledReviewSession[]);
  assert.equal(unobtainable.length, 1);
  assert.deepEqual([unobtainable[0].review.sha, unobtainable[0].review.reviewIds, unobtainable[0].review.sessions, unobtainable[0].review.attempts], [H, [11], 3, 3]);
  assert.match(unobtainable[0].text, /^GY-100 cannot obtain a review of a1ffffffffff: 3 reviewer sessions settled on review #11, which GitHub dismissed, so no verdict has ever been obtained on that commit in 1h15m over 3 attempts — the approval of a1ffffffffff was dismissed/);
  assert.match(unobtainable[0].text, /This is not a review in progress: nothing is running for the request$/);
  assert.deepEqual([unobtainable[0].subject, unobtainable[0].role, unobtainable[0].human], ['GY-100', 'master', false]);
  assert.match(unobtainable[0].next, /graphyard master review GY-100 \[PROFILE\] forces the next attempt/);
  // It is the same request the ordinary unanswered wait is about, so status says this of it
  // instead — one line, never both — and the totals are what they were.
  const unanswered = unansweredRequestAttention(status.work);
  assert.equal(unanswered.length, 1);
  assert.match(unanswered[0].text, /^Review request for GY-100 has stood unanswered/);
  const unrelated = { ...unanswered[0], requestId: undefined, subject: 'disk', text: 'unrelated' };
  const named = nameUnobtainableReviews([unrelated, ...unanswered], unobtainable);
  assert.deepEqual(named.map(entry => entry.text.slice(0, 24)), ['unrelated', 'GY-100 cannot obtain a r']);
  assert.ok(named.every(entry => !('requestId' in entry) && !('review' in entry)), 'the join fields never reach the report');
  // A review that is running, one whose next attempt is scheduled, and one answered by a verdict
  // the gate can act on are none of them unobtainable.
  const progress = (session: RequestProgress['session'], retry: RequestProgress['retry'] = null): RequestProgress => ({ requestId: request.id, sha: H, sinceMs: 4_500_000, session, retry });
  assert.equal(unobtainableReview(progress({ state: 'pending', attempt: 1 }), settled as SettledReviewSession[]), null);
  assert.equal(unobtainableReview(progress({ state: 'failed', attempt: 1, verdict: 'DISMISSED', resolution }, { attempts: 1, limit: 4, nextAt: iso(60_000), exhausted: false }), settled as SettledReviewSession[]), null);
  assert.equal(unobtainableReview(progress({ state: 'completed', attempt: 1, verdict: 'APPROVED', resolution: null }), settled as SettledReviewSession[]), null);
  assert.equal(unobtainableReview(progress({ state: 'failed', attempt: 1, verdict: null, resolution: 'the reviewer session finished (done) without posting a verdict' }), []), null, 'a session that posted nothing is unanswered, not stuck on a withdrawn verdict');
  assert.equal(unobtainableReview({ ...progress({ state: 'failed', attempt: 1, verdict: 'DISMISSED', resolution }), sha: undefined }, settled as SettledReviewSession[]), null, 'a reader that does not carry the head names no commit');
  assert.equal(unobtainableReview(null, settled as SettledReviewSession[]), null);
  // The judgement is the same with or without the ledger, so the line that replaces the ordinary
  // wait and the line that reports it are always about the same request.
  const withoutLedger = unobtainableReview(progress({ state: 'failed', attempt: 1, verdict: 'DISMISSED', resolution }, { attempts: 3, limit: 4, nextAt: null, exhausted: true }));
  assert.deepEqual([withoutLedger!.requestId, withoutLedger!.sessions, withoutLedger!.reviewIds], [request.id, 1, []]);
  assert.ok(unansweredRequest(progress({ state: 'failed', attempt: 3, verdict: 'DISMISSED', resolution }, { attempts: 3, limit: 4, nextAt: null, exhausted: true }), 'review'));
  // `master status` reports and counts them, apart from the reviews that are running.
  const report = await readFile(new URL('../src/cli/master-status.ts', import.meta.url), 'utf8');
  assert.match(report, /const unobtainable = unobtainableReviewAttention\(status\.work, reviews\.completed as SettledReviewSession\[\]\);/);
  assert.match(report, /nameUnobtainableReviews\(attentionItems as \(AttentionItem & \{ requestId\?: string \}\)\[\], unobtainable\)/);
  assert.match(report, /dispatchUnobtainableReview: unobtainable\.length/);
  assert.match(report, /unobtainableReviews: unobtainable\.map\(item => \(\{ work: item\.subject, \.\.\.item\.review \}\)\)/);
});
