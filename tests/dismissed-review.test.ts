import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Observation, Work } from '../src/model.js';
import { answeringVerdicts, liveReviewRequest, reconcileAutoDispatch, unansweredRequest, unansweredRequests, type RequestProgress } from '../src/model/dispatch.js';
import { buildMasterStatus, loadMasterConfig, setupMaster } from '../src/master.js';
import { bindReviewer, dismissalResolution, launchReview, readReviewLedger, reconcileReviews, reviewCommand, saveReviewerProfile, summarizeReviews } from '../src/reviewer.js';
import { sessionRetry, sessionRetryBaseMs, sessionRetryLimit } from '../src/producer.js';
import { emptyDispatchCursor, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';
import { unansweredRequestAttention, unansweredRequestOwner } from '../src/cli/master-status.js';

// Each test is named for the proof it produces: integration:dismissed-review-relaunches,
// integration:dismissal-without-head-change, unit:unsatisfied-settled-request-visible and
// integration:master-review-forces-attempt.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), H2 = sha40('a2'), B = sha40('b1');
const clock = Date.parse('2026-09-21T01:22:07.000Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const reviewer = 'graphyard-reviewer[bot]';

function observation(candidate: { sha: string; baseSha: string }, at: string): Observation {
  return { candidate: { ...candidate, pr: 84, branch: 'graphyard/gy-84-1', author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/a.ts'], scopeFiles: [], at, prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: sha40('7b'), baseTipContained: true };
}
/** One submitted, observed candidate whose only proof is manual: the review request stands alone. */
function work(overrides: Partial<Work> = {}, at = iso(0)): Work {
  const candidate = { sha: H, baseSha: B, pr: 84, branch: 'graphyard/gy-84-1', author: 'implementer' };
  return { id: 'work-84', key: 'GY-84', title: 'Dismissed approval', description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Relaunch', proofs: ['manual:dismissed-review'] }],
    policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 7, policyRevision: 3, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1,
    lease: null, workspaces: [{ host: 'h', path: '/w/gy-84', branch: 'graphyard/gy-84-1', epoch: 1, owner: 'implementer' }], candidate, submission: { epoch: 1, pr: 84 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: observation(candidate, at), blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], violations: [], ...overrides } as Work;
}

/** A Herdr and `gh` stub: tab and agent calls for a launch, pane closes, and the PR's review list. */
function stubs(reviews: () => unknown[]) {
  const calls: string[][] = [];
  const run = (_command: string, args: string[]) => {
    calls.push(args);
    if (args[0] === 'api') return JSON.stringify(reviews());
    return JSON.stringify({ result: args[0] === 'tab' ? { root_pane: { pane_id: 'pane-review', tab_id: 'tab-review' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
  };
  return { calls, run, mint: async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() }) };
}

async function reviewerRoot() {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-dismissed-')), credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-dismissed-credentials-'));
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

test('integration:dismissed-review-relaunches — a dismissed approval is recorded unanswered with its cause, and the next head is reviewed afresh without an operator', async () => {
  const { root, config, cleanup } = await reviewerRoot();
  try {
    const { run, mint } = stubs(() => []);
    // The candidate is observed, the control plane requests its review, and the reviewer session launches.
    const item = work({}, new Date().toISOString());
    reconcileAutoDispatch(item, [item], new Date());
    const first = item.autoDispatch!.review!;
    const launched = await launchReview(root, item, 'claude-reviewer', [], new Date().toISOString(), { run, mint, requestId: first.id });
    assert.equal(launched.requestId, first.id);
    // The reviewer approves that head; the worker pushes a new one, and GitHub dismisses the approval with it.
    const moved = work({ candidate: { sha: H2, baseSha: B, pr: 84, branch: 'graphyard/gy-84-1', author: 'implementer' }, observation: observation({ sha: H2, baseSha: B }, new Date().toISOString()), autoDispatch: item.autoDispatch }, new Date().toISOString());
    const dismissal = { state: 'DISMISSED', reviewer, reviewId: 11, submittedAt: iso(0) };
    const settled = (await reconcileReviews(root, config, { run, observe: () => dismissal, work: [moved] })).reviews[0];
    // Unanswered, not completed: a dismissed approval is not an approval, so the session answered nothing.
    assert.equal(settled.state, 'failed');
    assert.equal(settled.verdict!.state, 'DISMISSED');
    assert.match(settled.resolution!, /the approval of a1ffffffffff was dismissed and head changed from a1ffffffffff to a2ffffffffff/);
    assert.equal(summarizeReviews([settled]).completed[0].verdict, 'DISMISSED');
    const unsettled = sessionRetry([settled], first.id, Date.parse(settled.closedAt!) + sessionRetryBaseMs);
    assert.deepEqual([unsettled.settled, unsettled.launch, unsettled.attempts], [false, true, 1], 'the request is unanswered, to be launched afresh as its next attempt');
    // The control plane cancels the request for the replaced head and requests the new one.
    reconcileAutoDispatch(moved, [moved], new Date());
    const second = moved.autoDispatch!.review!;
    assert.equal(second.sha, H2); assert.notEqual(second.id, first.id);
    assert.equal(moved.autoDispatch!.history.at(-1)!.state, 'cancelled');
    // One tick launches the further attempt for the new head; nobody asked it to.
    const log: string[] = [];
    const ledger = (await readReviewLedger(root)).reviews;
    const tick = await runDispatchTick(config, emptyDispatchCursor(config), dispatchEffects(() => [moved], () => ledger, log, () => new Date().toISOString()), Date.now);
    assert.deepEqual(log, ['review:GY-84:a2ff:claude-reviewer']);
    assert.deepEqual(tick.launched.map(entry => [entry.kind, entry.sha, entry.requestId]), [['review', H2, second.id]]);
    assert.deepEqual(tick.waiting, []); assert.deepEqual(tick.refused, []);
  } finally { await cleanup(); }
});

test('integration:dismissal-without-head-change — an approval dismissed while the candidate is unchanged re-requests the same commit, and the relaunch is not answered by the dismissal it replaces', async () => {
  const { root, config, cleanup } = await reviewerRoot();
  try {
    let reviews: unknown[] = [];
    const { run, mint } = stubs(() => reviews);
    const at = new Date().toISOString();
    const item = work({}, at);
    reconcileAutoDispatch(item, [item], new Date());
    const request = item.autoDispatch!.review!;
    await launchReview(root, item, 'claude-reviewer', [], at, { run, mint, requestId: request.id });
    // The head has not moved: GitHub dismissed the approval under the same candidate.
    const dismissal = { state: 'DISMISSED', reviewer, reviewId: 11, submittedAt: iso(0) };
    const settled = (await reconcileReviews(root, config, { run, observe: () => dismissal, work: [item], now: () => new Date(clock) })).reviews[0];
    assert.equal(settled.state, 'failed');
    assert.match(settled.resolution!, /dismissed while it was still the candidate; the same commit is reviewed again/);
    assert.doesNotMatch(settled.resolution!, /head changed/);
    assert.equal(dismissalResolution(settled, [item]), settled.resolution);
    // The request stands for the same commit: no new head is demanded, and none is requested.
    assert.deepEqual(reconcileAutoDispatch(item, [item], new Date(clock + 1000)), []);
    assert.deepEqual([item.autoDispatch!.review!.id, item.autoDispatch!.review!.sha, item.autoDispatch!.review!.state], [request.id, H, 'requested']);
    // It is relaunched on the same widening wait every other unanswered session uses.
    const retry = sessionRetry((await readReviewLedger(root)).reviews, request.id, clock);
    assert.deepEqual([retry.attempts, retry.limit, retry.launch, retry.settled, retry.exhausted], [1, sessionRetryLimit, false, false, false]);
    assert.equal(retry.nextAt, new Date(clock + sessionRetryBaseMs).toISOString());
    const log: string[] = [], cursor = emptyDispatchCursor(config);
    const failedLedger = (await readReviewLedger(root)).reviews as any[];
    const effects = dispatchEffects(() => [item], () => failedLedger, log, () => new Date().toISOString());
    const early = await runDispatchTick(config, cursor, effects, () => clock + 1000);
    assert.deepEqual(early.launched, []);
    assert.match(early.waiting[0].reason, /reviewer session attempt 1 failed.*attempt 2 of 4 at /s);
    const due = await runDispatchTick(config, cursor, effects, () => clock + sessionRetryBaseMs + 1);
    assert.deepEqual(log, ['review:GY-84:a1ff:claude-reviewer']);
    assert.deepEqual(due.launched.map(entry => [entry.sha, entry.requestId]), [[H, request.id]]);
    // The real relaunch: attempt 2 of the same request, with the first session kept in the ledger.
    await launchReview(root, item, 'claude-reviewer', [], new Date().toISOString(), { run, mint, requestId: request.id });
    const relaunched = (await readReviewLedger(root)).reviews;
    assert.deepEqual(relaunched.map(record => [record.state, record.attempt]), [['failed', 1], ['pending', 2]]);
    // GitHub still lists the dismissed approval; the new session is not answered by a verdict its
    // predecessor already recorded, so the attempt is not burned the moment it starts.
    reviews = [{ id: 11, commit_id: H, user: { login: reviewer }, state: 'DISMISSED', submitted_at: iso(0) }];
    let reconciled = (await reconcileReviews(root, config, { run, work: [item], now: () => new Date(clock + 2000) })).reviews;
    assert.equal(reconciled[1].state, 'pending'); assert.equal(reconciled[1].verdict, undefined);
    // Its own approval of the same commit does answer it.
    reviews = [...reviews, { id: 12, commit_id: H, user: { login: reviewer }, state: 'APPROVED', submitted_at: iso(3000) }];
    reconciled = (await reconcileReviews(root, config, { run, work: [item], now: () => new Date(clock + 4000) })).reviews;
    assert.deepEqual([reconciled[1].state, reconciled[1].verdict!.state, reconciled[1].verdict!.reviewId], ['completed', 'APPROVED', 12]);
    // A standing approval the control plane has not observed yet leaves the settled session alone.
    assert.equal((await reconcileReviews(root, config, { run, work: [item], now: () => new Date(clock + 5000) })).reviews[1].state, 'completed');
    // GitHub withdraws it after the session closed: the closed session is reopened unanswered too,
    // so the request is relaunched rather than waiting on a verdict that no longer exists.
    reviews = [reviews[0], { id: 12, commit_id: H, user: { login: reviewer }, state: 'DISMISSED', submitted_at: iso(3000) }];
    const withdrawn = (await reconcileReviews(root, config, { run, work: [item], now: () => new Date(clock + 6000) })).reviews[1];
    assert.deepEqual([withdrawn.state, withdrawn.verdict!.state], ['failed', 'DISMISSED']);
    assert.match(withdrawn.resolution!, /dismissed while it was still the candidate/);
    assert.equal(sessionRetry([withdrawn], request.id, clock + 6000).settled, false);
  } finally { await cleanup(); }
});

test('unit:unsatisfied-settled-request-visible — master status names a request whose session settled without satisfying its gate, with the verdict, the elapsed time and the command that resolves it, apart from what is running', async () => {
  const item = work();
  reconcileAutoDispatch(item, [item], new Date(clock));
  const request = item.autoDispatch!.review!;
  const resolution = 'the approval of a1ffffffffff was dismissed while it was still the candidate; the same commit is reviewed again';
  const record = { review: 'r1', requestId: request.id, attempt: 4, work: 'GY-84', pr: 84, sha: H, policyRevision: 3, profile: 'claude-reviewer', agentName: 'review-claude-1',
    state: 'failed', verdict: 'DISMISSED', requestedAt: iso(0), tokenExpiresAt: iso(3_600_000), closedAt: iso(60_000), resolution, attention: null };
  const exhausted = { requestId: request.id, attempts: 4, started: 4, neverStarted: 0, limit: 4, unstartedLimit: 3, nextAt: null, exhausted: true, last: { state: 'failed', resolution } };
  // Sixty-three minutes after the request, with nothing running and nothing refused.
  const status = buildMasterStatus({ work: [item], now: iso(3_780_000) }, [], [], {}, {}, { pending: [], completed: [record] }, 'main', undefined,
    { producers: { pending: [], completed: [] }, failures: [], retries: [exhausted] });
  assert.equal(status.counts.dispatchRequested, 1);
  assert.equal(status.counts.dispatchRunning, 0, 'a settled session is not a request that is running');
  const attention = unansweredRequestAttention(status.work);
  assert.equal(attention.length, 1);
  assert.match(attention[0].text, /^Review request for GY-84 has stood unanswered for 1h3m: its session failed with verdict DISMISSED after attempt 4 — the approval of a1ffffffffff was dismissed/);
  assert.match(attention[0].text, /nothing is running for it and no further attempt is scheduled$/);
  assert.deepEqual([attention[0].subject, attention[0].role, attention[0].human], ['GY-84', 'master', false]);
  assert.match(attention[0].next, /graphyard master review GY-84 \[PROFILE\] forces the next attempt/);
  // A session still running, and one whose next attempt is already scheduled, are answers in progress.
  const progress = (session: RequestProgress['session'], retry: RequestProgress['retry'] = null): RequestProgress => ({ requestId: request.id, sinceMs: 3_780_000, session, retry });
  assert.equal(unansweredRequest(progress({ state: 'pending', attempt: 1 }), 'review'), null);
  assert.equal(unansweredRequest(progress({ state: 'failed', attempt: 1, resolution }, { attempts: 1, limit: 4, nextAt: iso(60_000), exhausted: false }), 'review'), null);
  assert.equal(unansweredRequest(progress(null), 'review'), null, 'a request whose session has not launched yet is waiting, not unanswered');
  for (const verdict of answeringVerdicts) assert.equal(unansweredRequest(progress({ state: 'completed', attempt: 1, verdict, resolution: null }), 'review'), null, `${verdict} answers the request; the control plane resolves it on its next observation`);
  assert.deepEqual(unansweredRequests(null), []);
  // A producer request in the same state is named for its group and routed to the rework decision.
  const producer: RequestProgress = { requestId: 'p1', sinceMs: 600_000, group: 'integration', session: { state: 'completed', attempt: 1, resolution: 'the session finished (done) without trusted evidence for integration:x (missing)' }, retry: null };
  const both = unansweredRequestAttention([{ key: 'GY-84', dispatch: { review: status.work[0].dispatch!.review as RequestProgress, producers: [producer] } }]);
  assert.equal(both.length, 2);
  assert.match(both[1].text, /^Producer request for integration proofs for GY-84 has stood unanswered for 10m: its session completed without a verdict after attempt 1 — the session finished/);
  assert.match(both[1].next, /graphyard master decide GY-84 rework REASON/);
  assert.equal(both[1].approvedBy, 'approver');
  assert.deepEqual(unansweredRequestOwner('GY-84', { kind: 'review' }).approvedBy, null);
  // `master status` reports them beside its other attention and counts them apart from what runs.
  const report = await readFile(new URL('../src/cli/master-status.ts', import.meta.url), 'utf8');
  assert.match(report, /const unanswered = unansweredRequestAttention\(status\.work\);/);
  assert.match(report, /attentionItems = \[\.\.\.diskAttention, \.\.\.scopeRequests, \.\.\.unanswered,/);
  assert.match(report, /dispatchUnanswered: unanswered\.length/);
  assert.match(report, /attention: status\.counts\.attention \+ diskAttention\.length \+ generatedFiles\.length \+ unanswered\.length/);
});

test('integration:master-review-forces-attempt — master review launches the open request\'s next attempt for a session that settled unanswered, keeping the first in the ledger', async () => {
  const { root, config, cleanup } = await reviewerRoot();
  try {
    const { run, mint } = stubs(() => []);
    const at = new Date().toISOString();
    const item = work({}, at);
    reconcileAutoDispatch(item, [item], new Date());
    const request = item.autoDispatch!.review!;
    // Every automatic attempt is spent: the request stands, and nothing will launch for it again.
    for (let attempt = 1; attempt <= sessionRetryLimit; attempt++) {
      await launchReview(root, item, 'claude-reviewer', [], new Date().toISOString(), { run, mint, requestId: request.id });
      await reconcileReviews(root, config, { run, observe: () => ({ state: 'DISMISSED', reviewer, reviewId: 10 + attempt, submittedAt: iso(attempt * 1000) }), work: [item], now: () => new Date(clock + attempt * 1000) });
    }
    const spent = (await readReviewLedger(root)).reviews;
    assert.equal(spent.length, sessionRetryLimit);
    assert.ok(spent.every(record => record.state === 'failed'));
    assert.ok(sessionRetry(spent, request.id, clock + 3_600_000).exhausted, 'no automatic attempt is left');
    const log: string[] = [];
    const held = await runDispatchTick(config, emptyDispatchCursor(config), dispatchEffects(() => [item], () => spent, log, () => new Date().toISOString()), () => clock + 3_600_000);
    assert.deepEqual(log, []); assert.match(held.waiting[0].reason, /no further automatic attempt|master review GY-84/);
    // `master review GY-84 claude-reviewer` answers that same request as its next attempt, rather
    // than recording a session the control plane's request knows nothing about.
    assert.equal(liveReviewRequest(item)!.id, request.id);
    const forced = await reviewCommand(root, ['GY-84', 'claude-reviewer'], { work: [item], now: new Date().toISOString() }, [], { run, mint });
    assert.equal(forced.requestId, request.id);
    const ledger = (await readReviewLedger(root)).reviews;
    assert.equal(ledger.length, sessionRetryLimit + 1, 'every earlier session is retained in the ledger');
    assert.deepEqual([ledger.at(-1)!.state, ledger.at(-1)!.attempt, ledger.at(-1)!.sha], ['pending', sessionRetryLimit + 1, H]);
    assert.ok(ledger.slice(0, sessionRetryLimit).every(record => record.state === 'failed' && /was dismissed/.test(record.resolution ?? '')));
    assert.equal(sessionRetry(ledger, request.id, clock + 3_600_000).settled, true, 'the forced attempt is the request\'s live session; the loop launches nothing beside it');
    // A head with no open request records none, which is the launch-refused recovery path unchanged.
    assert.equal(liveReviewRequest(work({ autoDispatch: { review: { ...request, sha: H2 }, producers: [], history: [] } })), null);
    assert.equal(liveReviewRequest(work({ autoDispatch: { review: { ...request, state: 'satisfied' }, producers: [], history: [] } })), null);
    assert.equal(liveReviewRequest(work()), null);
    // `master review` is exactly this command, and it refuses the same way it always did.
    const cli = await readFile(new URL('../src/cli/master.ts', import.meta.url), 'utf8');
    assert.match(cli, /if \(id === 'review'\) return print\(await reviewCommand\(root, args, await masterApi\('work-snapshot'\), await listHerdrAgents\(\)\)\);/);
    await assert.rejects(reviewCommand(root, [], { work: [item], now: new Date().toISOString() }, []), /Use master review GY-N/);
    await assert.rejects(reviewCommand(root, ['GY-9999'], { work: [item], now: new Date().toISOString() }, []), /Unknown work item GY-9999/);
  } finally { await cleanup(); }
});
