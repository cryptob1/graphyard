import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { bindReviewer, launchReview, readReviewLedger, reconcileReviews, saveReviewerProfile, summarizeReviews, updateReviewLedger } from '../src/reviewer.js';
import type { Observation, Work } from '../src/model.js';

// The reviewer names the threads it verified fixed on a `Resolved threads:` line of its approval;
// the loop resolves exactly those, with its own GitHub access, once it holds that approval of the
// current candidate (or of the head whose approval was carried onto it). Nothing else is resolved.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), H2 = sha40('a2'), B = sha40('b1'), B2 = sha40('b2');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const mint = async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() });
const reviewer = 'graphyard-reviewer[bot]';
const submittedAt = '2026-09-23T12:00:00Z';
const verdict = (state = 'APPROVED') => ({ state, reviewer, reviewId: 77, submittedAt });

async function boundMaster() {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-threads-')), credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-threads-credentials-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory, herdrWorkspace: 'wE' }, coordinatorStatus as typeof fetch);
  await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentialDirectory, 'reviewers') }, async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
  await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' });
  return { root, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); } };
}
function observation(candidate: { sha: string; baseSha: string }): Observation {
  return { candidate: { ...candidate, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/a.ts'], scopeFiles: [], at: new Date().toISOString(), prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: sha40('7b'), baseTipContained: true };
}
function work(candidateSha = H, baseSha = B, overrides: Partial<Work> = {}): Work {
  const candidate = { sha: candidateSha, baseSha, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' };
  return { id: 'work-64', key: 'GY-64', title: 'Threads', description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Review', proofs: ['unit:threads'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' },
    stage: 'review', revision: 7, policyRevision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stageEnteredAt: new Date().toISOString(), ready: true, epoch: 1,
    lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 64 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: observation(candidate), blocker: null, gates: [], violations: [], ...overrides } as unknown as Work;
}
const herdrRun = (_command: string, args: string[]) => startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'pane-review', tab_id: 'tab-review' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });

/** GitHub as the loop's own gh sees it: the approval, the PR's threads, and the resolve mutation. */
function github(options: { body: string; state?: string }) {
  const calls: string[][] = [], resolved: string[] = [];
  const thread = (id: string, createdAt: string) => ({ id, isResolved: resolved.includes(id), isOutdated: false, path: 'src/a.ts', line: 3, comments: { nodes: [{ author: { login: 'codex' }, body: 'finding', createdAt }] } });
  const run = (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (command !== 'gh') throw new Error(`unexpected ${command}`);
    if (args[1] === `repos/owner/project/pulls/64/reviews/77`) return JSON.stringify({ id: 77, state: options.state ?? 'APPROVED', commit_id: H, user: { login: reviewer }, submitted_at: submittedAt, body: options.body });
    const query = args.find(arg => arg.startsWith('query=')) ?? '';
    if (query.includes('resolveReviewThread')) {
      const id = args.find(arg => arg.startsWith('thread='))!.slice('thread='.length);
      resolved.push(id);
      return JSON.stringify({ data: { resolveReviewThread: { thread: { id, isResolved: true } } } });
    }
    if (query.includes('reviewThreads')) return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
      thread('PRRT_fixed0001', '2026-09-23T11:00:00Z'), thread('PRRT_unnamed01', '2026-09-23T11:00:00Z'), thread('PRRT_later0001', '2026-09-23T12:30:00Z')] } } } } });
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { run, calls, resolved };
}
const body = 'The fix is correct.\nResolved threads: PRRT_fixed0001 PRRT_later0001 PRRT_gone00001';

test('the loop resolves only the named, pre-existing, unresolved threads after an approval of the current head, once', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint });
    const gh = github({ body });
    const config = await loadMasterConfig(root);
    const settled = await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run });
    assert.deepEqual(gh.resolved, ['PRRT_fixed0001'], 'only the named thread opened before the approval is resolved; the unnamed one never');
    const record = settled.reviews[0];
    assert.deepEqual(record.threadResolution?.named, ['PRRT_fixed0001', 'PRRT_later0001', 'PRRT_gone00001']);
    assert.deepEqual(record.threadResolution?.resolved, ['PRRT_fixed0001']);
    assert.equal(record.threadResolution?.failure, undefined);
    assert.ok(record.threadResolution?.refused.some(entry => entry.startsWith('PRRT_later0001: not opened before review 77')));
    assert.ok(record.threadResolution?.refused.some(entry => entry.startsWith('PRRT_gone00001: not an unresolved thread')));
    assert.ok(settled.threads.some(line => line.startsWith('resolved review thread PRRT_fixed0001 on GY-64 PR #64')), settled.threads.join('\n'));
    assert.deepEqual((summarizeReviews(settled.reviews).completed[0] as any).threadResolution.resolved, ['PRRT_fixed0001']);
    // Settled: the next pass leaves GitHub alone.
    const before = gh.calls.length;
    const again = await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run });
    assert.equal(gh.calls.length, before); assert.deepEqual(again.threads, []);
  } finally { await cleanup(); }
});

test('nothing is resolved on CHANGES_REQUESTED, for a stale head, or by a prose-only approval of a prompt that listed no thread', async () => {
  for (const scenario of [
    { name: 'changes requested', verdict: verdict('CHANGES_REQUESTED'), work: work(), body },
    { name: 'stale head', verdict: verdict(), work: work(H2), body },
    { name: 'prose only', verdict: verdict(), work: work(), body: 'All three review threads are fixed at this head.' },
  ]) {
    const { root, cleanup } = await boundMaster();
    try {
      await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint });
      const gh = github({ body: scenario.body });
      await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun, observe: () => scenario.verdict, work: [scenario.work], threadsRun: gh.run });
      assert.deepEqual(gh.resolved, [], scenario.name);
      assert.ok(!gh.calls.some(call => call.some(arg => arg.includes('resolveReviewThread'))), scenario.name);
    } finally { await cleanup(); }
  }
});

test('an approval carried onto a base-refreshed tip resolves the threads it named', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint });
    const carry = { from: { sha: H, baseSha: B }, to: { sha: H2, baseSha: B2 }, policyRevision: 1, at: new Date().toISOString(), predecessor: 'base branch', changedFiles: [], reviewedFiles: ['src/a.ts'],
      approval: { provider: 'github', reviewer, sha: H, reviewId: 77, carried: true, originalSha: H, reason: 'carried' }, evidence: [] };
    const tip = work(H2, B2, { baseRefresh: { head: H2, carry } } as unknown as Partial<Work>);
    const gh = github({ body });
    await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun, observe: () => verdict(), work: [tip], threadsRun: gh.run });
    assert.deepEqual(gh.resolved, ['PRRT_fixed0001']);
  } finally { await cleanup(); }
});

test('a failed thread read at launch is recorded on the session and told to the reviewer, not swallowed', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    const launched: any = await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => { throw new Error('gh: HTTP 403'); } });
    assert.match(launched.threadReadFailure, /review threads of pull request #64 could not be read: gh: HTTP 403/);
    const record = (await readReviewLedger(root)).reviews[0];
    assert.match(record.threadReadFailure!, /gh: HTTP 403/);
    assert.match((summarizeReviews([record]).pending[0] as any).threadReadFailure, /gh: HTTP 403/);
  } finally { await cleanup(); }
});

const listedThread = (id: string) => ({ id, author: 'codex', path: 'src/a.ts', line: 3, outdated: false, excerpt: 'finding', createdAt: '2026-09-23T11:00:00Z' });

test('unit:threads-listed-resolution — an approval without a Resolved threads line vouches for exactly the threads its prompt listed', async () => {
  for (const scenario of [
    { name: 'no line', body: 'All listed findings are fixed at this head.', resolved: ['PRRT_fixed0001'] },
    { name: 'explicit none', body: 'Looks good.\nResolved threads: none', resolved: [] as string[] },
  ]) {
    const { root, cleanup } = await boundMaster();
    try {
      // The prompt listed one of the PR's two pre-existing threads; the unlisted one is never resolved.
      await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => [listedThread('PRRT_fixed0001')] });
      assert.deepEqual((await readReviewLedger(root)).reviews[0].threadsListed, ['PRRT_fixed0001']);
      const gh = github({ body: scenario.body });
      const settled = await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run });
      assert.deepEqual(gh.resolved, scenario.resolved, scenario.name);
      assert.equal(settled.reviews[0].threadResolution?.implicit, scenario.name === 'no line', scenario.name);
    } finally { await cleanup(); }
  }
});

test('unit:threads-listed-resolution — a settlement that named nothing before listed threads were recorded is judged once more, by launch time', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint });
    const gh = github({ body: 'All listed findings are fixed at this head.' });
    // As GY-159's record was left on 2026-09-24: no threadsListed, and a settlement that named nothing.
    await updateReviewLedger(root, ledger => { const { threadsListed: _listed, ...record } = ledger.reviews[0]; ledger.reviews[0] = { ...record, state: 'completed', verdict: verdict() as any,
      threadResolution: { at: new Date().toISOString(), reviewId: 77, named: [], resolved: [], refused: [], attempts: 1 } }; });
    const settled = await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run });
    // Opened before the launch and before the approval: both pre-existing threads; the later one is refused.
    assert.deepEqual(gh.resolved, ['PRRT_fixed0001', 'PRRT_unnamed01']);
    assert.equal(settled.reviews[0].threadResolution?.implicit, true);
    const before = gh.calls.length;
    await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run });
    assert.equal(gh.calls.length, before, 'judged once');
  } finally { await cleanup(); }
});
