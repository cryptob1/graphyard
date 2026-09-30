import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { listedThreadLimit, threadSection } from '../src/review-threads.js';
import { bindReviewer, launchReview, readReviewLedger, reconcileReviews, saveReviewerProfile, summarizeReviews, updateReviewLedger } from '../src/reviewer.js';
import type { Observation, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// The reviewer names the threads it verified fixed on a `Resolved threads:` line of its approval and
// the ones it overrides on an `Overridden threads:` line; the loop records both with the verdict and
// resolves exactly those with its own GitHub access, once it holds that approval of the current
// candidate (or of the head whose approval was carried onto it). Nothing else is resolved, and an
// approval that leaves a listed thread off every line is withdrawn rather than taken as the verdict.

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
  const root = await temporaryDirectory('threads'), credentialDirectory = await temporaryDirectory('threads-credentials');
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
function github(options: { body: string; state?: string; threads?: { id: string; createdAt: string; outdated?: boolean }[] }) {
  const calls: string[][] = [], resolved: string[] = [];
  const thread = (id: string, createdAt: string, outdated = false) => ({ id, isResolved: resolved.includes(id), isOutdated: outdated, path: 'src/a.ts', line: 3, comments: { nodes: [{ author: { login: 'codex' }, body: 'finding', createdAt }] } });
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
    if (query.includes('reviewThreads')) return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: options.threads
      ? options.threads.map(entry => thread(entry.id, entry.createdAt, entry.outdated))
      : [thread('PRRT_fixed0001', '2026-09-23T11:00:00Z'), thread('PRRT_unnamed01', '2026-09-23T11:00:00Z'), thread('PRRT_later0001', '2026-09-23T12:30:00Z')] } } } } });
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
      // A launch from before the criteria-only rule (GY-166), whose approval vouched for its listing.
      await updateReviewLedger(root, ledger => { const { criteriaOnly: _rule, ...record } = ledger.reviews[0]; ledger.reviews[0] = record; });
      const gh = github({ body: scenario.body });
      const settled = await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run });
      assert.deepEqual(gh.resolved, scenario.resolved, scenario.name);
      assert.equal(settled.reviews[0].threadResolution?.implicit, scenario.name === 'no line', scenario.name);
    } finally { await cleanup(); }
  }
});

test('unit:threads-listed-resolution — past the listing limit the prompt and the record hold the same threads, and an approval without the line resolves only those', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    const open = Array.from({ length: listedThreadLimit + 5 }, (_, index) => listedThread(`PRRT_open${String(index).padStart(4, '0')}`));
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => open });
    const recorded = (await readReviewLedger(root)).reviews[0].threadsListed!;
    assert.deepEqual(recorded, open.slice(0, listedThreadLimit).map(thread => thread.id));
    // The prompt shows exactly the recorded set, and says how many more it left out.
    const section = threadSection(H, open.slice(0, listedThreadLimit), open.length);
    for (const thread of open) assert.equal(section.includes(thread.id), recorded.includes(thread.id), thread.id);
    assert.match(section, /5 more unresolved threads are not listed here: do not name them/);
  } finally { await cleanup(); }
});

test('unit:threads-listed-resolution — a settlement that named nothing before listings were recorded is judged once more, by what its launch recorded: no listing vouches for no thread', async () => {
  for (const scenario of [
    // As GY-159's record was left on 2026-09-24: launched while prompts listed threads but before the
    // listing was recorded. Nothing on the record says which prompt its reviewer got.
    { name: 'thread-aware binary, unrecorded listing', requestedAt: '2026-09-24T05:00:00.000Z' },
    // Launched before dabdf14e: the reviewer was never shown the thread IDs or findings.
    { name: 'before thread-aware prompts', requestedAt: '2026-09-24T04:00:00.000Z' },
    // A pre-dabdf14e binary still running later writes a record that looks the same, then an upgrade settles it.
    { name: 'older binary after an upgrade', requestedAt: '2026-09-24T09:00:00.000Z' },
  ]) {
    const { root, cleanup } = await boundMaster();
    try {
      await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint });
      const gh = github({ body: 'All listed findings are fixed at this head.' });
      await updateReviewLedger(root, ledger => { const { threadsListed: _listed, ...record } = ledger.reviews[0]; ledger.reviews[0] = { ...record, requestedAt: scenario.requestedAt, state: 'completed', verdict: verdict() as any,
        threadResolution: { at: new Date().toISOString(), reviewId: 77, named: [], resolved: [], refused: [], attempts: 1 } }; });
      const settled = await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run });
      assert.deepEqual(gh.resolved, [], scenario.name);
      assert.equal(settled.reviews[0].threadResolution?.implicit, false, `${scenario.name}: judged once more, with no listing to vouch for`);
      const before = gh.calls.length;
      await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run });
      assert.equal(gh.calls.length, before, `${scenario.name}: judged once`);
    } finally { await cleanup(); }
  }
});

test('unit:threads-listed-resolution — a session with no recorded listing and no legacy settlement vouches for none of the threads', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint });
    const gh = github({ body: 'All listed findings are fixed at this head.' });
    await updateReviewLedger(root, ledger => { const { threadsListed: _listed, ...record } = ledger.reviews[0]; ledger.reviews[0] = { ...record, requestedAt: '2026-09-24T05:00:00.000Z', state: 'completed', verdict: verdict() as any }; });
    const settled = await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run });
    assert.deepEqual(gh.resolved, []);
    assert.equal(settled.reviews[0].threadResolution?.implicit, false);
  } finally { await cleanup(); }
});

test('unit:overridden-threads-recorded — an approval that overrides a bot thread names it on its Overridden threads line; the override is recorded with the verdict and the thread resolved', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => [listedThread('PRRT_fixed0001'), listedThread('PRRT_wrong0001')] });
    const gh = github({ body: 'PRRT_wrong0001 flags a null check the caller already guarantees.\nResolved threads: PRRT_fixed0001\nOverridden threads: PRRT_wrong0001',
      threads: [{ id: 'PRRT_fixed0001', createdAt: '2026-09-23T11:00:00Z' }, { id: 'PRRT_wrong0001', createdAt: '2026-09-23T11:00:00Z' }, { id: 'PRRT_unnamed01', createdAt: '2026-09-23T11:00:00Z' }] });
    const settled = await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run });
    const resolution = settled.reviews[0].threadResolution!;
    assert.deepEqual(resolution.overridden, ['PRRT_wrong0001'], 'the override is on the record, auditable beside the verdict');
    assert.deepEqual(resolution.named, ['PRRT_fixed0001', 'PRRT_wrong0001']);
    assert.equal(resolution.implicit, false, 'explicit lines vouch for exactly what they name');
    assert.deepEqual(gh.resolved, ['PRRT_fixed0001', 'PRRT_wrong0001'], 'the unnamed, current-line thread is never resolved');
    assert.ok(settled.threads.some(line => line.startsWith('resolved review thread PRRT_wrong0001 on GY-64 PR #64, overridden by approval 77')), settled.threads.join('\n'));
  } finally { await cleanup(); }
});

test('unit:outdated-threads-resolved-only-when-named — approving a new head resolves a pre-existing thread on an outdated line only when a line names it', async () => {
  for (const scenario of [
    { name: 'named on no line', body: 'Looks good.\nResolved threads: none', resolved: [] as string[] },
    { name: 'named resolved', body: 'Looks good.\nResolved threads: PRRT_stale0001', resolved: ['PRRT_stale0001'] },
  ]) {
    const { root, cleanup } = await boundMaster();
    try {
      await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint });
      const gh = github({ body: scenario.body, threads: [
        { id: 'PRRT_stale0001', createdAt: '2026-09-23T11:00:00Z', outdated: true },
        { id: 'PRRT_current01', createdAt: '2026-09-23T11:00:00Z' },
        { id: 'PRRT_newstale1', createdAt: '2026-09-23T12:30:00Z', outdated: true },
      ] });
      const settled = await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run });
      assert.deepEqual(gh.resolved, scenario.resolved, `${scenario.name}: an outdated line is not a finding the reviewer judged`);
      assert.equal(settled.reviews[0].threadResolution?.outdated, undefined, scenario.name);
    } finally { await cleanup(); }
  }
});

/** GitHub for the completeness check: each approval by id, and the resolve mutation. */
function approvals(bodies: Record<number, string>) {
  const resolved: string[] = [];
  const run = (_command: string, args: string[]) => {
    const id = /pulls\/64\/reviews\/(\d+)$/.exec(args[1] ?? '')?.[1];
    if (id) return JSON.stringify({ id: Number(id), state: 'APPROVED', commit_id: H, user: { login: reviewer }, submitted_at: submittedAt, body: bodies[Number(id)] });
    const query = args.find(arg => arg.startsWith('query=')) ?? '';
    if (query.includes('resolveReviewThread')) { const thread = args.find(arg => arg.startsWith('thread='))!.slice('thread='.length); resolved.push(thread); return JSON.stringify({ data: { resolveReviewThread: { thread: { id: thread, isResolved: true } } } }); }
    if (query.includes('reviewThreads')) return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: ['PRRT_fixed0001', 'PRRT_person01', 'PRRT_bot00001'].map(thread =>
      ({ id: thread, isResolved: resolved.includes(thread), isOutdated: false, path: 'src/a.ts', line: 3, comments: { nodes: [{ author: { login: thread === 'PRRT_bot00001' ? 'chatgpt-codex-connector' : 'lead' }, body: 'finding', createdAt: '2026-09-23T11:00:00Z' }] } })) } } } } });
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { run, resolved };
}

test('unit:approval-accounts-for-listed-threads — an approval that leaves a listed thread off its Resolved, Follow-up and Overridden lines is withdrawn, resolves nothing and is relaunched; a bot thread past the rework rounds still has to be named', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    // Past botThreadReworkRounds: the bot's thread sends no rework any more, and the reviewer still names it.
    const reworked = work(H, B, { pipeline: { reworkRounds: 2 } } as unknown as Partial<Work>);
    const listing = async () => [listedThread('PRRT_fixed0001'), listedThread('PRRT_person01'), { ...listedThread('PRRT_bot00001'), author: 'chatgpt-codex-connector' }];
    await launchReview(root, reworked, 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: listing });
    const gh = approvals({ 77: 'AC-1 met.\nResolved threads: PRRT_fixed0001\nFollow-up threads: PRRT_person01\nOverridden threads: none',
      78: 'AC-1 met.\nResolved threads: PRRT_fixed0001\nFollow-up threads: PRRT_person01\nOverridden threads: PRRT_bot00001' });
    const dismissed: { reviewId: number; message: string }[] = [];
    let refuse = true;
    const dismiss = async (_record: unknown, reviewId: number, message: string) => { if (refuse) throw new Error('GitHub refused to dismiss review 77 (403)'); dismissed.push({ reviewId, message }); };
    const config = await loadMasterConfig(root);
    // GitHub refuses the withdrawal: the record stays pending, says why, and is judged again.
    let settled = await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [reworked], threadsRun: gh.run, dismiss });
    assert.equal(settled.reviews[0].state, 'pending', 'an incomplete approval is not recorded as the verdict');
    assert.equal(settled.reviews[0].verdict, undefined);
    assert.match(settled.reviews[0].resolution!, /not yet a complete verdict: it could not be withdrawn \(GitHub refused to dismiss review 77 \(403\)\)/);
    refuse = false;
    settled = await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [reworked], threadsRun: gh.run, dismiss });
    assert.deepEqual(dismissed.map(entry => entry.reviewId), [77], 'the incomplete approval is withdrawn');
    assert.match(dismissed[0].message, /does not account for listed review thread\(s\) PRRT_bot00001/);
    const withdrawn = settled.reviews[0];
    assert.equal(withdrawn.state, 'failed', 'recorded unanswered, so the request is relaunched');
    assert.equal(withdrawn.verdict?.state, 'DISMISSED');
    assert.match(withdrawn.resolution!, /left listed threads unaccounted \(PRRT_bot00001\), so it was withdrawn and the request is relaunched/);
    assert.deepEqual(gh.resolved, [], 'an incomplete approval resolves nothing');

    // The relaunched session's approval accounts for every listed thread: it is the verdict.
    await launchReview(root, reworked, 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: listing });
    settled = await reconcileReviews(root, config, { run: herdrRun, observe: record => record.id === withdrawn.id ? null : { ...verdict(), reviewId: 78 }, work: [reworked], threadsRun: gh.run, dismiss });
    const complete = settled.reviews.find(record => record.id !== withdrawn.id)!;
    assert.equal(complete.state, 'completed', complete.resolution);
    assert.equal(complete.verdict?.state, 'APPROVED');
    assert.deepEqual(dismissed.length, 1, 'a complete approval is never withdrawn');
    assert.deepEqual(complete.threadResolution?.named, ['PRRT_fixed0001', 'PRRT_bot00001']);
  } finally { await cleanup(); }
});
