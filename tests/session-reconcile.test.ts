import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { bindReviewer, launchReview, readReviewLedger, reconcileReviews, saveReviewerProfile, type ReviewRecord } from '../src/reviewer.js';
import { readProducerLedger, reconcileProducers, saveProducerLedger, type ProducerRecord } from '../src/producer.js';
import { expiredRequestBoundMs, paneAlreadyGone, stuckRequests } from '../src/request-settlement.js';
import { sessionReconcileIntervalMs } from '../src/model/sessions.js';
import { stuckRequestReport, withStuckRequests } from '../src/cli/stuck-requests.js';
import type { Observation, Work } from '../src/model.js';

// Each test is named for the proof it produces (GY-137): integration:absent-pane-resolves-request,
// integration:expired-request-never-blocks and unit:stuck-request-surfaced. A session whose pane is
// already gone settles its request instead of failing the close; no request outlives its own token
// once Herdr no longer reports its session; and a request pending anyway is counted and raised.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('c1'), B = sha40('b1');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const mint = async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() });

async function boundMaster() {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-session-reconcile-')), credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-session-reconcile-credentials-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory, herdrWorkspace: 'wE' }, coordinatorStatus as typeof fetch);
  await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentialDirectory, 'reviewers') }, async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
  await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' });
  return { root, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); } };
}

function observation(candidate: { sha: string; baseSha: string }): Observation {
  return { candidate: { ...candidate, pr: 127, branch: 'graphyard/gy-127-1', author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/a.ts'], scopeFiles: [], at: new Date().toISOString(), prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: sha40('7b'), baseTipContained: true } as Observation;
}
function work(): Work {
  const candidate = { sha: H, baseSha: B, pr: 127, branch: 'graphyard/gy-127-1', author: 'implementer' };
  return { id: 'work-127', key: 'GY-127', title: 'Queue tip approval', description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Review', proofs: ['integration:absent-pane-resolves-request'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' },
    stage: 'review', revision: 7, policyRevision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stageEnteredAt: new Date().toISOString(), ready: true, epoch: 1,
    lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 127 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: observation(candidate), blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], violations: [] } as unknown as Work;
}

/**
 * A Herdr run stub: the tab create names pane-review; a pane close answers as Herdr does for a pane
 * that does not exist (`pane_not_found`), fails for another reason, or succeeds; the pane list is empty.
 */
type Close = 'absent' | 'broken' | 'ok';
const herdrRun = (calls: string[][], close: Close) => (_command: string, args: string[]) => {
  calls.push(args);
  if (args[0] === 'pane' && args[1] === 'close') {
    if (close === 'absent') return JSON.stringify({ error: { code: 'pane_not_found' } });
    if (close === 'broken') throw new Error('herdr: connection reset by the server socket');
  }
  return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'pane-review', tab_id: 'tab-review' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
};
const afterExpiry = (record: { tokenExpiresAt: string }, ms = 1) => () => new Date(Date.parse(record.tokenExpiresAt) + ms);

test('integration:absent-pane-resolves-request — a pane close answered with pane_not_found settles the request with a resolution naming the absent pane, records no failure, and the next launch is accepted', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    const calls: string[][] = [];
    const item = work();
    await launchReview(root, item, 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun(calls, 'ok'), mint, requestId: 'review-request' });
    const record: ReviewRecord = (await readReviewLedger(root)).reviews[0];
    // The session is still listed by Herdr (so nothing is forced), its token has expired, and its
    // pane was closed by hand before the reconcile got to it: Herdr answers the close pane_not_found.
    const agents = [{ name: record.agentName, pane_id: 'pane-review', agent_status: 'working' }];
    const settled = await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun(calls, 'absent'), observe: () => null, agents, now: afterExpiry(record) });
    const after = settled.reviews[0];
    assert.equal(after.state, 'expired', 'the absent pane satisfies the close, so the request reaches its terminal state');
    assert.ok(after.closedAt, 'the record is closed');
    assert.equal(after.closeFailure, undefined, 'an absent pane is not a close failure');
    assert.match(after.resolution!, /the reviewer token expired at/);
    assert.match(after.resolution!, /pane pane-review was already gone when the session was closed/);
    assert.deepEqual(calls.filter(args => args[0] === 'pane' && args[1] === 'close').at(-1), ['pane', 'close', 'pane-review']);
    // The settled request no longer holds the key: a new review launch for the same item proceeds.
    const next = await launchReview(root, item, 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun(calls, 'ok'), mint, requestId: 'review-request' });
    assert.equal(next.work, 'GY-127');
    assert.deepEqual((await readReviewLedger(root)).reviews.map(entry => entry.state), ['expired', 'pending']);
  } finally { await cleanup(); }
});

test('integration:absent-pane-resolves-request — a close failing for any other reason is still recorded as a failure and keeps the request pending while its session is reported', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    const calls: string[][] = [];
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun(calls, 'ok'), mint, requestId: 'review-request' });
    const record: ReviewRecord = (await readReviewLedger(root)).reviews[0];
    const agents = [{ name: record.agentName, pane_id: 'pane-review', agent_status: 'working' }];
    const held = await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun(calls, 'broken'), observe: () => null, agents, now: afterExpiry(record) });
    assert.equal(held.reviews[0].state, 'pending');
    assert.match(held.reviews[0].closeFailure!, /Herdr could not close pane pane-review: herdr: connection reset/);
    assert.equal(held.reviews[0].closedAt, undefined);
    await assert.rejects(launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun(calls, 'ok'), mint }), /already pending/);
    // The classification itself: Herdr's code, or the code in a message, and nothing else.
    assert.equal(paneAlreadyGone(Object.assign(new Error('Herdr refused the operation'), { herdrCode: 'pane_not_found' })), true);
    assert.equal(paneAlreadyGone(new Error('Herdr refused the operation: pane_not_found')), true);
    assert.equal(paneAlreadyGone(new Error('Herdr still reports pane pane-review after close')), false);
    assert.equal(paneAlreadyGone(Object.assign(new Error('Herdr refused the operation'), { herdrCode: 'permission_denied' })), false);
  } finally { await cleanup(); }
});

test('integration:absent-pane-resolves-request — a producer request whose pane is already gone settles the same way, and a master-daemon ended session does too', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    const now = new Date(), requested = new Date(now.getTime() - 3 * 3_600_000);
    const base: ProducerRecord = { id: randomUUID(), requestId: 'producer-request', attempt: 1, key: 'GY-127', pr: 127, sha: H, baseSha: B, policyRevision: 1, group: 'integration', proofs: ['integration:absent-pane-resolves-request'],
      profile: 'producer', principal: 'producer-1', agentName: 'proof-claude-1', pane: 'pane-proof', requestedAt: requested.toISOString(), expiresAt: new Date(requested.getTime() + 7_200_000).toISOString(),
      state: 'pending', outcome: { 'integration:absent-pane-resolves-request': 'missing' } } as ProducerRecord;
    await saveProducerLedger(root, { version: 1, producers: [base] } as Parameters<typeof saveProducerLedger>[1]);
    const agents = [{ name: 'proof-claude-1', pane_id: 'pane-proof', agent_status: 'working' }];
    const settled = await reconcileProducers(root, await loadMasterConfig(root), [work()], agents, { run: herdrRun([], 'absent'), now: () => now, reprompt: () => {} });
    const after = settled.producers[0];
    assert.equal(after.state, 'expired');
    assert.equal(after.closeFailure, undefined);
    assert.match(after.resolution!, /pane pane-proof was already gone/);
    assert.equal((await readProducerLedger(root)).producers[0].state, 'expired');
    // The loop's own mid-session closure (quota failover) tolerates the absent pane the same way.
    const daemon = await readFile(new URL('../src/master-daemon.ts', import.meta.url), 'utf8');
    assert.match(daemon, /catch \(error\) \{ if \(!paneAlreadyGone\(error\)\) throw error; paneGone = true; \}/);
  } finally { await cleanup(); }
});

test('integration:expired-request-never-blocks — a request past its token expiry whose session Herdr no longer reports settles as expired within the bound, whatever its pane state, and a new launch for the item is accepted', async () => {
  assert.equal(expiredRequestBoundMs, sessionReconcileIntervalMs, 'the bound is one reconcile pass, which every dispatch tick runs');
  const { root, cleanup } = await boundMaster();
  try {
    const calls: string[][] = [];
    const item = work();
    await launchReview(root, item, 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun(calls, 'ok'), mint, requestId: 'review-request' });
    const record: ReviewRecord = (await readReviewLedger(root)).reviews[0];
    const config = await loadMasterConfig(root);
    assert.ok(config.run.dispatchIntervalSeconds * 1000 <= expiredRequestBoundMs, 'the reconcile runs at least as often as the bound it declares');
    // Before the token expires, a pane that cannot be closed and a session Herdr no longer reports
    // leave the request to the ordinary idle grace — nothing settles it early.
    const early = await reconcileReviews(root, config, { run: herdrRun(calls, 'broken'), observe: () => null, agents: [], now: () => new Date(Date.parse(record.tokenExpiresAt) - 60_000), retry: () => {} });
    assert.equal(early.reviews[0].state, 'pending');
    // The token has expired and Herdr lists no session: the very next pass inside the bound settles
    // the request as expired even though the pane close still fails, keeping that failure as attention.
    const settled = await reconcileReviews(root, config, { run: herdrRun(calls, 'broken'), observe: () => null, agents: [], now: afterExpiry(record, expiredRequestBoundMs - 1) });
    const after = settled.reviews[0];
    assert.equal(after.state, 'expired');
    assert.ok(after.closedAt && Date.parse(after.closedAt) - Date.parse(record.tokenExpiresAt) <= expiredRequestBoundMs, 'resolved within the bound of its expiry');
    assert.match(after.resolution!, /the reviewer token expired at/);
    assert.match(after.closeFailure!, /Herdr could not close pane pane-review/);
    // Nothing blocks the next launch for the same item.
    const next = await launchReview(root, item, 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun(calls, 'ok'), mint, requestId: 'review-request' });
    assert.equal(next.work, 'GY-127');
    assert.deepEqual((await readReviewLedger(root)).reviews.map(entry => entry.state), ['expired', 'pending']);
    // docs/master-agent.md states both rules and how to read a request pending past its expiry.
    const docs = await readFile(new URL('../docs/master-agent.md', import.meta.url), 'utf8');
    for (const phrase of ['pane_not_found', 'No request outlives its own token', 'sessionReconcile.stuck']) assert.ok(docs.includes(phrase), `docs/master-agent.md names ${phrase}`);
  } finally { await cleanup(); }
});

test('unit:stuck-request-surfaced — a request pending past its token expiry, or holding a close failure, is counted in sessionReconcile and raised as attention naming the item, the request, how long and the remedy', () => {
  const now = Date.parse('2026-09-23T07:36:30.000Z');
  const review = { id: '82d85911-0000-4000-8000-000000000001', key: 'GY-127', requestId: 'review-request-127', agentName: 'review-claude-1', pane: 'w1V:p1CD', state: 'pending',
    requestedAt: '2026-09-23T04:36:34.000Z', tokenExpiresAt: '2026-09-23T05:36:30.000Z', closeFailure: 'Herdr could not close pane w1V:p1CD: herdr: connection reset' };
  const producer = { id: '82d85911-0000-4000-8000-000000000002', key: 'GY-118', requestId: 'producer-request-118', agentName: 'proof-claude-1', pane: 'pane-proof', state: 'pending',
    requestedAt: '2026-09-23T07:26:30.000Z', expiresAt: '2026-09-23T09:26:30.000Z', closeFailure: 'Herdr could not close pane pane-proof: herdr: timeout' };
  const healthy = { ...producer, id: '82d85911-0000-4000-8000-000000000003', key: 'GY-99', closeFailure: undefined };
  const settled = { ...review, id: '82d85911-0000-4000-8000-000000000004', key: 'GY-98', state: 'expired' };
  const records = { reviews: [review, settled], producers: [producer, healthy] };
  assert.equal(stuckRequests(records, now).length, 2, 'a healthy pending request and a settled one are not stuck');
  const report = stuckRequestReport(records, now);
  assert.equal(report.attentionItems.length, 2);
  const [first, second] = report.attentionItems;
  assert.equal(first.subject, 'GY-127');
  assert.match(first.text, /reviewer request review-request-127 on GY-127/);
  assert.match(first.text, /pending 2h0m past its token expiry at 2026-09-23T05:36:30.000Z/);
  assert.match(first.text, /refuses every later reviewer launch for GY-127/);
  assert.equal(first.role, 'master');
  assert.match(first.next, /herdr pane close w1V:p1CD/);
  assert.match(first.next, /graphyard master status settles the request as expired within 30s/);
  assert.equal(second.subject, 'GY-118');
  assert.match(second.text, /producer request producer-request-118 on GY-118 .* pending 10m since 2026-09-23T07:26:30.000Z; its pane could not be closed: Herdr could not close pane pane-proof: herdr: timeout/);
  // The counter sits beside the sweep's own, where an operator already looks.
  const dispatch = withStuckRequests({ running: true, sessionReconcile: { intervalMs: 30_000, closed: 0, missing: 0, failures: [] } }, report.stuck);
  const reconcile = dispatch.sessionReconcile as unknown as { closed: number; stuck: number; stuckRequests: { work: string; request: string; stuckMs: number; expired: boolean }[] };
  assert.equal(reconcile.stuck, 2);
  assert.equal(reconcile.closed, 0, 'the existing counters are kept');
  assert.deepEqual(reconcile.stuckRequests.map(entry => [entry.work, entry.request, entry.expired]), [['GY-127', 'review-request-127', true], ['GY-118', 'producer-request-118', false]]);
  assert.equal(reconcile.stuckRequests[0].stuckMs, 2 * 3_600_000);
  // An unreadable cursor has no sweep to count beside, and is returned as it is.
  const unreadable = { running: false, error: 'unreadable' };
  assert.equal(withStuckRequests(unreadable, report.stuck), unreadable);
  // Nothing stuck: the counter reads zero and no item is raised.
  assert.equal((withStuckRequests({ sessionReconcile: {} }, []).sessionReconcile as { stuck: number }).stuck, 0);
  assert.equal(stuckRequestReport({ reviews: [], producers: [healthy] }, now).attentionItems.length, 0);
});

test('unit:stuck-request-surfaced — master status counts and raises stuck requests beside the dispatcher summary', async () => {
  const report = await readFile(new URL('../src/cli/master-status.ts', import.meta.url), 'utf8');
  assert.match(report, /stuckRequestReport\(\{ reviews: reviewRecords, producers: producerRecords \}, Date\.now\(\)\)/);
  assert.match(report, /withStuckRequests\(dispatchSummary\(/);
  assert.match(report, /\.\.\.stuck\.attentionItems/);
  assert.match(report, /stuckRequests: stuck\.stuck\.length/);
});
