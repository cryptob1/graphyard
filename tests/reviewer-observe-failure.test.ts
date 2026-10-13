import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Observation, Work } from '../src/model.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { bindReviewer, launchReview, reconcileReviews, saveReviewerProfile } from '../src/reviewer.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { emptyDispatchCursor, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';
import { assertGhNotPaused, ghPausedUntil, notePossibleGhRateLimit, resetGhPause } from '../src/gh-pause.js';

// GY-1752: each test is named for the proof it produces: integration:review-read-failure-contained.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), H2 = sha40('a2'), B = sha40('b1');
const clock = Date.now();
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
    return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { root_pane: { pane_id: 'pane-review', tab_id: 'tab-review' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
  };
  return { calls, run, mint: async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() }) };
}

async function reviewerRoot() {
  const root = await temporaryDirectory('dismissed'), credentialDirectory = await temporaryDirectory('dismissed-credentials');
  execFileSync('git', ['init', '-q', root]); execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory, herdrWorkspace: 'wE' }, coordinatorStatus as typeof fetch);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentialDirectory, 'reviewers') }, async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
  await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' });
  return { root, credentialDirectory, config: await loadMasterConfig(root), cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); } };
}

test('integration:review-read-failure-contained — a GitHub read that fails (rate limit, timeout) leaves the pending session as it was instead of failing the pass, and the next pass settles it', async () => {
  const { root, config, cleanup } = await reviewerRoot();
  try {
    const { run, mint } = stubs(() => []);
    const at = new Date().toISOString();
    const item = work({}, at);
    reconcileAutoDispatch(item, [item], new Date());
    const request = item.autoDispatch!.review!;
    await launchReview(root, item, 'claude-reviewer', [], at, { run, mint, requestId: request.id });
    for (const message of ['gh: API rate limit exceeded for user ID 4241869. (HTTP 403)', 'The operation was aborted due to timeout']) {
      resetGhPause();
      let reads = 0;
      const pass = await reconcileReviews(root, config, { run, work: [item], observe: () => { reads++; throw new Error(message); } });
      assert.equal(reads, 1, 'after one failed read the pass reads no more');
      assert.equal(pass.reviews[0].state, 'pending', 'a session whose verdict could not be read is not judged unanswered');
      assert.equal(pass.reviews[0].verdict, undefined);
    }
    const approval = { state: 'APPROVED', reviewer, reviewId: 12, submittedAt: iso(0) };
    const settled = (await reconcileReviews(root, config, { run, work: [item], observe: () => approval })).reviews[0];
    assert.equal(settled.state, 'completed');
    assert.equal(settled.verdict!.state, 'APPROVED');
  } finally { resetGhPause(); await cleanup(); }
});

test('integration:review-read-failure-contained — a dispatcher tick whose review read is rate limited completes and still launches the reviewer another item is waiting for', async () => {
  const { root, config, cleanup } = await reviewerRoot();
  resetGhPause();
  try {
    await saveReviewerProfile(root, { name: 'claude-reviewer-2', agentName: 'review-claude-2', kind: 'claude' });
    const stub = stubs(() => []);
    const ghCalls: string[][] = [];
    const run = (command: string, args: string[]) => {
      if (command === 'gh') { ghCalls.push(args); if (args[1] === 'rate_limit') return String(Math.floor(Date.now() / 1000) + 1800); throw new Error('gh: API rate limit exceeded for user ID 4241869. (HTTP 403)'); }
      return stub.run(command, args);
    };
    const at = new Date().toISOString();
    const pending = work({}, at);
    reconcileAutoDispatch(pending, [pending], new Date());
    await launchReview(root, pending, 'claude-reviewer-2', [], at, { run: stub.run, mint: stub.mint, requestId: pending.autoDispatch!.review!.id });
    // The base's tick: the pending session's read throws out of reconcileReviews and fails the whole tick.
    const second = work({ id: 'work-85', key: 'GY-85' }, at);
    second.candidate = { ...second.candidate!, sha: H2, pr: 85, branch: 'graphyard/gy-85-1' };
    second.observation = observation(second.candidate!, at);
    reconcileAutoDispatch(second, [pending, second], new Date());
    const tick = await runDispatchTick(config, emptyDispatchCursor(config), {
      snapshot: async () => ({ work: [pending, second], now: at }), agents: () => [],
      credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
      reconcileReviews: (items, agents) => reconcileReviews(root, config, { run, work: items, agents }), reconcileProducers: async () => ({ producers: [] }),
      launchReview: (target, dispatch, profile, herdr, observedAt) => launchReview(root, target, profile.name, herdr, observedAt, { run: stub.run, mint: stub.mint, requestId: dispatch.id }),
      launchProducer: async () => { throw new Error('no producer is under test'); }, persist: async () => {},
    } satisfies DispatchEffects);
    assert.ok(tick.launched.some(launch => launch.work === 'GY-85' && launch.kind === 'review'), JSON.stringify(tick));
    assert.equal(ghCalls.filter(args => args[1] !== 'rate_limit').length, 1, 'the refused read is not repeated within the pass');
    // The next tick makes no gh read at all until the reset the login reported.
    const before = ghCalls.length;
    await reconcileReviews(root, config, { run, work: [pending, second] });
    assert.equal(ghCalls.length, before, 'no gh read while the pause stands');
    assert.ok(ghPausedUntil() > Date.now() + 1_000_000, 'the pause runs to the reported reset');
  } finally { resetGhPause(); await cleanup(); }
});

test('integration:review-read-failure-contained — the dispatcher’s own gh reads are skipped while the pause stands and resume at the reset', async () => {
  resetGhPause();
  try {
    const t0 = 1_800_000_000_000;
    const calls: string[][] = [];
    const run = (_command: string, args: string[]) => { calls.push(args); if (args[1] === 'rate_limit') return String(Math.floor(t0 / 1000) + 600); throw new Error('gh: API rate limit exceeded'); };
    assert.equal(await notePossibleGhRateLimit(new Error('HTTP 500'), run, t0), false, 'another failure starts no pause');
    assert.equal(ghPausedUntil(t0), 0);
    assert.equal(await notePossibleGhRateLimit(new Error('gh: API rate limit exceeded for user ID 4241869. (HTTP 403)'), run, t0), true);
    assert.equal(ghPausedUntil(t0), t0 + 601_000);
    assert.throws(() => assertGhNotPaused(t0 + 60_000), /paused until/);
    assert.doesNotThrow(() => assertGhNotPaused(t0 + 602_000), 'reads resume at the reset');
    // Without a readable reset the pause is a fixed five minutes.
    resetGhPause();
    await notePossibleGhRateLimit(new Error('API rate limit exceeded'), () => { throw new Error('also refused'); }, t0);
    assert.equal(ghPausedUntil(t0), t0 + 300_000);
  } finally { resetGhPause(); }
});

test('integration:review-read-failure-contained — after a rate-limited verdict read an eligible completed approval triggers no further GitHub work in the pass', async () => {
  const { root, config, cleanup } = await reviewerRoot();
  resetGhPause();
  try {
    const stub = stubs(() => []);
    const at = new Date().toISOString();
    const item = work({}, at);
    reconcileAutoDispatch(item, [item], new Date());
    await launchReview(root, item, 'claude-reviewer', [], at, { run: stub.run, mint: stub.mint, requestId: item.autoDispatch!.review!.id });
    const approval = { state: 'APPROVED', reviewer, reviewId: 12, submittedAt: iso(0) };
    await reconcileReviews(root, config, { run: stub.run, work: [item], observe: () => approval });
    const ghCalls: string[][] = [];
    const run = (command: string, args: string[]) => {
      if (command !== 'gh') return stub.run(command, args);
      ghCalls.push(args);
      if (args[1] === 'rate_limit') return String(Math.floor(Date.now() / 1000) + 1800);
      throw new Error('gh: API rate limit exceeded for user ID 4241869. (HTTP 403)');
    };
    const pass = await reconcileReviews(root, config, { run, work: [item] });
    assert.equal(pass.reviews[0].state, 'completed');
    assert.equal(pass.reviews[0].mechanicalFix, undefined, 'no permanent fallback is recorded from a refused read');
    assert.equal(ghCalls.filter(args => args[1] !== 'rate_limit').length, 1, JSON.stringify(ghCalls));
  } finally { resetGhPause(); await cleanup(); }
});

test('integration:review-read-failure-contained — a secondary-limit refusal pauses for the fixed backoff without reading the primary reset', async () => {
  resetGhPause();
  try {
    const t0 = 1_800_000_000_000;
    const calls: string[][] = [];
    const run = (_command: string, args: string[]) => { calls.push(args); return String(Math.floor(t0 / 1000) + 3000); };
    assert.equal(await notePossibleGhRateLimit(new Error('You have exceeded a secondary rate limit'), run, t0), true);
    assert.equal(calls.length, 0);
    assert.equal(ghPausedUntil(t0), t0 + 300_000);
  } finally { resetGhPause(); }
});

test('integration:review-read-failure-contained — a GitHub-backed reviewer launch is deferred while the pause stands, before any record or gh call', async () => {
  resetGhPause();
  const { root, cleanup } = await reviewerRoot();
  try {
    const t0 = Date.now();
    await notePossibleGhRateLimit(new Error('gh: API rate limit exceeded'), () => { throw new Error('refused'); }, t0);
    const { calls, run } = stubs(() => []);
    await assert.rejects(launchReview(root, work(), 'claude-reviewer', [], iso(0), { run, now: () => new Date(t0 + 1000) }), /gh reads are paused/);
    assert.deepEqual(calls, [], 'no gh or herdr call was made');
    assert.equal((await readFile(join(root, '.graphyard', 'review-ledger.json'), 'utf8').catch(() => '{"reviews":[]}')).includes('GY-84'), false, 'no record was reserved');
  } finally { resetGhPause(); await cleanup(); }
});

test('integration:review-read-failure-contained — a pause already standing at the start of a pass defers the thread, mechanical-plan and fresh-read reads and their permanent effects', async () => {
  const { root, config, cleanup } = await reviewerRoot();
  resetGhPause();
  try {
    const stub = stubs(() => []);
    const at = new Date().toISOString();
    const item = work({}, at);
    reconcileAutoDispatch(item, [item], new Date());
    await launchReview(root, item, 'claude-reviewer', [], at, { run: stub.run, mint: stub.mint, requestId: item.autoDispatch!.review!.id });
    await reconcileReviews(root, config, { run: stub.run, work: [item], observe: () => ({ state: 'APPROVED', reviewer, reviewId: 12, submittedAt: iso(0) }) });
    await notePossibleGhRateLimit(new Error('gh: API rate limit exceeded'), () => { throw new Error('refused'); }, Date.now());
    const ghCalls: string[][] = [];
    const run = (command: string, args: string[]) => { if (command !== 'gh') return stub.run(command, args); ghCalls.push(args); throw new Error('gh: API rate limit exceeded'); };
    // The request no longer stands, so the dismissal re-read is skipped and only the downstream reads remain.
    const pass = await reconcileReviews(root, config, { run, work: [{ ...item, autoDispatch: undefined } as Work] });
    assert.deepEqual(ghCalls, [], 'no gh read while the pause stands');
    assert.equal(pass.reviews[0].mechanicalFix, undefined, 'no permanent fallback is recorded');
  } finally { resetGhPause(); await cleanup(); }
});
