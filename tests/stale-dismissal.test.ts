import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { exactApproval, type Observation, type Work } from '../src/model.js';
import { nameUnobtainableReviews, reconcileAutoDispatch, reviewNeed, unansweredRequest, unobtainableReview, type RequestProgress, type SettledReviewSession } from '../src/model/dispatch.js';
import { baseRefreshConflict, pendingBaseRefresh } from '../src/merge-queue.js';
import { buildMasterStatus, loadMasterConfig, setupMaster } from '../src/master.js';
import { bindReviewer, launchReview, readReviewLedger, reconcileReviews, reviewIdleGraceMs, saveReviewerProfile, summarizeReviews, withdrawnBeforeLaunch } from '../src/reviewer.js';
import { sessionRetry } from '../src/producer.js';
import { emptyDispatchCursor, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';
import { unansweredRequestAttention, unobtainableReviewAttention } from '../src/cli/master-status.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Each test is named for the proof it produces: integration:dismissed-review-not-matched,
// integration:recover-review-without-base-refresh and unit:unobtainable-review-visible.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), B = sha40('b1'), P1 = sha40('c1'), TIP = sha40('d1');
const treeOf = (sha: string) => sha40(`7${sha.slice(0, 3)}`);
// One fixed clock for the launch and for every GitHub timestamp: the launch cutoff below is a
// comparison between the two, so a test that mixed a real clock with a fake one would prove
// nothing about which review a session could have collected.
const clock = Date.parse('2026-09-21T01:22:07.000Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const reviewer = 'graphyard-reviewer[bot]';
const PR = 100;

function observation(candidate: { sha: string; baseSha: string }, at: string, overrides: Partial<Observation> = {}): Observation {
  return { candidate: { ...candidate, pr: PR, branch: 'graphyard/gy-100-1', author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/reviewer.ts'], scopeFiles: [], at, prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: treeOf(candidate.baseSha), baseTipContained: true, ...overrides };
}
/** One submitted, observed candidate whose only proof is manual: the review request stands alone. */
function work(overrides: Partial<Work> = {}, at = iso(0)): Work {
  const candidate = { sha: H, baseSha: B, pr: PR, branch: 'graphyard/gy-100-1', author: 'implementer' };
  return { id: 'work-100', key: 'GY-100', title: 'Dismissed review is every session\'s verdict', description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Never matched', proofs: ['manual:stale-dismissal'] }],
    policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 9, policyRevision: 4, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1,
    lease: null, workspaces: [{ host: 'h', path: '/w/gy-100', branch: 'graphyard/gy-100-1', epoch: 1, owner: 'implementer' }], candidate, submission: { epoch: 1, pr: PR }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: observation(candidate, at), blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], violations: [], ...overrides } as Work;
}

/** A Herdr and `gh` stub: tab and agent calls for a launch, pane closes, and the PR's review list. */
function stubs(reviews: () => unknown[]) {
  const calls: string[][] = [];
  const run = (_command: string, args: string[]) => {
    calls.push(args);
    if (args[0] === 'api') return JSON.stringify(reviews());
    if (args[0] === 'agent' && args[1] === 'read') return 'reading the diff';
    return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { root_pane: { pane_id: 'pane-review', tab_id: 'tab-review' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
  };
  return { calls, run, mint: async () => ({ token: 'ghs_review_session_token', expiresAt: iso(3_500_000) }) };
}

async function reviewerRoot() {
  const root = await temporaryDirectory('stale-dismissal'), credentialDirectory = await temporaryDirectory('stale-dismissal-credentials');
  execFileSync('git', ['init', '-q', root]); execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory, herdrWorkspace: 'wE' }, coordinatorStatus as typeof fetch);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentialDirectory, 'reviewers') }, async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
  await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' });
  return { root, credentialDirectory, config: await loadMasterConfig(root), cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); } };
}

/** The dispatch loop with the real review ledger and a launcher that only records what it was asked for. */
function dispatchEffects(items: () => Work[], ledger: () => any[], log: string[], now: () => string): DispatchEffects {
  return {
    snapshot: async () => ({ work: items(), now: now() }),
    agents: () => [],
    credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    reconcileReviews: async () => ({ reviews: ledger() as any }),
    reconcileProducers: async () => ({ producers: [] }),
    launchReview: async (item, request, profile) => { log.push(`review:${item.key}:${request.sha.slice(0, 4)}:${profile.name}`); },
    launchProducer: async () => {},
    persist: async () => {},
  };
}

test('integration:dismissed-review-not-matched — a review GitHub dismissed before a session was launched is never that session\'s verdict, so the session stays pending until its own reviewer posts', async () => {
  const { root, config, cleanup } = await reviewerRoot();
  try {
    // A dismissed approval standing on the exact candidate that no session of this head ever
    // recorded: `master merge` re-posted a carried approval through the same reviewer App, or an
    // operator dismissed one by hand, and GitHub keeps it listed under the reviewer's identity
    // with the moment it was originally submitted — ten minutes before this session existed.
    let reviews: any[] = [{ id: 11, commit_id: H, user: { login: reviewer }, state: 'DISMISSED', submitted_at: iso(-600_000) }];
    const { run, mint } = stubs(() => reviews);
    const item = work();
    reconcileAutoDispatch(item, [item], new Date(clock));
    const request = item.autoDispatch!.review!;
    const launched = await launchReview(root, item, 'claude-reviewer', [], iso(1000), { run, mint, now: () => new Date(clock + 1000), requestId: request.id });
    assert.equal(launched.requestId, request.id);
    assert.ok(withdrawnBeforeLaunch(reviews[0], clock + 1000), 'the seeded verdict was withdrawn before the launch');
    // The session is not answered by it: the attempt is not burned the moment it starts.
    const pending = (await reconcileReviews(root, config, { run, work: [item], now: () => new Date(clock + 2000) })).reviews;
    assert.deepEqual([pending.length, pending[0].state, pending[0].verdict], [1, 'pending', undefined]);
    assert.equal(summarizeReviews(pending).pending[0].verdict, null);
    assert.equal(sessionRetry(pending, request.id, clock + 2000).launch, false, 'the request has a live session; nothing is relaunched beside it');
    // Every guard on its own: an unreadable timestamp is not proof of this session's verdict
    // either, while a verdict that answers the request is matched whenever it was submitted.
    assert.equal(withdrawnBeforeLaunch({ state: 'DISMISSED' }, clock + 1000), true);
    assert.equal(withdrawnBeforeLaunch({ state: 'DISMISSED', submitted_at: iso(2000) }, clock + 1000), false);
    assert.equal(withdrawnBeforeLaunch({ state: 'APPROVED', submitted_at: iso(-600_000) }, clock + 1000), false);
    // Its own reviewer posts on that same commit, and that verdict does answer it.
    reviews = [...reviews, { id: 12, commit_id: H, user: { login: reviewer }, state: 'APPROVED', submitted_at: iso(300_000) }];
    const answered = (await reconcileReviews(root, config, { run, work: [item], now: () => new Date(clock + 301_000) })).reviews[0];
    assert.deepEqual([answered.state, answered.verdict!.state, answered.verdict!.reviewId], ['completed', 'APPROVED', 12]);
    // And a session that never posts fails on its own terms — as one that stopped without a
    // verdict, never as one settled by the withdrawn review it was never able to collect.
    reviews = [reviews[0]];
    const reobserved = work({ autoDispatch: item.autoDispatch }, iso(302_000));
    const second = await launchReview(root, reobserved, 'claude-reviewer', [], iso(302_000), { run, mint, now: () => new Date(clock + 302_000), requestId: request.id });
    const idle = (at: number, status: string) => reconcileReviews(root, config, { run, work: [reobserved], agents: [{ name: 'review-claude-1', pane_id: 'pane-review', agent_status: status } as any], retry: () => {}, now: () => new Date(clock + at) });
    await idle(303_000, 'blocked');
    const failed = (await idle(303_000 + reviewIdleGraceMs + 1000, 'done')).reviews.find(record => record.id === second.review)!;
    assert.equal(failed.state, 'failed');
    assert.match(failed.resolution!, /the reviewer session finished \(done\) without posting a verdict on a1ffffffffff/);
    assert.doesNotMatch(failed.resolution!, /dismissed/);
    assert.equal(failed.verdict, undefined);
  } finally { await cleanup(); }
});

test('integration:recover-review-without-base-refresh — a candidate whose approval GitHub dismissed obtains a fresh verdict on the same commit, with no base refresh and no new head', async () => {
  const { root, config, cleanup } = await reviewerRoot();
  try {
    // The GY-87 sequence: GitHub withdrew the approval of the candidate TIP while the same commit
    // is still the candidate, so it still needs the review the gate refuses without.
    const candidate = { sha: TIP, baseSha: P1, pr: PR, branch: 'graphyard/gy-100-1', author: 'implementer' };
    const approved = (state: string, at: number) => work({ candidate,
      observation: observation(candidate, iso(at), { reviews: [{ id: 21, reviewer, sha: TIP, state, submittedAt: iso(-600_000) }] }) } as Partial<Work>, iso(at));
    const item = approved('APPROVED', 0);
    assert.equal(reviewNeed(item).state, 'approved');
    assert.deepEqual(reconcileAutoDispatch(item, [item], new Date(clock)).map(entry => entry.event), [], 'an approved head asks for nothing');
    // GitHub withdraws it while the candidate is unchanged.
    const dismissed = approved('DISMISSED', 1000);
    dismissed.autoDispatch = item.autoDispatch;
    assert.equal(reviewNeed(dismissed).state, 'required');
    assert.deepEqual(reconcileAutoDispatch(dismissed, [dismissed], new Date(clock + 1000)).map(entry => entry.event), ['dispatch.requested']);
    const request = dismissed.autoDispatch!.review!;
    assert.deepEqual([request.sha, request.baseSha, request.state], [TIP, P1, 'requested'], 'the request is re-opened for the same commit');
    // Nothing is waiting on a base refresh, and nobody is asked for a new head.
    assert.equal(pendingBaseRefresh(dismissed), null);
    assert.equal(baseRefreshConflict(dismissed), null);
    assert.equal(dismissed.reworkRequested, false);
    // One dispatch tick launches the session for it, unprompted.
    let reviews: any[] = [{ id: 21, commit_id: TIP, user: { login: reviewer }, state: 'DISMISSED', submitted_at: iso(-600_000) }];
    const { run, mint } = stubs(() => reviews);
    const log: string[] = [];
    const tick = await runDispatchTick(config, emptyDispatchCursor(config), dispatchEffects(() => [dismissed], () => [], log, () => iso(2000)), () => clock + 2000);
    assert.deepEqual(log, ['review:GY-100:d1ff:claude-reviewer']);
    assert.deepEqual(tick.launched.map(entry => [entry.kind, entry.sha, entry.requestId]), [['review', TIP, request.id]]);
    await launchReview(root, dismissed, 'claude-reviewer', [], iso(2000), { run, mint, now: () => new Date(clock + 2000), requestId: request.id });
    // The withdrawn approval does not settle it (integration:dismissed-review-not-matched), so
    // the session lives long enough for its reviewer to post.
    assert.equal((await reconcileReviews(root, config, { run, work: [dismissed], now: () => new Date(clock + 3000) })).reviews[0].state, 'pending');
    reviews = [...reviews, { id: 22, commit_id: TIP, user: { login: reviewer }, state: 'APPROVED', submitted_at: iso(240_000) }];
    const settled = (await reconcileReviews(root, config, { run, work: [dismissed], now: () => new Date(clock + 241_000) })).reviews[0];
    assert.deepEqual([settled.state, settled.sha, settled.verdict!.state, settled.verdict!.reviewId], ['completed', TIP, 'APPROVED', 22]);
    assert.equal(sessionRetry([settled], request.id, clock + 241_000).settled, true);
    // The new verdict lands on the unchanged commit: the gate is satisfied by the same sha the
    // dismissal was on, the request is resolved, and no head was ever republished for it.
    const recovered = approved('APPROVED', 242_000);
    recovered.observation!.reviews = [{ id: 22, reviewer, sha: TIP, state: 'APPROVED', submittedAt: iso(240_000) }];
    recovered.autoDispatch = dismissed.autoDispatch;
    assert.equal(exactApproval(recovered)!.reviewId, 22);
    assert.deepEqual(reconcileAutoDispatch(recovered, [recovered], new Date(clock + 242_000)).map(entry => entry.event), ['dispatch.satisfied']);
    assert.equal(recovered.autoDispatch!.review, null);
    assert.equal(recovered.candidate!.sha, TIP, 'the recovery never demanded a new head');
    assert.equal(recovered.candidate!.baseSha, P1, 'and never a base refresh');
  } finally { await cleanup(); }
});

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
