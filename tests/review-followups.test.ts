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
import { parseFollowUpThreads, parseResolvedThreads, threadSection } from '../src/review-threads.js';
import { bindReviewer, followUpThreadIds, launchReview, reconcileReviews, reviewPrompt, saveReviewerProfile } from '../src/reviewer.js';
import { routineDecision, setAsideFollowUpThreads, threadResolutionGraceMs } from '../src/master-daemon.js';
import type { Observation, Work } from '../src/model.js';

// GY-166, 2026-09-24: GY-164 took 19 attempts and five hours; its reviewer confirmed both criteria
// met around round 16 and kept requesting changes for new edge cases. The reviewer now judges the
// acceptance criteria, approves when they are met and nothing blocks them, and names everything
// else as follow-up; the loop files those threads as one backlog item and resolves them.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const H = 'a1'.padEnd(40, 'f'), B = 'b1'.padEnd(40, 'f');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const mint = async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() });
const reviewer = 'graphyard-reviewer[bot]';
const submittedAt = '2026-09-24T12:00:00Z';
const verdict = (state = 'APPROVED') => ({ state, reviewer, reviewId: 77, submittedAt });
const criteria = [{ id: 'AC-1', text: 'The widget counts every frob.', proofs: ['unit:frob-count'] }, { id: 'AC-2', text: 'The count is shown on the dashboard.', proofs: ['unit:frob-dashboard'] }];

async function boundMaster() {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-followups-')), credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-followups-credentials-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory, herdrWorkspace: 'wE' }, coordinatorStatus as typeof fetch);
  await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentialDirectory, 'reviewers') }, async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
  await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' });
  return { root, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); } };
}
function observation(candidate: { sha: string; baseSha: string }, extra: Partial<Observation> = {}): Observation {
  return { candidate: { ...candidate, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/a.ts'], scopeFiles: [], at: new Date().toISOString(), prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: B, baseTipContained: true, ...extra };
}
function work(overrides: Partial<Work> = {}, extra: Partial<Observation> = {}): Work {
  const candidate = { sha: H, baseSha: B, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' };
  return { id: 'work-64', key: 'GY-64', title: 'Frobs', description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria, policy: { checks: ['test'], review: true, reviewProvider: 'github' },
    stage: 'review', revision: 7, policyRevision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stageEnteredAt: new Date().toISOString(), ready: true, epoch: 1,
    lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 64 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: observation(candidate, extra), blocker: null, gates: [], violations: [], ...overrides } as unknown as Work;
}
const herdrRun = (_command: string, args: string[]) => startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'pane-review', tab_id: 'tab-review' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });

test('unit:review-criteria-only-prompt — the reviewer launch prompt states the criteria-only rule and asks for Resolved and Follow-up lines', () => {
  const binding = { key: 'GY-64', pr: 64, sha: H, baseSha: B, policyRevision: 1 };
  const thread = { id: 'PRRT_kwDOabc123', author: 'chatgpt-codex-connector', path: 'src/a.ts', line: 9, outdated: false, excerpt: 'P2 an edge case' };
  const prompt = reviewPrompt({ repository: 'owner/project' }, binding, undefined, { unresolved: [thread] }, criteria);
  for (const fragment of [
    // Each criterion, by id and text, judged met or unmet.
    '[AC-1] The widget counts every frob.', '[AC-2] The count is shown on the dashboard.', 'Judge each acceptance criterion met or unmet',
    // Each finding and thread classified by the definitions.
    'as BLOCKING or FOLLOW-UP', 'BLOCKING: the head fails a stated acceptance criterion, or a correctness or security defect in the changed code breaks one of the item\'s own criteria',
    'FOLLOW-UP: everything else — edge cases beyond the criteria, style, naming, hypotheticals, further hardening, and bot suggestions',
    // When to approve, and what a change request may cite.
    'APPROVE when every criterion is met and no finding or thread is BLOCKING',
    'REQUEST_CHANGES cites only BLOCKING findings, and names for each the acceptance criterion it blocks', 'never request changes for a FOLLOW-UP',
    // The closing lines.
    '"Resolved threads: ID1 ID2"', '"Follow-up threads: ID3 ID4"', 'End the review body with two lines',
    'files the Follow-up threads as one backlog item',
  ]) assert.ok(prompt.includes(fragment), `the prompt must state: ${fragment}`);
  assert.match(prompt, /never weaken a requirement/);
  // The thread section repeats the classification for the listed threads.
  assert.match(threadSection(H, [thread]), /BLOCKING — REQUEST_CHANGES citing the thread and the criterion it blocks — or FOLLOW-UP, named on the Follow-up threads line/);
  // The rule stands with no thread listed, and with no criteria at hand (the retry prompt's case).
  const bare = reviewPrompt({ repository: 'owner/project' }, binding);
  assert.match(bare, /Review against the acceptance criteria of GY-64\. .*APPROVE when every criterion is met/);
  assert.doesNotMatch(bare, /unresolved review thread/);
});

test('unit:review-criteria-only-prompt — the Follow-up line is parsed exactly like the Resolved line', () => {
  const samples = [
    'Looks good.\n{L}: PRRT_aaaaaaaa, `PRRT_bbbbbbbb`.\n',
    '{l}: PRRT_aaaaaaaa\n{L}: PRRT_cccccccc PRRT_cccccccc',
    'All three review threads are follow-ups.',
    '{L}: none',
    '  {L}:   "PRRT_dddddddd"  short ',
  ];
  for (const sample of samples) {
    const resolved = parseResolvedThreads(sample.replaceAll('{L}', 'Resolved threads').replaceAll('{l}', 'resolved threads'));
    const followUp = parseFollowUpThreads(sample.replaceAll('{L}', 'Follow-up threads').replaceAll('{l}', 'follow-up threads'));
    assert.deepEqual(followUp, resolved, sample);
  }
  assert.deepEqual(parseFollowUpThreads('Looks good.\nFollow-up threads: PRRT_aaaaaaaa, `PRRT_bbbbbbbb`.'), ['PRRT_aaaaaaaa', 'PRRT_bbbbbbbb']);
  assert.deepEqual(parseFollowUpThreads(undefined), []);
  // Each line reads only its own IDs.
  const both = 'Criteria met.\nResolved threads: PRRT_fixed0001\nFollow-up threads: PRRT_later0001';
  assert.deepEqual(parseResolvedThreads(both), ['PRRT_fixed0001']);
  assert.deepEqual(parseFollowUpThreads(both), ['PRRT_later0001']);
});

/** GitHub as the loop's own gh sees it: the approval, the PR's threads, replies and resolves. */
function github(body: string, options: { failReply?: string[] } = {}) {
  const calls: string[][] = [], resolved: string[] = [], replies: { thread: string; body: string }[] = [];
  const failReply = new Set(options.failReply ?? []);
  const thread = (id: string, createdAt: string, path = 'src/a.ts') => ({ id, isResolved: resolved.includes(id), isOutdated: false, path, line: 3,
    comments: { nodes: [{ author: { login: 'chatgpt-codex-connector' }, body: `finding on ${id}`, createdAt, url: `https://github.com/owner/project/pull/64#discussion_${id}` }] } });
  const run = (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (command !== 'gh') throw new Error(`unexpected ${command}`);
    if (args[1] === 'repos/owner/project/pulls/64/reviews/77') return JSON.stringify({ id: 77, state: 'APPROVED', commit_id: H, user: { login: reviewer }, submitted_at: submittedAt, body });
    const query = args.find(arg => arg.startsWith('query=')) ?? '';
    const target = args.find(arg => arg.startsWith('thread='))?.slice('thread='.length);
    if (query.includes('addPullRequestReviewThreadReply')) {
      if (failReply.has(target!)) { failReply.delete(target!); throw new Error('gh: HTTP 502'); }
      replies.push({ thread: target!, body: args.find(arg => arg.startsWith('body='))!.slice('body='.length) });
      return JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { id: `C_${target}` } } } });
    }
    if (query.includes('resolveReviewThread')) { resolved.push(target!); return JSON.stringify({ data: { resolveReviewThread: { thread: { id: target, isResolved: true } } } }); }
    if (query.includes('reviewThreads')) return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
      thread('PRRT_fixed0001', '2026-09-24T11:00:00Z'), thread('PRRT_follow001', '2026-09-24T11:00:00Z', 'src/b.ts'), thread('PRRT_follow002', '2026-09-24T11:10:00Z'),
      thread('PRRT_unnamed01', '2026-09-24T11:00:00Z'), thread('PRRT_later0001', '2026-09-24T12:30:00Z')] } } } } });
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { run, calls, resolved, replies };
}
function creator() {
  const created: { item: any; key: string }[] = [];
  const create = async (item: any, key: string) => { created.push({ item, key }); return { key: 'GY-201' }; };
  return { create, created };
}
const approvalBody = 'AC-1 met. AC-2 met.\nResolved threads: PRRT_fixed0001\nFollow-up threads: PRRT_follow001 PRRT_follow002 PRRT_later0001';

test('unit:review-followups-filed — one backlog item for the approval, a reply and resolve on each named follow-up thread only, idempotent across cycles', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint });
    const gh = github(approvalBody), items = creator();
    const config = await loadMasterConfig(root);
    const settled = await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run, createFollowUpItem: items.create });
    // Exactly one item, priority 2, backlog-bound, naming each thread's id, path:line, author, URL and excerpt.
    assert.equal(items.created.length, 1);
    const { item, key } = items.created[0];
    assert.equal(item.priority, 2);
    assert.match(key, /77/, 'the create is idempotent on the approval');
    for (const id of ['PRRT_follow001', 'PRRT_follow002']) {
      assert.ok(item.description.includes(id), id);
      assert.ok(item.description.includes(`https://github.com/owner/project/pull/64#discussion_${id}`), `${id} URL`);
      assert.ok(item.description.includes(`finding on ${id}`), `${id} excerpt`);
    }
    assert.ok(item.description.includes('src/b.ts:3 by chatgpt-codex-connector'), 'path:line and author');
    assert.ok(!item.description.includes('PRRT_later0001'), 'a thread opened after the approval was never judged by it');
    assert.ok(!item.description.includes('PRRT_unnamed01') && !item.description.includes('PRRT_fixed0001'));
    // Replied on and resolved: the named follow-ups only; the Resolved line's thread is resolved as before.
    assert.deepEqual(gh.replies.map(reply => reply.thread), ['PRRT_follow001', 'PRRT_follow002']);
    for (const reply of gh.replies) assert.match(reply.body, /GY-201/);
    assert.deepEqual([...gh.resolved].sort(), ['PRRT_fixed0001', 'PRRT_follow001', 'PRRT_follow002']);
    assert.ok(!gh.calls.some(call => call.some(arg => arg === 'thread=PRRT_unnamed01' || arg === 'thread=PRRT_later0001')), 'threads the verdict did not name, or could not have judged, are never touched');
    const record = settled.reviews[0];
    assert.equal(record.followUps?.item, 'GY-201');
    assert.deepEqual(record.followUps?.resolved, ['PRRT_follow001', 'PRRT_follow002']);
    assert.equal(record.followUps?.failure, undefined);
    assert.ok(settled.threads.some(line => line.startsWith('filed 2 follow-up review thread(s) on GY-64 PR #64 as GY-201')), settled.threads.join('\n'));
    // The next cycle leaves the item and GitHub alone.
    const before = gh.calls.length;
    const again = await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run, createFollowUpItem: items.create });
    assert.equal(items.created.length, 1, 'never a second item');
    assert.equal(gh.calls.length, before);
    assert.deepEqual(again.threads, []);
  } finally { await cleanup(); }
});

test('unit:review-followups-filed — a failure is recorded and retried without a second item or a second reply', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint });
    const config = await loadMasterConfig(root);
    // First pass: the create is refused. Nothing is replied to or resolved, and the failure is kept.
    const gh = github(approvalBody, { failReply: ['PRRT_follow002'] });
    const refusing = async () => { throw new Error('Graphyard refused the follow-up item (503): unavailable'); };
    const first = await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run, createFollowUpItem: refusing });
    assert.match(first.reviews[0].followUps!.failure!, /follow-up item could not be created: Graphyard refused/);
    assert.equal(gh.replies.length, 0);
    assert.ok(first.threads.some(line => /follow-up filing for GY-64 approval 77 failed \(attempt 1\)/.test(line)));
    // Second pass: the item is created; one reply fails, and its thread stays open.
    const items = creator();
    const second = await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run, createFollowUpItem: items.create });
    assert.equal(items.created.length, 1);
    assert.deepEqual(second.reviews[0].followUps!.resolved, ['PRRT_follow001']);
    assert.match(second.reviews[0].followUps!.failure!, /PRRT_follow002: gh: HTTP 502/);
    // Third pass: only the failed thread is answered; the item is not created again and no thread gets a second reply.
    const third = await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run, createFollowUpItem: items.create });
    assert.equal(items.created.length, 1);
    assert.deepEqual(gh.replies.map(reply => reply.thread), ['PRRT_follow001', 'PRRT_follow002']);
    assert.deepEqual(third.reviews[0].followUps!.resolved, ['PRRT_follow001', 'PRRT_follow002']);
    assert.equal(third.reviews[0].followUps!.failure, undefined);
    assert.equal(third.reviews[0].followUps!.item, 'GY-201');
  } finally { await cleanup(); }
});

test('unit:review-followups-filed — nothing is filed for a change request, a stale head, or an approval naming no follow-up', async () => {
  for (const scenario of [
    { name: 'changes requested', verdict: verdict('CHANGES_REQUESTED'), work: work(), body: approvalBody },
    { name: 'stale head', verdict: verdict(), work: work({ candidate: { sha: 'c1'.padEnd(40, 'f'), baseSha: B, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' } } as Partial<Work>), body: approvalBody },
    { name: 'no follow-up line', verdict: verdict(), work: work(), body: 'AC-1 met. AC-2 met.\nResolved threads: PRRT_fixed0001' },
    { name: 'follow-up none', verdict: verdict(), work: work(), body: 'AC-1 met. AC-2 met.\nResolved threads: none\nFollow-up threads: none' },
  ]) {
    const { root, cleanup } = await boundMaster();
    try {
      await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint });
      const gh = github(scenario.body), items = creator();
      await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun, observe: () => scenario.verdict, work: [scenario.work], threadsRun: gh.run, createFollowUpItem: items.create });
      assert.equal(items.created.length, 0, scenario.name);
      assert.equal(gh.replies.length, 0, scenario.name);
    } finally { await cleanup(); }
  }
});

test('unit:review-followups-filed — an approval with follow-ups but no Resolved line does not vouch the follow-up threads fixed', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    const listed = ['PRRT_fixed0001', 'PRRT_follow001'].map(id => ({ id, author: 'codex', path: 'src/a.ts', line: 3, outdated: false, excerpt: 'finding', createdAt: '2026-09-24T11:00:00Z' }));
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => listed });
    const gh = github('Criteria met.\nFollow-up threads: PRRT_follow001'), items = creator();
    const settled = await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run, createFollowUpItem: items.create });
    assert.deepEqual(settled.reviews[0].threadResolution?.resolved, ['PRRT_fixed0001'], 'implicitly vouched: the listed threads the approval did not file');
    assert.deepEqual(gh.replies.map(reply => reply.thread), ['PRRT_follow001'], 'the follow-up is filed, with its reply, not resolved as fixed');
  } finally { await cleanup(); }
});

test('unit:review-followups-filed — the loop requests no thread rework for threads an approval named as follow-up', async () => {
  const at = Date.now();
  const approvedAt = new Date(at - threadResolutionGraceMs).toISOString();
  const thread = (id: string) => ({ id, author: 'chatgpt-codex-connector', path: 'src/a.ts', line: 3, outdated: false });
  const item = (ids: string[]) => work({}, { at: new Date(at).toISOString(), reviews: [{ reviewer, sha: H, state: 'APPROVED', id: 77, submittedAt: approvedAt }], conversations: { required: true, unresolved: ids.map(thread) } } as Partial<Observation>);
  const decide = (entry: Work, followUps: Map<string, Set<string>>) => routineDecision(setAsideFollowUpThreads({ work: [entry] }, followUps).work[0], { autoMerge: true }, at);

  // The follow-up set comes from the review ledger, as the loop's effect reads it.
  const { root, cleanup } = await boundMaster();
  let followUps: Map<string, Set<string>>;
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint });
    const gh = github(approvalBody), items = creator();
    const settled = await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run, createFollowUpItem: items.create });
    followUps = followUpThreadIds(settled.reviews);
  } finally { await cleanup(); }
  assert.deepEqual([...followUps.get('GY-64') ?? []].sort(), ['PRRT_follow001', 'PRRT_follow002'], 'a thread opened after the approval is not its follow-up');

  // Without the set-aside the approved head's open threads are a rework, as before.
  assert.equal(decide(item(['PRRT_follow001', 'PRRT_follow002']), new Map())?.action, 'rework');
  // Every open thread is a follow-up still being filed: no rework is requested.
  assert.equal(decide(item(['PRRT_follow001', 'PRRT_follow002']), followUps), null);
  // A thread the approval did not name still is, and the rework names only it.
  const other = decide(item(['PRRT_follow001', 'PRRT_later0001']), followUps);
  assert.equal(other?.action, 'rework');
  assert.equal(other?.binding, `${H}:threads:PRRT_later0001`);
  // Another item's follow-ups set nothing aside here.
  assert.equal(decide(item(['PRRT_follow001']), new Map([['GY-99', new Set(['PRRT_follow001'])]]))?.action, 'rework');
});
