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
import { coalescedScope, followUpItem, parseFollowUpFindings, parseFollowUpThreads, parseResolvedThreads, threadSection } from '../src/review-threads.js';
import { bindReviewer, followUpExhaustedRetryMs, followUpFilingBoundMs, followUpThreadIds, launchReview, readReviewLedger, reconcileReviews, reviewPrompt, reviewRetryPrompt, saveReviewerProfile, threadResolutionAttempts } from '../src/reviewer.js';
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
    'files the Follow-up threads and findings as one backlog item',
    // A finding with no thread has its own line, which the loop files in the same item.
    'Write each FOLLOW-UP finding of your own that has no review thread on a line of its own', '"Follow-up finding: PATH:LINE — what is wrong and why"',
  ]) assert.ok(prompt.includes(fragment), `the prompt must state: ${fragment}`);
  assert.match(prompt, /never weaken a requirement/);
  // The thread section repeats the classification for the listed threads.
  assert.match(threadSection(H, [thread]), /BLOCKING — REQUEST_CHANGES citing the thread and the criterion it blocks — or FOLLOW-UP, named on the Follow-up threads line/);
  // The rule stands with no thread listed.
  const bare = reviewPrompt({ repository: 'owner/project' }, binding);
  assert.match(bare, /Review against the acceptance criteria of GY-64\. .*APPROVE when every criterion is met/);
  assert.doesNotMatch(bare, /unresolved review thread/);
  // A criterion as long as the schema allows is stated whole: a condition in its tail is never judged FOLLOW-UP for want of being shown.
  const long = [{ id: 'AC-1', text: `${'The widget counts every frob. '.repeat(66)}TAIL-CONDITION holds.`.slice(-2000) }];
  assert.ok(reviewPrompt({ repository: 'owner/project' }, binding, undefined, undefined, long).includes(`[AC-1] ${long[0].text.trim()}`));
  // The retry prompt repeats the request with the item's criteria, and never states the rule without them.
  const record = { key: 'GY-64', pr: 64, sha: H, baseSha: B, policyRevision: 1 };
  const retry = reviewRetryPrompt('owner/project', record, criteria);
  assert.match(retry, /If you have not reviewed it at all/);
  for (const fragment of ['[AC-1] The widget counts every frob.', '[AC-2] The count is shown on the dashboard.', 'APPROVE when every criterion is met']) assert.ok(retry.includes(fragment), fragment);
  assert.doesNotMatch(reviewRetryPrompt('owner/project', record), /If you have not reviewed it at all|Review against the acceptance criteria/);
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
  // Findings with no thread are read from their own lines, with the path and line when given.
  assert.deepEqual(parseFollowUpFindings('AC-1 met.\nFollow-up finding: src/c.ts:12 — the retry is unbounded\n- follow-up finding: `docs/x.md` - stale wording\nFollow-up finding: naming could be clearer\nFollow-up finding: none\nFollow-up threads: none'), [
    { path: 'src/c.ts', line: 12, text: 'src/c.ts:12 — the retry is unbounded' },
    { path: 'docs/x.md', line: null, text: '`docs/x.md` - stale wording' },
    { path: null, line: null, text: 'naming could be clearer' },
  ]);
  assert.deepEqual(parseFollowUpFindings(undefined), []);
  // A root-level file is a path too; a bare number is not.
  assert.deepEqual(parseFollowUpFindings('Follow-up finding: Dockerfile:10 — no HEALTHCHECK\nFollow-up finding: `Makefile` - stale target\nFollow-up finding: 42 — the answer'), [
    { path: 'Dockerfile', line: 10, text: 'Dockerfile:10 — no HEALTHCHECK' },
    { path: 'Makefile', line: null, text: '`Makefile` - stale target' },
    { path: null, line: null, text: '42 — the answer' },
  ]);
});

/** GitHub as the loop's own gh sees it: the approval, the PR's threads, replies and resolves. */
function github(body: string, options: { failReply?: string[]; paths?: Record<string, string>; extra?: string[] } = {}) {
  const calls: string[][] = [], resolved: string[] = [], replies: { thread: string; body: string }[] = [];
  const failReply = new Set(options.failReply ?? []);
  const thread = (id: string, createdAt: string, path = 'src/a.ts') => ({ id, path: options.paths?.[id] ?? path, isResolved: resolved.includes(id), isOutdated: false, line: 3,
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
      thread('PRRT_unnamed01', '2026-09-24T11:00:00Z'), thread('PRRT_later0001', '2026-09-24T12:30:00Z'), ...(options.extra ?? []).map(id => thread(id, '2026-09-24T11:00:00Z'))] } } } } });
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { run, calls, resolved, replies };
}
function creator() {
  const created: { item: any; key: string }[] = [];
  const create = async (item: any, key: string) => { created.push({ item, key }); return { key: 'GY-201' }; };
  return { create, created };
}
/** The threads the review's launch prompt listed: those open before the approval. */
const shown = ['PRRT_fixed0001', 'PRRT_follow001', 'PRRT_follow002', 'PRRT_unnamed01'].map(id => ({ id, author: 'chatgpt-codex-connector', path: 'src/a.ts', line: 3, outdated: false, excerpt: `finding on ${id}`, createdAt: '2026-09-24T11:00:00Z' }));
const approvalBody = 'AC-1 met. AC-2 met.\nResolved threads: PRRT_fixed0001\nFollow-up threads: PRRT_follow001 PRRT_follow002 PRRT_later0001';

test('unit:review-followups-filed — one backlog item for the approval, a reply and resolve on each named follow-up thread only, idempotent across cycles', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
    const gh = github(approvalBody), items = creator();
    const config = await loadMasterConfig(root);
    const settled = await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run, createFollowUpItem: items.create });
    // Exactly one item, priority 2, backlog-bound, naming each thread's id, path:line, author, URL and excerpt.
    assert.equal(items.created.length, 1);
    const { item, key } = items.created[0];
    assert.equal(item.priority, 2);
    assert.deepEqual(item.dependencies, ['work-64'], 'the follow-up waits for the approved source item to land');
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
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
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

test('unit:review-followups-filed — a named thread the reviewer was not shown at launch is never answered or resolved', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
    // PRRT_unshown01 is open and predates the approval, but the launch did not list it (past the bound, or quoted from an excerpt).
    const gh = github('Criteria met.\nResolved threads: none\nFollow-up threads: PRRT_follow001 PRRT_unshown01', { extra: ['PRRT_unshown01'] }), items = creator();
    const settled = await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run, createFollowUpItem: items.create });
    assert.deepEqual(gh.replies.map(reply => reply.thread), ['PRRT_follow001']);
    assert.ok(!items.created[0].item.description.includes('PRRT_unshown01'));
    assert.ok(!gh.calls.some(call => call.includes('thread=PRRT_unshown01')), 'the unshown thread is never touched');
    assert.ok(settled.reviews[0].followUps!.refused.some(entry => entry.startsWith('PRRT_unshown01: not listed to the reviewer at launch')));
    assert.deepEqual([...followUpThreadIds(settled.reviews, [work()]).get('GY-64') ?? []], ['PRRT_follow001'], 'nor set aside from rework');
  } finally { await cleanup(); }
  // A launch that could not read the threads showed its reviewer none: its approval files nothing.
  const blind = await boundMaster();
  try {
    await launchReview(blind.root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => { throw new Error('gh: HTTP 502'); } });
    const gh = github(approvalBody), items = creator();
    await reconcileReviews(blind.root, await loadMasterConfig(blind.root), { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run, createFollowUpItem: items.create });
    assert.equal(items.created.length, 0);
    assert.equal(gh.replies.length, 0);
  } finally { await blind.cleanup(); }
});

test('unit:review-followups-filed — a thread path past the ledger bound is recorded within it, so the retry record survives the filing', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
    const path = `src/${'deep/'.repeat(300)}file.ts`;
    const gh = github(approvalBody, { paths: { PRRT_follow001: path } }), items = creator(), config = await loadMasterConfig(root);
    const settled = await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run, createFollowUpItem: items.create });
    const filing = (await readReviewLedger(root)).reviews[0].followUps!;
    assert.equal(filing.item, 'GY-201');
    assert.deepEqual(filing.resolved, ['PRRT_follow001', 'PRRT_follow002']);
    const recorded = filing.threads.find(thread => thread.id === 'PRRT_follow001')!.path;
    assert.ok(recorded.length <= 1000 && recorded.endsWith('/') && path.startsWith(recorded), `${recorded.length} characters: a containing directory, never a clipped suffix`);
    assert.ok(items.created[0].item.description.includes('file.ts:3'));
    assert.equal(settled.reviews[0].followUps?.item, 'GY-201');
    // The next cycle reads the record and files, replies and resolves nothing again.
    const before = gh.calls.length;
    await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run, createFollowUpItem: items.create });
    assert.equal(items.created.length, 1);
    assert.equal(gh.calls.length, before);
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
      await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
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
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
    const gh = github(approvalBody), items = creator();
    const settled = await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run, createFollowUpItem: items.create });
    followUps = followUpThreadIds(settled.reviews, [work()]);
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

test('unit:review-followups-filed — a filed thread reopened before the merge returns to rework instead of staying set aside, whatever the coordinator clock says', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
    const gh = github(approvalBody), items = creator(), config = await loadMasterConfig(root);
    const filedObservation = Date.now();
    const open = (at: number, ids: string[]) => work({}, { at: new Date(at).toISOString(), reviews: [{ reviewer, sha: H, state: 'APPROVED', id: 77, submittedAt }], conversations: { required: true, unresolved: ids.map(id => ({ id, author: 'codex', path: 'src/a.ts', line: 3, outdated: false })) } } as Partial<Observation>);
    // The coordinator's clock runs an hour ahead of the control plane's.
    const ahead = () => new Date(Date.now() + 3_600_000);
    const reconcile = (entry: Work) => reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [entry], threadsRun: gh.run, createFollowUpItem: items.create, now: ahead });
    let { reviews } = await reconcile(open(filedObservation, []));
    assert.deepEqual(reviews[0].followUps?.resolved, ['PRRT_follow001', 'PRRT_follow002']);
    assert.equal(reviews[0].followUps?.observedAt, new Date(filedObservation).toISOString(), 'the marker is the control plane observation, not the coordinator clock');
    // The observation the filing held, or an older one, still shows the threads open: nothing is re-read, both stay aside.
    const reads = () => gh.calls.filter(call => call.some(arg => arg.includes('reviewThreads'))).length, before = reads();
    ({ reviews } = await reconcile(open(filedObservation, ['PRRT_follow001', 'PRRT_follow002'])));
    assert.equal(reads(), before);
    assert.deepEqual([...followUpThreadIds(reviews, [work()]).get('GY-64') ?? []].sort(), ['PRRT_follow001', 'PRRT_follow002']);
    // A newer observation taken before GitHub settled shows one open, but GitHub has it resolved: it stays aside.
    ({ reviews } = await reconcile(open(filedObservation + 1000, ['PRRT_follow002'])));
    assert.equal(reads(), before + 1);
    assert.deepEqual(reviews[0].followUps?.reopened ?? [], []);
    // Somebody reopens PRRT_follow001 on GitHub; a newer observation shows it — an hour behind the coordinator's filing time.
    gh.resolved.splice(gh.resolved.indexOf('PRRT_follow001'), 1);
    const reopened = open(filedObservation + 2000, ['PRRT_follow001']);
    const settled = await reconcile(reopened);
    assert.deepEqual(settled.reviews[0].followUps?.reopened, ['PRRT_follow001']);
    assert.ok(settled.threads.some(line => /PRRT_follow001 on GY-64 PR #64 were reopened after filing/.test(line)), settled.threads.join('\n'));
    const ids = followUpThreadIds(settled.reviews, [reopened]);
    assert.deepEqual([...ids.get('GY-64') ?? []], ['PRRT_follow002']);
    const at = Math.max(Date.parse(submittedAt) + threadResolutionGraceMs, filedObservation + 2000);
    const decision = routineDecision(setAsideFollowUpThreads({ work: [reopened] }, ids).work[0], { autoMerge: true }, at);
    assert.equal(decision?.action, 'rework');
    assert.equal(decision?.binding, `${H}:threads:PRRT_follow001`);
    assert.equal(items.created.length, 1, 'a reopen files nothing twice');
  } finally { await cleanup(); }
});

test('unit:review-followups-filed — findings the approval wrote with no thread are filed in the same item', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
    const config = await loadMasterConfig(root);
    const body = 'AC-1 met. AC-2 met.\nFollow-up finding: src/c.ts:12 — the retry is unbounded\nFollow-up finding: naming could be clearer\nResolved threads: none\nFollow-up threads: PRRT_follow001';
    const gh = github(body), items = creator();
    const settled = await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run, createFollowUpItem: items.create });
    assert.equal(items.created.length, 1);
    const { item } = items.created[0];
    for (const text of ['PRRT_follow001', 'Finding with no thread: src/c.ts:12 — the retry is unbounded', 'Finding with no thread: naming could be clearer']) assert.ok(item.description.includes(text), text);
    assert.deepEqual([...item.plannedFiles].sort(), ['src/b.ts', 'src/c.ts']);
    assert.deepEqual(gh.replies.map(reply => reply.thread), ['PRRT_follow001'], 'a finding has no thread to answer');
    assert.equal(settled.reviews[0].followUps?.findings?.length, 2);
    // An approval with findings only still files them, and reads no threads it does not need.
    const { root: second, cleanup: cleanupSecond } = await boundMaster();
    try {
      await launchReview(second, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
      const only = github('AC-1 met.\nFollow-up finding: src/c.ts:12 — the retry is unbounded\nResolved threads: none\nFollow-up threads: none'), onlyItems = creator();
      const result = await reconcileReviews(second, await loadMasterConfig(second), { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: only.run, createFollowUpItem: onlyItems.create });
      assert.equal(onlyItems.created.length, 1);
      assert.match(onlyItems.created[0].item.description, /1 finding with no thread FOLLOW-UP/);
      assert.equal(result.reviews[0].followUps?.item, 'GY-201');
      assert.deepEqual(only.replies, []);
      // Idempotent: the next cycle files nothing more.
      await reconcileReviews(second, await loadMasterConfig(second), { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: only.run, createFollowUpItem: onlyItems.create });
      assert.equal(onlyItems.created.length, 1);
    } finally { await cleanupSecond(); }
  } finally { await cleanup(); }
});

test('unit:review-followups-filed — a thread path past the plannedFiles bound is scoped by its longest containing directory that fits, and kept in the description', () => {
  const path = `src/${'deep/'.repeat(120)}file.ts`;
  const threads = [{ id: 'PRRT_longpath01', author: 'codex', path, line: 1, outdated: false, excerpt: 'finding' }, { id: 'PRRT_short0001', author: 'codex', path: 'src/a.ts', line: 2, outdated: false, excerpt: 'finding' }];
  const item = followUpItem({ key: 'GY-64', workId: 'work-64', pr: 64, sha: H, reviewId: 77 }, threads);
  const scope = item.plannedFiles[0];
  assert.ok(scope.length <= 500 && scope.endsWith('/') && path.startsWith(scope) && path.lastIndexOf('/', 499) + 1 === scope.length, scope);
  assert.deepEqual(item.plannedFiles.slice(1), ['src/a.ts']);
  assert.ok(item.description.includes('PRRT_longpath01'));
});

test('unit:review-followups-filed — the item lists every follow-up thread within the description bound, however many and however long', () => {
  const long = (prefix: string, length: number) => prefix.padEnd(length, 'x');
  const threads = Array.from({ length: 100 }, (_, index) => ({ id: `PRRT_${String(index).padStart(3, '0')}aaaaaaaaaaaaaaaaaa`, author: long(`author-${index}-`, 200), path: long(`src/${index}/`, 1000) + '/file.ts',
    line: 1000 + index, outdated: false, excerpt: long(`finding ${index} `, 300), url: `https://github.com/owner/project/pull/64#discussion_r${4096215600 + index}` }));
  const { description } = followUpItem({ key: 'GY-64', workId: 'work-64', pr: 64, sha: H, reviewId: 77 }, threads);
  assert.ok(description.length <= 20000, `description is ${description.length} characters`);
  for (const [index, thread] of threads.entries()) {
    const entry = description.split('\n').find(line => line.startsWith(`${index + 1}. ${thread.id} — `));
    assert.ok(entry, `thread ${thread.id} is listed`);
    for (const part of [`file.ts:${thread.line} by author-${index}-`, `(${thread.url}): "finding ${index} `]) assert.ok(entry.includes(part), `${thread.id}: ${part}`);
  }
  // A short list keeps every field whole.
  const [one] = threads;
  const whole = followUpItem({ key: 'GY-64', workId: 'work-64', pr: 64, sha: H, reviewId: 77 }, [one]).description;
  for (const part of [one.id, one.path, one.author, one.url, one.excerpt]) assert.ok(whole.includes(part));
});

test('unit:review-followups-filed — follow-up threads return to rework once filing has failed on every retry', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
    const gh = github(approvalBody), config = await loadMasterConfig(root);
    const refusing = async () => { throw new Error('Graphyard refused the follow-up item (503): unavailable'); };
    let reviews = (await readReviewLedger(root)).reviews;
    for (let attempt = 1; attempt <= threadResolutionAttempts; attempt++) {
      reviews = (await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run, createFollowUpItem: refusing })).reviews;
      assert.equal(reviews[0].followUps?.attempts, attempt);
      // Still being retried: the threads stay set aside.
      if (attempt < threadResolutionAttempts) assert.ok(followUpThreadIds(reviews, [work()]).get('GY-64')?.has('PRRT_follow001'), `attempt ${attempt}`);
    }
    // Exhausted: nothing is set aside, so the cycle's thread rework surfaces the stuck item.
    assert.equal(followUpThreadIds(reviews, [work()]).get('GY-64'), undefined);
    const at = Date.parse(submittedAt) + threadResolutionGraceMs;
    const item = work({}, { at: new Date(at).toISOString(), reviews: [{ reviewer, sha: H, state: 'APPROVED', id: 77, submittedAt }], conversations: { required: true, unresolved: [{ id: 'PRRT_follow001', author: 'codex', path: 'src/b.ts', line: 3, outdated: false }] } } as Partial<Observation>);
    assert.equal(routineDecision(setAsideFollowUpThreads({ work: [item] }, followUpThreadIds(reviews, [item])).work[0], { autoMerge: true }, at)?.action, 'rework');
  } finally { await cleanup(); }
});

test('unit:review-followups-filed — a filing still being retried sets nothing aside once the head moves past its approval', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
    const gh = github(approvalBody), config = await loadMasterConfig(root);
    const refusing = async () => { throw new Error('Graphyard refused the follow-up item (503): unavailable'); };
    const { reviews } = await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run, createFollowUpItem: refusing });
    assert.equal(reviews[0].followUps?.attempts, 1);
    assert.ok(followUpThreadIds(reviews, [work()]).get('GY-64')?.has('PRRT_follow001'), 'the approved head: set aside while retried');
    // The candidate moves on before the retry: the loop stops filing for the old approval, so its
    // threads return to the new head's rework instead of being set aside with nothing to file them.
    const moved = 'c1'.padEnd(40, 'f');
    const next = work({ candidate: { sha: moved, baseSha: B, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' } } as Partial<Work>);
    assert.equal(followUpThreadIds(reviews, [next]).get('GY-64'), undefined);
    const items = creator();
    await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [next], threadsRun: gh.run, createFollowUpItem: items.create });
    assert.equal(items.created.length, 0, 'nothing files the old approval on the new head');
    const at = Date.parse(submittedAt) + threadResolutionGraceMs;
    const item = work({ candidate: next.candidate } as Partial<Work>, { at: new Date(at).toISOString(), candidate: { ...next.candidate!, pr: 64 }, conversations: { required: true, unresolved: [{ id: 'PRRT_follow001', author: 'codex', path: 'src/b.ts', line: 3, outdated: false }] } } as Partial<Observation>);
    const setAside = setAsideFollowUpThreads({ work: [item] }, followUpThreadIds(reviews, [item])).work[0];
    assert.deepEqual(setAside.observation?.conversations?.unresolved.map(thread => thread.id), ['PRRT_follow001'], 'the thread stays in the new head\'s snapshot');
    assert.deepEqual(routineDecision(setAside, { autoMerge: true }, at), routineDecision(item, { autoMerge: true }, at));
  } finally { await cleanup(); }
});

test('unit:review-followups-filed — an approval the dispatcher has not yet filed sets its listed threads aside, within a bound', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    const listed = ['PRRT_follow001', 'PRRT_follow002'].map(id => ({ id, author: 'codex', path: 'src/a.ts', line: 3, outdated: false, excerpt: 'finding', createdAt: '2026-09-24T11:00:00Z' }));
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => listed });
    // The daemon's snapshot already shows the approval; the dispatcher has not reconciled it yet.
    const { reviews } = await readReviewLedger(root);
    assert.equal(reviews[0].followUps, undefined);
    const approved = (state = 'APPROVED', by = reviewer) => work({}, { reviews: [{ reviewer: by, sha: H, state, id: 77, submittedAt }] } as Partial<Observation>);
    const approvedAt = Date.parse(submittedAt);
    const pending = (entry: Work, now: number) => followUpThreadIds(reviews, [entry], { reviewer, now }).get('GY-64');
    assert.deepEqual([...pending(approved(), approvedAt + threadResolutionGraceMs) ?? []].sort(), ['PRRT_follow001', 'PRRT_follow002']);
    const at = approvedAt + threadResolutionGraceMs;
    const item = work({}, { at: new Date(at).toISOString(), reviews: [{ reviewer, sha: H, state: 'APPROVED', id: 77, submittedAt }], conversations: { required: true, unresolved: listed.map(({ excerpt: _excerpt, createdAt: _createdAt, ...thread }) => thread) } } as Partial<Observation>);
    assert.equal(routineDecision(setAsideFollowUpThreads({ work: [item] }, followUpThreadIds(reviews, [item], { reviewer, now: at })).work[0], { autoMerge: true }, at), null, 'no rework while the approval is being filed');
    // Past the bound, from another reviewer, a change request, or another head: nothing is set aside.
    assert.equal(pending(approved(), approvedAt + followUpFilingBoundMs), undefined);
    assert.equal(pending(approved('APPROVED', 'somebody-else'), approvedAt + 60_000), undefined);
    assert.equal(pending(approved('CHANGES_REQUESTED'), approvedAt + 60_000), undefined);
    assert.equal(pending(work({ candidate: { sha: 'c1'.padEnd(40, 'f'), baseSha: B, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' } } as Partial<Work>, { reviews: [{ reviewer, sha: 'c1'.padEnd(40, 'f'), state: 'APPROVED', id: 78, submittedAt }] } as Partial<Observation>), approvedAt + 60_000), undefined);
    // Once filed, the recorded filing decides instead.
    const gh = github('Criteria met.\nResolved threads: none\nFollow-up threads: PRRT_follow001'), items = creator();
    const settled = await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run, createFollowUpItem: items.create });
    assert.deepEqual([...followUpThreadIds(settled.reviews, [approved()], { reviewer, now: approvedAt + 60_000 }).get('GY-64') ?? []], ['PRRT_follow001']);
  } finally { await cleanup(); }
});

test('unit:review-followups-filed — a long thread path whose first filing failed is retried with a real containing directory as its scope', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
    const path = `src/${'deep/'.repeat(300)}file.ts`;
    const gh = github(approvalBody, { paths: { PRRT_follow001: path } }), config = await loadMasterConfig(root);
    await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run, createFollowUpItem: async () => { throw new Error('Graphyard refused the follow-up item (503): unavailable'); } });
    const items = creator();
    await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run, createFollowUpItem: items.create });
    assert.equal(items.created.length, 1);
    const scope = items.created[0].item.plannedFiles.find((entry: string) => entry.startsWith('src/deep/'));
    assert.ok(scope && scope.length <= 500 && scope.endsWith('/') && path.startsWith(scope), `retry scope ${scope}`);
  } finally { await cleanup(); }
});

test('unit:review-followups-filed — every finding is filed however many the approval wrote', async () => {
  const lines = Array.from({ length: 80 }, (_, index) => `Follow-up finding: src/f${index}.ts:${index + 1} — finding number ${index}`);
  assert.equal(parseFollowUpFindings(lines.join('\n')).length, 80);
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
    const gh = github(`AC-1 met.\n${lines.join('\n')}\nResolved threads: none\nFollow-up threads: none`), items = creator();
    const settled = await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run, createFollowUpItem: items.create });
    const { item } = items.created[0];
    for (let index = 0; index < 80; index++) assert.ok(item.description.includes(`src/f${index}.ts:${index + 1}`), `finding ${index}`);
    assert.equal(item.plannedFiles.length, 80);
    assert.equal(settled.reviews[0].followUps?.item, 'GY-201', 'the ledger keeps its bounded record and the save succeeds');
  } finally { await cleanup(); }
});

test('unit:review-followups-filed — a long root-level finding is filed whole and in scope, while the ledger keeps its bounded copy', async () => {
  const tail = 'UNLESS-THE-CONDITION-AT-THE-END';
  const text = `Dockerfile:10 — ${'the image runs as root and '.repeat(40)}${tail}`;
  assert.ok(text.length > 1000);
  assert.equal(parseFollowUpFindings(`Follow-up finding: ${text}`)[0]!.text, text);
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
    const gh = github(`AC-1 met.\nFollow-up finding: ${text}\nResolved threads: none\nFollow-up threads: none`), items = creator();
    const settled = await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run, createFollowUpItem: items.create });
    const { item } = items.created[0];
    assert.ok(item.description.includes(tail), 'the filed item keeps the finding whole');
    assert.deepEqual(item.plannedFiles, ['Dockerfile']);
    const recorded = settled.reviews[0].followUps?.findings?.[0];
    assert.equal(recorded?.path, 'Dockerfile');
    assert.ok(recorded && recorded.text.length <= 500, 'the ledger record is bounded and saves');
  } finally { await cleanup(); }
});

test('unit:review-followups-filed — follow-ups in more than 100 files are coalesced into directories that still cover every file', () => {
  const threads = Array.from({ length: 100 }, (_, index) => ({ id: `PRRT_${String(index).padStart(3, '0')}aaaaaaaa`, author: 'codex', path: `src/area${index % 7}/mod${index}/file.ts`, line: 1, outdated: false, excerpt: 'finding' }));
  const findings = [{ path: 'docs/guide.md', line: 4, text: 'docs/guide.md:4 — stale' }];
  const item = followUpItem({ key: 'GY-64', workId: 'work-64', pr: 64, sha: H, reviewId: 77 }, threads, findings);
  assert.ok(item.plannedFiles.length <= 100, `${item.plannedFiles.length} entries`);
  for (const path of [...threads.map(thread => thread.path), 'docs/guide.md'])
    assert.ok(item.plannedFiles.some(scope => scope === path || scope.endsWith('/') && path.startsWith(scope)), `${path} is covered`);
  assert.ok(!item.plannedFiles.includes('src/'), 'widened only as far as the bound needs');
  assert.deepEqual(coalescedScope(['a.ts', 'src/b.ts']), ['a.ts', 'src/b.ts'], 'within the bound nothing changes');
});

test('unit:review-followups-filed — an approval with findings only keeps retrying its filing past the retry count, since no thread holds the merge', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
    const gh = github('AC-1 met.\nFollow-up finding: src/c.ts:12 — the retry is unbounded\nResolved threads: none\nFollow-up threads: none'), config = await loadMasterConfig(root);
    const refusing = async () => { throw new Error('Graphyard refused the follow-up item (503): unavailable'); };
    let clock = Date.parse('2026-09-24T13:00:00Z');
    const now = () => new Date(clock);
    for (let attempt = 1; attempt <= threadResolutionAttempts; attempt++, clock += 60_000)
      await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run, createFollowUpItem: refusing, now });
    const items = creator();
    // Within the slower pace, nothing is retried yet.
    await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run, createFollowUpItem: items.create, now });
    assert.equal(items.created.length, 0);
    // Past it, the filing is retried and the finding is filed.
    clock += followUpExhaustedRetryMs;
    const settled = await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run, createFollowUpItem: items.create, now });
    assert.equal(items.created.length, 1);
    assert.ok(items.created[0].item.description.includes('src/c.ts:12 — the retry is unbounded'));
    assert.equal(settled.reviews[0].followUps?.item, 'GY-201');
    assert.equal(settled.reviews[0].followUps?.failure, undefined);
  } finally { await cleanup(); }
});
