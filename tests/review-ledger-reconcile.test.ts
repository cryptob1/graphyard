import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadMasterConfig, sessionHarnessPlan, setupMaster, type MasterConfig } from '../src/master.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { bindReviewer, launchReview, readReviewLedger, reconcileReviews, reviewIdleGraceMs, reviewPrompt, reviewRetryPrompt, saveReviewerProfile, staleReviewReason, type ReviewRecord } from '../src/reviewer.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import type { Observation, Work } from '../src/model.js';
import { emptyDispatchCursor, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';

// Each test is named for the proof it produces, so acceptance evidence maps to one executed
// case per required proof: integration:review-ledger-reconcile and
// integration:reviewer-posts-autonomously. GY-78: a reviewer verdict posted on the exact head
// always settles its ledger record, a superseded head never blocks the current head's review,
// and a session that stops before posting is retried by the dispatch loop itself.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), H2 = sha40('a2'), B = sha40('b1');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const mint = async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() });
const verdict = (state = 'APPROVED') => ({ state, reviewer: 'graphyard-reviewer[bot]', reviewId: 77, submittedAt: new Date().toISOString() });

async function boundMaster() {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-review-ledger-')), credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-review-ledger-credentials-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory, herdrWorkspace: 'wE' }, coordinatorStatus as typeof fetch);
  await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentialDirectory, 'reviewers') }, async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
  await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' });
  return { root, credentialDirectory, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); } };
}

function observation(candidate: { sha: string; baseSha: string }, extra: Partial<Observation> = {}): Observation {
  return { candidate: { ...candidate, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/a.ts'], scopeFiles: [], at: new Date().toISOString(), prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: sha40('7b'), baseTipContained: true, ...extra };
}
function work(overrides: Partial<Work> = {}): Work {
  const candidate = { sha: H, baseSha: B, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' };
  return { id: 'work-64', key: 'GY-64', title: 'Reviewer ledger', description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Review', proofs: ['integration:review-ledger-reconcile'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' },
    stage: 'review', revision: 7, policyRevision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stageEnteredAt: new Date().toISOString(), ready: true, epoch: 1,
    lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 64 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: observation(candidate), blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], violations: [], ...overrides } as unknown as Work;
}
const moved = () => {
  const candidate = { sha: H2, baseSha: B, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' };
  return work({ candidate, observation: observation(candidate) });
};
/** A Herdr run stub: the tab create names pane-review, pane list reports the panes gone. */
const herdrRun = (calls: string[][], failClose = false) => (_command: string, args: string[]) => {
  calls.push(args);
  if (failClose && args[0] === 'pane' && args[1] === 'close') throw new Error('pane close refused');
  return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'pane-review', tab_id: 'tab-review' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
};

test('integration:review-ledger-reconcile — a verdict GitHub shows on the exact head completes the record however the post happened, even when Herdr cannot close the pane, and stops blocking the next launch', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    const calls: string[][] = [];
    const run = herdrRun(calls);
    const item = work();
    await launchReview(root, item, 'claude-reviewer', [], new Date().toISOString(), { run, mint });
    const sessionDirectory = (await readReviewLedger(root)).reviews[0].sessionDirectory;
    // The verdict lands (first attempt or after a retry) while Herdr cannot confirm the pane:
    // the record is completed anyway, with the close failure kept as attention on the record.
    const settled = await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun(calls, true), observe: () => verdict('CHANGES_REQUESTED') });
    assert.equal(settled.reviews[0].state, 'completed', 'a posted verdict is never left pending');
    assert.equal(settled.reviews[0].verdict!.state, 'CHANGES_REQUESTED');
    assert.match(settled.reviews[0].closeFailure!, /Herdr could not close pane pane-review/);
    // Settling withdraws the credential even when the pane could not be closed: nothing revisits
    // a settled record, so a session token left there would survive until it expired on its own.
    await assert.rejects(stat(join(sessionDirectory, 'hosts.yml')), /ENOENT/, 'the session credential is withdrawn');
    // Settled records are not re-observed and not re-settled.
    const again = await reconcileReviews(root, await loadMasterConfig(root), { run, observe: () => { throw new Error('a settled record is not re-observed'); } });
    assert.equal(again.changed, 0);
    assert.equal((await readReviewLedger(root)).reviews[0].state, 'completed');
    // The completed record no longer holds the key: the next review request launches.
    const next = await launchReview(root, item, 'claude-reviewer', [], new Date().toISOString(), { run, mint });
    assert.equal(next.work, 'GY-64');
    const ledger = await readReviewLedger(root);
    assert.deepEqual(ledger.reviews.map(record => record.state), ['completed', 'pending']);
  } finally { await cleanup(); }
});

test('integration:review-ledger-reconcile — a pending record for a superseded head is cancelled at launch and never blocks the current head, while a record for the exact candidate still does', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    const calls: string[][] = [];
    const run = herdrRun(calls);
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run, mint });
    await assert.rejects(launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run, mint }), /already pending on a1f+/);
    // The head moved on (rework pushed): launching for the new head cancels the old record and proceeds.
    const launched = await launchReview(root, moved(), 'claude-reviewer', [], new Date().toISOString(), { run, mint });
    assert.equal(launched.sha, H2);
    const ledger = await readReviewLedger(root);
    assert.deepEqual(ledger.reviews.map(record => record.state), ['cancelled', 'pending']);
    assert.equal(ledger.reviews[1].sha, H2);
    assert.match(ledger.reviews[0].resolution!, new RegExp(`head changed from ${H.slice(0, 12)} to ${H2.slice(0, 12)}`));
    assert.deepEqual(calls.filter(args => args[0] === 'pane' && args[1] === 'close').at(-1), ['pane', 'close', 'pane-review']);
    assert.equal(staleReviewReason(ledger.reviews[1], [moved()]), null, 'the new record matches the current candidate');
  } finally { await cleanup(); }
});

test('integration:review-ledger-reconcile — a session that stops before posting is prompted once by the reconcile itself, and a verdict posted after that retry completes the record', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    const calls: string[][] = [];
    const run = herdrRun(calls);
    const config = await loadMasterConfig(root);
    const item = work();
    await launchReview(root, item, 'claude-reviewer', [], new Date().toISOString(), { run, mint, requestId: 'review-request' });
    const record: ReviewRecord = (await readReviewLedger(root)).reviews[0];
    const start = Date.parse(record.requestedAt);
    const blocked = [{ name: 'review-claude-1', pane_id: 'pane-review', agent_status: 'blocked' }];
    // First sight of the ended session: the loop prompts it once, in Herdr, to post the verdict.
    const first = await reconcileReviews(root, config, { run, observe: () => null, work: [item], agents: blocked, now: () => new Date(start + 1000) });
    assert.equal(first.reviews[0].state, 'pending', 'the retry prompt is given before any failure is recorded');
    assert.equal(first.reviews[0].idleSince, new Date(start + 1000).toISOString());
    const prompts = calls.filter(args => args[0] === 'agent' && args[1] === 'prompt' && String(args[3]).startsWith('You stopped before posting'));
    assert.equal(prompts.length, 1);
    assert.match(prompts[0][3], new RegExp(`gh api --method POST repos/owner/project/pulls/${record.pr}/reviews -f commit_id=${record.sha}`));
    assert.match(prompts[0][3], /Do not ask for confirmation/);
    // Still within the grace: no second prompt, no failure, the session may still post.
    const waiting = await reconcileReviews(root, config, { run, observe: () => null, work: [item], agents: blocked, now: () => new Date(start + 60_000) });
    assert.equal(waiting.reviews[0].state, 'pending');
    assert.equal(calls.filter(args => args[0] === 'agent' && args[1] === 'prompt' && String(args[3]).startsWith('You stopped before posting')).length, 1, 'the retry prompt is sent once');
    // The session posts after the prompt: the record completes on the same terms as a first attempt.
    const posted = await reconcileReviews(root, config, { run, observe: () => verdict('CHANGES_REQUESTED'), work: [item], agents: blocked, now: () => new Date(start + 120_000) });
    assert.equal(posted.reviews[0].state, 'completed');
    assert.equal(posted.reviews[0].verdict!.state, 'CHANGES_REQUESTED');
    assert.equal(posted.reviews[0].resolution, undefined);
  } finally { await cleanup(); }
});

test('integration:reviewer-posts-autonomously — the launch grants the post as part of the role in settings and prompt, and the dispatch loop itself retries a session that ends without posting', async () => {
  // Settings: the role allows exactly the one review POST for the launched pull request.
  const input = { cliPath: launcher, repository: 'owner/project', baseBranch: 'main', credentialHome: '/home/x/.config/graphyard', credentialDirectories: ['/home/x/.config/graphyard/masters'] };
  const reviewer = sessionHarnessPlan({ ...input, role: 'reviewer', kind: 'claude', pr: 64 });
  const post = 'gh api --method POST repos/owner/project/pulls/64/reviews -f commit_id=abc -f event=APPROVE -f body=judged';
  assert.ok(reviewer.allow.some(entry => entry.rule === 'Bash(gh api --method POST repos/owner/project/pulls/64/reviews*)'));
  assert.equal(reviewer.deny.some(entry => entry.rule.includes('reviews')), false, 'the reviewer role denies no review call');
  const denied = (command: string) => reviewer.deny.some(entry => {
    const body = entry.rule.match(/^Bash\((.*)\)$/)?.[1]; if (!body) return false;
    return new RegExp(`^${body.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(command);
  });
  assert.equal(denied(post), false, 'nothing in the reviewer rules blocks the verdict it was launched to post');
  // Prompt: posting is granted, never a permission to request.
  const binding = { key: 'GY-64', pr: 64, sha: H, baseSha: B, policyRevision: 1, author: 'implementer', branch: 'graphyard/gy-64-1' };
  const prompt = reviewPrompt({ repository: 'owner/project' } as MasterConfig, binding);
  assert.match(prompt, /Posting that review is granted to this session's role, not a permission to request/);
  assert.match(prompt, /without asking for confirmation/);
  assert.match(reviewRetryPrompt('owner/project', { key: 'GY-64', pr: 64, sha: H }), new RegExp(`gh api --method POST repos/owner/project/pulls/64/reviews -f commit_id=${H}`));
  assert.match(reviewRetryPrompt('owner/project', { key: 'GY-64', pr: 64, sha: H }), /Do not ask for confirmation/);

  // The dispatch loop itself: it prompts the ended session, and relaunches the request once the
  // grace expires — the master never sends a retry prompt by hand.
  const { root, cleanup } = await boundMaster();
  try {
    const config = await loadMasterConfig(root);
    // GY-115: the review request follows the head's mechanical proofs, so the head is proven first.
    const item = work({ evidence: [{ id: 'ev-1', proof: 'integration:review-ledger-reconcile', sha: H, baseSha: B, policyRevision: 1, producer: 'proof-runner', trusted: true, result: 'pass', executed: 2, skipped: 0, at: new Date().toISOString() }] });
    reconcileAutoDispatch(item, [item], new Date());
    const request = item.autoDispatch!.review!;
    const calls: string[][] = [];
    const run = herdrRun(calls);
    await launchReview(root, item, 'claude-reviewer', [], new Date().toISOString(), { run, mint, requestId: request.id });
    const prompts: string[] = [];
    const launches: string[] = [];
    let clock = Date.now();
    let agents: { name?: string; pane_id?: string; agent_status?: string }[] = [{ name: 'review-claude-1', pane_id: 'pane-review', agent_status: 'blocked' }];
    const effects: DispatchEffects = {
      snapshot: async () => ({ work: [item], now: new Date(clock).toISOString() }),
      agents: () => agents,
      credentials: async () => ({}),
      reconcileReviews: async (work, agents) => reconcileReviews(root, config, { run, work, agents, observe: () => null, now: () => new Date(clock), retry: (_record, message) => { prompts.push(message); } }),
      reconcileProducers: async () => ({ producers: [] }),
      launchReview: async () => { launches.push(new Date(clock).toISOString()); },
      launchProducer: async () => { throw new Error('no producer session is expected in this scenario'); },
      persist: async () => {},
    };
    const cursor = emptyDispatchCursor(config);
    const first = await runDispatchTick(config, cursor, effects, () => clock);
    assert.equal(first.launched.length, 0, 'the pending session holds the request');
    assert.equal(prompts.length, 1, 'the loop prompted the ended session itself');
    assert.match(prompts[0], /Do not ask for confirmation/);
    assert.equal((await readReviewLedger(root)).reviews[0].state, 'pending');
    // The session never posts: after the grace the record fails, and one retry wait later the
    // same loop relaunches the request as its next attempt — no master in the loop.
    clock += reviewIdleGraceMs + 2_000;
    const second = await runDispatchTick(config, cursor, effects, () => clock);
    assert.equal(second.launched.length, 0);
    assert.equal(prompts.length, 1, 'the failed session is not prompted again');
    const failed = (await readReviewLedger(root)).reviews[0];
    assert.equal(failed.state, 'failed');
    assert.equal(failed.attempt, 1);
    clock += 61_000;
    agents = [];
    const third = await runDispatchTick(config, cursor, effects, () => clock);
    assert.deepEqual(third.launched.map(launch => launch.kind), ['review']);
    assert.deepEqual(third.launched.map(launch => launch.work), ['GY-64']);
  } finally { await cleanup(); }
});
