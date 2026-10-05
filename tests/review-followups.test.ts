import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { nitReplyPrefix, parseFollowUpThreads, parseResolvedThreads, threadSection } from '../src/review-threads.js';
import { bindReviewer, followUpFilingBoundMs, followUpThreadIds, launchReview, readReviewLedger, reconcileReviews, reviewPrompt, reviewRetryPrompt, saveReviewerProfile, threadResolutionAttempts } from '../src/reviewer.js';
import { clientErrorStatus, nextClientErrorRun, repeatedClientErrorLimit, retryStopped } from '../src/retry-stop.js';
import { evaluate } from '../src/model/gates.js';
import { overdueTriage } from '../src/model/machine-backlog.js';
import { routineDecision, setAsideFollowUpThreads, threadResolutionGraceMs } from '../src/master-daemon.js';
import type { Observation, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-166, 2026-09-24: GY-164 took 19 attempts and five hours; its reviewer confirmed both criteria
// met around round 16 and kept requesting changes for new edge cases. The reviewer now judges the
// acceptance criteria, approves when they are met and nothing blocks them, and names everything
// else as follow-up. GY-1249, 2026-10-05: follow-up items made 48 of 90 open items and about a third
// of merges, so anything worth fixing is now BLOCKING and fixed on the same pull request; the
// follow-ups left are nits, which the loop answers with a reply and resolves, filing nothing.

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
  const root = await temporaryDirectory('followups'), credentialDirectory = await temporaryDirectory('followups-credentials');
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
    'as BLOCKING or FOLLOW-UP', 'BLOCKING: anything worth fixing before this merges', 'The same worker fixes BLOCKING findings on this pull request; nothing is deferred to another item',
    'FOLLOW-UP: nits only', 'Graphyard files no backlog item for a nit',
    // When to approve, and what a change request may cite.
    'APPROVE when every criterion is met and no finding or thread is BLOCKING',
    'REQUEST_CHANGES cites only BLOCKING findings, and names for each the acceptance criterion or defect it concerns', 'never request changes for a FOLLOW-UP',
    // The closing lines.
    '"Resolved threads: ID1 ID2"', '"Follow-up threads: ID3 ID4"', '"Overridden threads: ID5 ID6"', 'End the review body with three lines',
    'resolves each Follow-up thread with a reply; nits are not filed as backlog items',
  ]) assert.ok(prompt.includes(fragment), `the prompt must state: ${fragment}`);
  assert.doesNotMatch(prompt, /files the Follow-up threads|Follow-up finding:/, 'nothing tells the reviewer its nits are filed');
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
  // Stated verbatim: indentation, newlines and repeated spaces in a criterion reach the reviewer unchanged.
  const exact = [{ id: 'AC-1', text: 'The config reads:\n  retries:  3\n    backoff: exponential' }];
  assert.ok(reviewPrompt({ repository: 'owner/project' }, binding, undefined, undefined, exact).includes(`[AC-1] ${exact[0].text}`));
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
});

/** GitHub as the loop's own gh sees it: the approval, the PR's threads, replies and resolves. */
function github(body: string, options: { failReply?: string[]; breakReply?: string[]; loseReply?: string[]; paths?: Record<string, string>; extra?: string[] } = {}) {
  const calls: string[][] = [], resolved: string[] = [], replies: { thread: string; body: string }[] = [];
  const failReply = new Set(options.failReply ?? []), breakReply = new Set(options.breakReply ?? []), loseReply = new Set(options.loseReply ?? []);
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
      if (breakReply.has(target!)) throw new Error('gh: HTTP 502');
      replies.push({ thread: target!, body: args.find(arg => arg.startsWith('body='))!.slice('body='.length) });
      // GitHub accepted the reply, but its response never reached the loop.
      if (loseReply.has(target!)) { loseReply.delete(target!); throw new Error('gh: connection reset'); }
      return JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { id: `C_${target}` } } } });
    }
    if (query.includes('... on PullRequestReviewThread')) return JSON.stringify({ data: { node: { comments: { pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{ body: `finding on ${target}` }, ...replies.filter(reply => reply.thread === target).map(reply => ({ body: reply.body }))] } } } });
    if (query.includes('resolveReviewThread')) { resolved.push(target!); return JSON.stringify({ data: { resolveReviewThread: { thread: { id: target, isResolved: true } } } }); }
    if (query.includes('reviewThreads')) return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
      thread('PRRT_fixed0001', '2026-09-24T11:00:00Z'), thread('PRRT_follow001', '2026-09-24T11:00:00Z', 'src/b.ts'), thread('PRRT_follow002', '2026-09-24T11:10:00Z'),
      thread('PRRT_unnamed01', '2026-09-24T11:00:00Z'), thread('PRRT_later0001', '2026-09-24T12:30:00Z'), ...(options.extra ?? []).map(id => thread(id, '2026-09-24T11:00:00Z'))] } } } } });
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { run, calls, resolved, replies };
}
/** The threads the review's launch prompt listed: those open before the approval. */
const shown = ['PRRT_fixed0001', 'PRRT_follow001', 'PRRT_follow002', 'PRRT_unnamed01'].map(id => ({ id, author: 'chatgpt-codex-connector', path: 'src/a.ts', line: 3, outdated: false, excerpt: `finding on ${id}`, createdAt: '2026-09-24T11:00:00Z' }));
const approvalBody = 'AC-1 met. AC-2 met.\nResolved threads: PRRT_fixed0001\nFollow-up threads: PRRT_follow001 PRRT_follow002 PRRT_later0001';
/** Every control-plane request a pass makes: an item filed, appended to or held would be one. */
async function spyingFetch<T>(run: (requests: string[]) => Promise<T>) {
  const original = globalThis.fetch, requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => { requests.push(String(input instanceof Request ? input.url : input)); throw new Error('no control-plane request is expected'); }) as typeof fetch;
  try { return await run(requests); } finally { globalThis.fetch = original; }
}

test('unit:no-follow-up-items — an approval naming two nit threads resolves both with a reply and creates no item, holding no finding for one', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
    // Run with no injected seam: the loop's own defaults decide what is filed.
    const gh = github('AC-1 met. AC-2 met. Two nits, not worth a round.\nResolved threads: none\nFollow-up threads: PRRT_follow001 PRRT_follow002\nOverridden threads: none');
    const config = await loadMasterConfig(root);
    await spyingFetch(async requests => {
      const settled = await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run });
      assert.deepEqual([...gh.resolved].sort(), ['PRRT_follow001', 'PRRT_follow002'], 'both nit threads are resolved');
      assert.deepEqual(gh.replies.map(reply => reply.thread), ['PRRT_follow001', 'PRRT_follow002'], 'each with a reply');
      for (const reply of gh.replies) {
        assert.ok(reply.body.startsWith(nitReplyPrefix), reply.body);
        assert.match(reply.body, /nits are not filed as work items/);
        assert.doesNotMatch(reply.body, /GY-\d+ ships|tracked in|follow-up item/);
      }
      assert.deepEqual(requests, [], 'no item is created, appended to or held: the control plane is never asked');
      const record = settled.reviews[0].followUps!;
      assert.equal(record.item, undefined);
      assert.equal(record.findings, undefined);
      assert.deepEqual(record.resolved, ['PRRT_follow001', 'PRRT_follow002']);
      assert.equal(record.failure, undefined);
      assert.ok(settled.threads.some(line => /resolved follow-up review thread PRRT_follow001 on GY-64 PR #64 as a nit with a reply.*nothing filed/.test(line)), settled.threads.join('\n'));
      // The next cycle leaves GitHub alone and still asks nothing of the control plane.
      const before = gh.calls.length;
      const again = await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run });
      assert.equal(gh.calls.length, before);
      assert.deepEqual(again.threads, []);
      assert.deepEqual(requests, []);
    });
    // Nothing is kept on disk for a later filing.
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(join(root, '.graphyard/review-followups')).catch(() => []), []);
  } finally { await cleanup(); }
});

test('unit:no-follow-up-items — an item stored with pendingFollowUps still loads and evaluates, and nothing files or drops what it holds', async () => {
  const at = '2026-09-30T12:00:00.000Z';
  const findings = [{ path: 'src/a.ts', text: 'src/a.ts:3 — a held nit' }];
  const stored = (pendingFollowUps: unknown, overrides: Partial<Work> = {}) => JSON.parse(JSON.stringify({ ...work(overrides), pendingFollowUps })) as Work;
  const held = stored({ findings, at, filing: null, filed: null, dropped: null });
  const freezing = stored({ findings, at, filing: { key: 'followups-after-ship:GY-64:abc', count: 1, at }, filed: null, dropped: null }, { stage: 'done' } as Partial<Work>);
  const filed = stored({ findings, at, filed: { item: 'GY-65', at } });
  const dropped = stored({ findings, at, dropped: { reason: 'closed without shipping', at } });
  for (const item of [held, freezing, filed, dropped]) {
    const evaluated = evaluate(item, [item], new Date(), [15368]);
    assert.ok(evaluated.gates.length > 0, 'the gates evaluate');
    assert.deepEqual(item.pendingFollowUps?.findings, findings, 'the stored field is read as it was written');
  }
  assert.deepEqual(overdueTriage([held, freezing, filed, dropped], Date.now()), [], 'none of them is machine-filed backlog');
  // The loop's pass over them files, ships and drops nothing.
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
    const gh = github(approvalBody);
    await spyingFetch(async requests => {
      await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun, observe: () => verdict(), work: [held], threadsRun: gh.run });
      await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun, observe: () => verdict(), work: [freezing], threadsRun: gh.run });
      assert.deepEqual(requests, []);
    });
    assert.deepEqual(held.pendingFollowUps, { findings, at, filing: null, filed: null, dropped: null }, 'left exactly as stored');
  } finally { await cleanup(); }
});

test('unit:review-followups-filed — a reply and resolve on each named follow-up thread only, idempotent across cycles', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
    const gh = github(approvalBody);
    const config = await loadMasterConfig(root);
    const settled = await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run });
    // Replied on and resolved: the named follow-ups only; the Resolved line's thread is resolved as before.
    assert.deepEqual(gh.replies.map(reply => reply.thread), ['PRRT_follow001', 'PRRT_follow002']);
    assert.deepEqual([...gh.resolved].sort(), ['PRRT_fixed0001', 'PRRT_follow001', 'PRRT_follow002']);
    assert.ok(!gh.calls.some(call => call.some(arg => arg === 'thread=PRRT_unnamed01' || arg === 'thread=PRRT_later0001')), 'threads the verdict did not name, or could not have judged, are never touched');
    const record = settled.reviews[0];
    assert.deepEqual(record.followUps?.resolved, ['PRRT_follow001', 'PRRT_follow002']);
    assert.ok(record.followUps?.refused.some(entry => entry.startsWith('PRRT_later0001: not listed to the reviewer at launch')));
    assert.equal(record.followUps?.failure, undefined);
    // The next cycle leaves GitHub alone.
    const before = gh.calls.length;
    const again = await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run });
    assert.equal(gh.calls.length, before);
    assert.deepEqual(again.threads, []);
  } finally { await cleanup(); }
});

test('unit:review-followups-filed — a failure is recorded and retried without a second reply', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
    const config = await loadMasterConfig(root);
    const gh = github(approvalBody, { failReply: ['PRRT_follow002'] });
    const first = await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run });
    assert.deepEqual(first.reviews[0].followUps!.resolved, ['PRRT_follow001']);
    assert.match(first.reviews[0].followUps!.failure!, /PRRT_follow002: gh: HTTP 502/);
    assert.ok(first.threads.some(line => /follow-up thread resolution for GY-64 approval 77 failed \(attempt 1\)/.test(line)), first.threads.join('\n'));
    // Second pass: only the failed thread is answered; no thread gets a second reply.
    const second = await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run });
    assert.deepEqual(gh.replies.map(reply => reply.thread), ['PRRT_follow001', 'PRRT_follow002']);
    assert.deepEqual(second.reviews[0].followUps!.resolved, ['PRRT_follow001', 'PRRT_follow002']);
    assert.equal(second.reviews[0].followUps!.failure, undefined);
  } finally { await cleanup(); }
});

test('unit:review-followups-filed — a named thread the reviewer was not shown at launch is never answered or resolved', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
    // PRRT_unshown01 is open and predates the approval, but the launch did not list it (past the bound, or quoted from an excerpt).
    const gh = github('Criteria met.\nResolved threads: none\nFollow-up threads: PRRT_follow001 PRRT_unshown01', { extra: ['PRRT_unshown01'] });
    const settled = await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run });
    assert.deepEqual(gh.replies.map(reply => reply.thread), ['PRRT_follow001']);
    assert.ok(!gh.calls.some(call => call.includes('thread=PRRT_unshown01')), 'the unshown thread is never touched');
    assert.ok(settled.reviews[0].followUps!.refused.some(entry => entry.startsWith('PRRT_unshown01: not listed to the reviewer at launch')));
    assert.deepEqual([...followUpThreadIds(settled.reviews, [work()]).get('GY-64') ?? []], ['PRRT_follow001'], 'nor set aside from rework');
  } finally { await cleanup(); }
  // A launch that could not read the threads showed its reviewer none: its approval answers nothing.
  const blind = await boundMaster();
  try {
    await launchReview(blind.root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => { throw new Error('gh: HTTP 502'); } });
    const gh = github(approvalBody);
    await reconcileReviews(blind.root, await loadMasterConfig(blind.root), { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run });
    assert.equal(gh.replies.length, 0);
  } finally { await blind.cleanup(); }
});

test('unit:review-followups-filed — a thread path past the ledger bound is recorded within it, so the retry record survives', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
    const path = `src/${'deep/'.repeat(300)}file.ts`;
    const gh = github(approvalBody, { paths: { PRRT_follow001: path } }), config = await loadMasterConfig(root);
    await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run });
    const filing = (await readReviewLedger(root)).reviews[0].followUps!;
    assert.deepEqual(filing.resolved, ['PRRT_follow001', 'PRRT_follow002']);
    const recorded = filing.threads.find(thread => thread.id === 'PRRT_follow001')!.path;
    assert.ok(recorded.length <= 1000 && path.endsWith(recorded), `${recorded.length} characters: the file end, within the bound`);
    // The next cycle reads the record and replies to and resolves nothing again.
    const before = gh.calls.length;
    await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run });
    assert.equal(gh.calls.length, before);
  } finally { await cleanup(); }
});

test('unit:review-followups-filed — nothing is answered for a change request, a stale head, or an approval naming no follow-up', async () => {
  for (const scenario of [
    { name: 'changes requested', verdict: verdict('CHANGES_REQUESTED'), work: work(), body: approvalBody },
    { name: 'stale head', verdict: verdict(), work: work({ candidate: { sha: 'c1'.padEnd(40, 'f'), baseSha: B, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' } } as Partial<Work>), body: approvalBody },
    { name: 'no follow-up line', verdict: verdict(), work: work(), body: 'AC-1 met. AC-2 met.\nResolved threads: PRRT_fixed0001' },
    { name: 'follow-up none', verdict: verdict(), work: work(), body: 'AC-1 met. AC-2 met.\nResolved threads: none\nFollow-up threads: none' },
  ]) {
    const { root, cleanup } = await boundMaster();
    try {
      await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
      const gh = github(scenario.body);
      await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun, observe: () => scenario.verdict, work: [scenario.work], threadsRun: gh.run });
      assert.equal(gh.replies.length, 0, scenario.name);
    } finally { await cleanup(); }
  }
});

test('unit:review-followups-filed — a criteria-only approval with a Follow-up line but no Resolved line vouches no thread fixed', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    const listed = ['PRRT_fixed0001', 'PRRT_follow001'].map(id => ({ id, author: 'codex', path: 'src/a.ts', line: 3, outdated: false, excerpt: 'finding', createdAt: '2026-09-24T11:00:00Z' }));
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => listed });
    const gh = github('Criteria met.\nFollow-up threads: PRRT_follow001');
    const settled = await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run });
    assert.deepEqual(settled.reviews[0].threadResolution?.resolved, [], 'a listed thread named on neither line is never resolved');
    assert.equal(settled.reviews[0].threadResolution?.implicit, false);
    assert.deepEqual(gh.resolved, ['PRRT_follow001'], 'only the follow-up thread is resolved');
    assert.deepEqual(gh.replies.map(reply => reply.thread), ['PRRT_follow001'], 'the follow-up is answered as a nit, not resolved as fixed');
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
    const gh = github(approvalBody);
    const settled = await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run });
    followUps = followUpThreadIds(settled.reviews, [work()]);
  } finally { await cleanup(); }
  assert.deepEqual([...followUps.get('GY-64') ?? []].sort(), ['PRRT_follow001', 'PRRT_follow002'], 'a thread opened after the approval is not its follow-up');

  // Without the set-aside the approved head's open threads are a rework, as before.
  assert.equal(decide(item(['PRRT_follow001', 'PRRT_follow002']), new Map())?.action, 'rework');
  // Every open thread is a nit still being answered: no rework is requested.
  assert.equal(decide(item(['PRRT_follow001', 'PRRT_follow002']), followUps), null);
  // A thread the approval did not name still is, and the rework names only it.
  const other = decide(item(['PRRT_follow001', 'PRRT_later0001']), followUps);
  assert.equal(other?.action, 'rework');
  assert.equal(other?.binding, `${H}:threads:PRRT_later0001`);
  // Another item's follow-ups set nothing aside here.
  assert.equal(decide(item(['PRRT_follow001']), new Map([['GY-99', new Set(['PRRT_follow001'])]]))?.action, 'rework');
});

test('unit:review-followups-filed — a resolved nit thread reopened before the merge returns to rework instead of staying set aside, whatever the coordinator clock says', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
    const gh = github(approvalBody), config = await loadMasterConfig(root);
    const filedObservation = Date.now();
    const open = (at: number, ids: string[]) => work({}, { at: new Date(at).toISOString(), reviews: [{ reviewer, sha: H, state: 'APPROVED', id: 77, submittedAt }], conversations: { required: true, unresolved: ids.map(id => ({ id, author: 'codex', path: 'src/a.ts', line: 3, outdated: false })) } } as Partial<Observation>);
    // The coordinator's clock runs an hour ahead of the control plane's.
    const ahead = () => new Date(Date.now() + 3_600_000);
    const reconcile = (entry: Work) => reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [entry], threadsRun: gh.run, now: ahead });
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
    assert.equal(gh.replies.length, 2, 'a reopen is never answered twice');
  } finally { await cleanup(); }
});

test('unit:review-followups-filed — follow-up threads return to rework once answering them has failed on every retry', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
    const gh = github(approvalBody, { breakReply: ['PRRT_follow001'] }), config = await loadMasterConfig(root);
    let reviews = (await readReviewLedger(root)).reviews;
    for (let attempt = 1; attempt <= threadResolutionAttempts; attempt++) {
      reviews = (await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run })).reviews;
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

test('unit:review-followups-filed — a resolution still being retried sets nothing aside once the head moves past its approval', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
    const gh = github(approvalBody, { breakReply: ['PRRT_follow001'] }), config = await loadMasterConfig(root);
    const { reviews } = await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run });
    assert.equal(reviews[0].followUps?.attempts, 1);
    assert.ok(followUpThreadIds(reviews, [work()]).get('GY-64')?.has('PRRT_follow001'), 'the approved head: set aside while retried');
    // The candidate moves on before the retry: the loop stops answering for the old approval, so its
    // threads return to the new head's rework instead of being set aside with nothing to answer them.
    const moved = 'c1'.padEnd(40, 'f');
    const next = work({ candidate: { sha: moved, baseSha: B, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' } } as Partial<Work>);
    assert.equal(followUpThreadIds(reviews, [next]).get('GY-64'), undefined);
    const replies = gh.replies.length;
    await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [next], threadsRun: gh.run });
    assert.equal(gh.replies.length, replies, 'nothing answers the old approval on the new head');
    const at = Date.parse(submittedAt) + threadResolutionGraceMs;
    const item = work({ candidate: next.candidate } as Partial<Work>, { at: new Date(at).toISOString(), candidate: { ...next.candidate!, pr: 64 }, conversations: { required: true, unresolved: [{ id: 'PRRT_follow001', author: 'codex', path: 'src/b.ts', line: 3, outdated: false }] } } as Partial<Observation>);
    const setAside = setAsideFollowUpThreads({ work: [item] }, followUpThreadIds(reviews, [item])).work[0];
    assert.deepEqual(setAside.observation?.conversations?.unresolved.map(thread => thread.id), ['PRRT_follow001'], 'the thread stays in the new head\'s snapshot');
    assert.deepEqual(routineDecision(setAside, { autoMerge: true }, at), routineDecision(item, { autoMerge: true }, at));
  } finally { await cleanup(); }
});

test('unit:review-followups-filed — an approval the dispatcher has not yet answered sets its listed threads aside, within a bound', async () => {
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
    // Once answered, the recorded step decides instead.
    const gh = github('Criteria met.\nResolved threads: none\nFollow-up threads: PRRT_follow001');
    const settled = await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run });
    assert.deepEqual([...followUpThreadIds(settled.reviews, [approved()], { reviewer, now: approvedAt + 60_000 }).get('GY-64') ?? []], ['PRRT_follow001']);
  } finally { await cleanup(); }
});

test('unit:review-followups-filed — an approval whose item merged before the first pass still answers and resolves its nit threads', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
    const gh = github('AC-1 met.\nResolved threads: none\nFollow-up threads: PRRT_follow001');
    const delivered = work({ stage: 'done' } as Partial<Work>, { merged: true, mergeSha: 'c1'.padEnd(40, 'f'), prState: 'closed' } as Partial<Observation>);
    const settled = await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun, observe: () => verdict(), work: [delivered], threadsRun: gh.run });
    assert.deepEqual(settled.reviews[0].followUps?.resolved, ['PRRT_follow001'], 'the daemon merging first does not leave the nit open');
    // Answered once: the next pass leaves the delivered item alone.
    const before = gh.calls.length;
    await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun, observe: () => verdict(), work: [delivered], threadsRun: gh.run });
    assert.equal(gh.calls.length, before);
  } finally { await cleanup(); }
});

test('unit:review-followups-filed — a named follow-up thread somebody resolved first is left as they resolved it', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
    const gh = github('AC-1 met. AC-2 met.\nResolved threads: none\nFollow-up threads: PRRT_follow001');
    gh.resolved.push('PRRT_follow001');
    const settled = await reconcileReviews(root, await loadMasterConfig(root), { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run });
    assert.deepEqual(gh.replies, [], 'a thread already resolved is not answered again');
    const record = settled.reviews[0];
    assert.deepEqual(record.followUps?.resolved, ['PRRT_follow001']);
    assert.deepEqual(record.followUps?.refused, []);
    assert.equal(record.followUps?.failure, undefined);
  } finally { await cleanup(); }
});

test('unit:review-followups-filed — an approval carried onto a new tip before its threads are answered sets its listed threads aside all the same', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    const listed = ['PRRT_follow001', 'PRRT_follow002'].map(id => ({ id, author: 'codex', path: 'src/a.ts', line: 3, outdated: false, excerpt: 'finding', createdAt: '2026-09-24T11:00:00Z' }));
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => listed });
    const { reviews } = await readReviewLedger(root);
    // The merge queue published a new tip after GitHub recorded the approval of H, and carried it there.
    const tip = 'c2'.padEnd(40, 'f'), approvedAt = Date.parse(submittedAt), at = approvedAt + threadResolutionGraceMs;
    const carriedOnto = (reviewId: number) => {
      const candidate = { sha: tip, baseSha: B, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' };
      return work({ candidate, baseRefresh: { head: tip, carry: { to: { sha: tip, baseSha: B }, policyRevision: 1, evidence: [],
        approval: { carried: true, provider: 'github', reviewer, sha: H, reviewId, originalSha: H, reason: 'carried' } } } } as unknown as Partial<Work>,
      { at: new Date(at).toISOString(), candidate: { ...candidate }, reviews: [{ reviewer, sha: H, state: 'APPROVED', id: 77, submittedAt }],
        conversations: { required: true, unresolved: listed.map(({ excerpt: _excerpt, createdAt: _createdAt, ...thread }) => thread) } } as Partial<Observation>);
    };
    const item = carriedOnto(77);
    assert.deepEqual([...followUpThreadIds(reviews, [item], { reviewer, now: at }).get('GY-64') ?? []].sort(), ['PRRT_follow001', 'PRRT_follow002']);
    assert.equal(routineDecision(setAsideFollowUpThreads({ work: [item] }, followUpThreadIds(reviews, [item], { reviewer, now: at })).work[0], { autoMerge: true }, at), null, 'no thread rework for the carried approval\'s follow-ups');
    // A carry of some other approval vouches nothing for these threads.
    assert.equal(followUpThreadIds(reviews, [carriedOnto(78)], { reviewer, now: at }).get('GY-64'), undefined);
  } finally { await cleanup(); }
});

test('unit:review-followups-filed — a reply GitHub accepted but whose response was lost is found on the thread, never posted twice', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
    const gh = github(approvalBody, { loseReply: ['PRRT_follow002'] }), config = await loadMasterConfig(root);
    const first = await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run });
    assert.match(first.reviews[0].followUps!.failure!, /PRRT_follow002: gh: connection reset/);
    assert.ok(!first.reviews[0].followUps!.replied.includes('PRRT_follow002'), 'the lost reply is not on the record');
    const second = await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run });
    assert.deepEqual(gh.replies.map(reply => reply.thread), ['PRRT_follow001', 'PRRT_follow002'], 'one reply per thread');
    assert.deepEqual(second.reviews[0].followUps!.replied, ['PRRT_follow001', 'PRRT_follow002']);
    assert.deepEqual(second.reviews[0].followUps!.resolved, ['PRRT_follow001', 'PRRT_follow002']);
    assert.equal(second.reviews[0].followUps!.failure, undefined);
  } finally { await cleanup(); }
});

test('unit:review-followups-filed — while the approval body cannot be read, every thread listed to that review stays set aside from rework', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
    const gh = github(approvalBody), config = await loadMasterConfig(root);
    let unreadable = true;
    const run = (command: string, args: string[]) => {
      if (unreadable && args[1] === 'repos/owner/project/pulls/64/reviews/77') throw new Error('gh: HTTP 502');
      return gh.run(command, args);
    };
    const first = await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: run });
    const filing = first.reviews[0].followUps!;
    assert.match(filing.failure!, /review 77 could not be read/);
    assert.deepEqual(filing.named, []);
    assert.deepEqual([...followUpThreadIds(first.reviews, [work()]).get('GY-64') ?? []].sort(), shown.map(thread => thread.id).sort(), 'no listed thread goes to rework before the body is classified');
    // Once the body is read, only the threads it named FOLLOW-UP stay aside.
    unreadable = false;
    const second = await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: run });
    assert.equal(second.reviews[0].followUps!.classified, true);
    assert.deepEqual([...followUpThreadIds(second.reviews, [work()]).get('GY-64') ?? []].sort(), ['PRRT_follow001', 'PRRT_follow002']);
    // A step whose retries are all spent unclassified sets nothing aside.
    const spent = first.reviews.map(record => ({ ...record, followUps: { ...record.followUps!, attempts: threadResolutionAttempts } }));
    assert.equal(followUpThreadIds(spent, [work()]).get('GY-64'), undefined);
  } finally { await cleanup(); }
});

test('unit:review-followups-filed — a thread named on both closing lines is answered as a nit, never resolved as fixed', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
    const body = 'AC-1 met. AC-2 met.\nResolved threads: PRRT_fixed0001 PRRT_follow001\nFollow-up threads: PRRT_follow001';
    const gh = github(body), config = await loadMasterConfig(root);
    const settled = await reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: gh.run });
    const record = settled.reviews[0];
    assert.deepEqual(record.threadResolution?.named, ['PRRT_fixed0001'], 'the ambiguous thread is not vouched fixed');
    assert.deepEqual(gh.replies.map(reply => reply.thread), ['PRRT_follow001'], 'it is resolved only with the nit reply');
    assert.deepEqual(record.followUps?.resolved, ['PRRT_follow001']);
    assert.deepEqual([...gh.resolved].sort(), ['PRRT_fixed0001', 'PRRT_follow001']);
  } finally { await cleanup(); }
});

test('unit:review-followups-filed — the dispatcher and master status reconciling at once post one reply per thread', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await launchReview(root, work(), 'claude-reviewer', [], new Date().toISOString(), { run: herdrRun, mint, threads: async () => shown });
    const gh = github(approvalBody), config = await loadMasterConfig(root);
    // Every GitHub call yields, so two passes interleave between the reply check and the reply.
    const slow = async (command: string, args: string[]) => { await new Promise(done => setTimeout(done, 5)); return gh.run(command, args); };
    const pass = () => reconcileReviews(root, config, { run: herdrRun, observe: () => verdict(), work: [work()], threadsRun: slow });
    await Promise.all([pass(), pass()]);
    const after = await pass();
    assert.deepEqual(gh.replies.map(reply => reply.thread), ['PRRT_follow001', 'PRRT_follow002'], 'one reply per named thread');
    assert.deepEqual(after.reviews[0].followUps?.replied, ['PRRT_follow001', 'PRRT_follow002']);
    assert.deepEqual(after.reviews[0].followUps?.resolved, ['PRRT_follow001', 'PRRT_follow002']);
    assert.equal(after.reviews[0].followUps?.failure, undefined);
    assert.deepEqual((await readReviewLedger(root)).reviews[0].followUps?.resolved, ['PRRT_follow001', 'PRRT_follow002'], 'the step is on the saved ledger');
  } finally { await cleanup(); }
});

test('unit:repeated-4xx-retry-stops — only an unchanged 4xx counts toward the stop', () => {
  assert.equal(clientErrorStatus('Graphyard refused the follow-up item (409): reused'), 409);
  assert.equal(clientErrorStatus('gh: HTTP 422: Validation Failed'), 422);
  assert.equal(clientErrorStatus('Graphyard refused the follow-up item (503): unavailable'), null);
  assert.equal(clientErrorStatus('fetch failed: connection reset'), null);
  let run = undefined as ReturnType<typeof nextClientErrorRun>;
  for (let attempt = 0; attempt < repeatedClientErrorLimit - 1; attempt++) run = nextClientErrorRun(run, 'refused (403): forbidden');
  assert.equal(retryStopped(run), false);
  // A different error restarts the count; a 5xx or a transport error ends it.
  assert.equal(nextClientErrorRun(run, 'refused (404): gone')?.count, 1);
  assert.equal(nextClientErrorRun(run, 'refused (503): unavailable'), undefined);
  assert.equal(nextClientErrorRun(run, undefined), undefined);
  assert.equal(retryStopped(nextClientErrorRun(run, 'refused (403): forbidden')), true);
});
