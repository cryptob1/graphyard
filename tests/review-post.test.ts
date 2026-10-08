import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { execFile as execFileCallback, execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadMasterConfig, sessionHarnessPlan, setupMaster } from '../src/master.js';
import { harnessDecision } from '../src/harness.js';
import { bindReviewer, launchReview, saveReviewerProfile, mintReviewerToken, readReviewLedger, reviewPrompt, reviewRetryPrompt } from '../src/reviewer.js';
import type { ReviewPostBinding } from '../src/review-post.js';
import type { Work } from '../src/model.js';
import type { LaunchThread } from '../src/review-threads.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const execFile = promisify(execFileCallback);
// The new modules are imported per test, so a tree without them fails each proof as a test case.
const reviewPost = () => import('../src/review-post.js');
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const H = 'a'.repeat(40), B = 'b'.repeat(40);
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const installed = async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } });

async function boundMaster() {
  const root = await temporaryDirectory('review-post'), credentialDirectory = await temporaryDirectory('review-post-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory, herdrWorkspace: 'workspace-graphyard' }, coordinatorStatus as typeof fetch);
  await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentialDirectory, 'reviewers') }, installed);
  await saveReviewerProfile(root, { name: 'reviewer-claude', agentName: 'review-claude-1', kind: 'claude' });
  return { root, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); } };
}
function work(): Work {
  const candidate = { sha: H, baseSha: B, pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' };
  return { id: 'work-id', key: 'GY-42', title: 'Post through review post', description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:review-post'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage: 'review', revision: 9, policyRevision: 2, createdAt: '', updatedAt: '', stageEnteredAt: '', ready: true, epoch: 1, lease: null, workspaces: [],
    candidate, submission: { epoch: 1, pr: 42 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [],
    observation: { at: new Date().toISOString(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: [], scopeFiles: [], prState: 'open', draft: false } } as unknown as Work;
}
const herdr = (calls: string[][]) => (_command: string, args: string[]) => { calls.push(args); return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'pane-review', tab_id: 'tab-review' }, tab: { tab_id: 'tab-review' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} }); };
const mint = async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() });
const sessionDirectoryOf = (calls: string[][]) => calls[0].find(value => value.startsWith('GH_CONFIG_DIR='))!.slice('GH_CONFIG_DIR='.length);

test('unit:review-binding-written — the launch writes a private review binding beside the credential from the same thread read its record keeps; one it cannot write starts nothing', async () => {
  const { reviewBindingFile } = await reviewPost();
  const { root, cleanup } = await boundMaster();
  try {
    const threads: LaunchThread[] = [{ id: 'PRRT_listed0001', author: 'codex', path: 'src/a.ts', line: 3, outdated: false, excerpt: 'Fix', aliases: ['PRRC_comment0001', '991001'] }, { id: 'PRRT_listed0002', author: 'codex', path: 'src/b.ts', line: null, outdated: true, excerpt: 'Also' }];
    const calls: string[][] = [];
    await launchReview(root, work(), 'reviewer-claude', [], new Date().toISOString(), { run: herdr(calls), mint, threads: async () => threads });
    const directory = sessionDirectoryOf(calls);
    assert.equal((await stat(join(directory, reviewBindingFile))).mode & 0o777, 0o600);
    const binding = JSON.parse(await readFile(join(directory, reviewBindingFile), 'utf8'));
    const record = (await readReviewLedger(root)).reviews[0];
    assert.deepEqual(binding, { repository: 'owner/project', key: 'GY-42', pr: 42, sha: H, baseSha: B, policyRevision: 2, criteriaOnly: true, threadsListed: record.threadsListed, threadAliases: record.threadAliases });
    assert.deepEqual(binding.threadsListed, ['PRRT_listed0001', 'PRRT_listed0002']);
    assert.deepEqual(binding.threadAliases, { PRRT_listed0001: ['PRRC_comment0001', '991001'] });
    assert.ok(calls[0].includes(`GRAPHYARD_REVIEW=GY-42@${H}`));
  } finally { await cleanup(); }

  // A failed thread read is bound as that failure, never as "no threads".
  const failed = await boundMaster();
  try {
    const calls: string[][] = [];
    await launchReview(failed.root, work(), 'reviewer-claude', [], new Date().toISOString(), { run: herdr(calls), mint, threads: async () => { throw new Error('GitHub refused'); } });
    const binding = JSON.parse(await readFile(join(sessionDirectoryOf(calls), reviewBindingFile), 'utf8'));
    assert.match(binding.threadReadFailure, /could not be read: GitHub refused/);
    assert.equal(binding.threadsListed, undefined);
    assert.equal(binding.threadReadFailure, (await readReviewLedger(failed.root)).reviews[0].threadReadFailure);
  } finally { await failed.cleanup(); }

  // A binding that cannot be written: no Herdr tab, no record, and the credential directory is gone.
  const refused = await boundMaster();
  try {
    const sessions = join((await loadMasterConfig(refused.root)).reviewer!.credentialFile, '..', 'sessions');
    const calls: string[][] = [];
    const blockBinding = async () => { const [id] = await readdir(sessions); await mkdir(join(sessions, id!, reviewBindingFile)); return []; };
    await assert.rejects(launchReview(refused.root, work(), 'reviewer-claude', [], new Date().toISOString(), { run: herdr(calls), mint, threads: blockBinding }), /EEXIST|EISDIR/);
    assert.equal(calls.some(call => call[0] === 'tab'), false, 'no session is started');
    assert.deepEqual(await readdir(sessions), [], 'no credential is left behind');
    assert.deepEqual((await readReviewLedger(refused.root)).reviews, [], 'no review is recorded');
  } finally { await refused.cleanup(); }
});

async function session(binding: Partial<ReviewPostBinding> = {}) {
  const { writeReviewBinding } = await reviewPost();
  const directory = await temporaryDirectory('review-post-session');
  await writeReviewBinding(directory, { repository: 'owner/project', key: 'GY-42', pr: 42, sha: H, baseSha: B, policyRevision: 2, criteriaOnly: true, threadsListed: [], ...binding });
  return { directory, environment: { GH_CONFIG_DIR: directory, GRAPHYARD_REVIEW: `GY-42@${H}` }, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
/** A gh stub: each `pr view` answers the next state (the last repeats); `api` posts and answers review 9001. */
function gh(states: { mergeable: string; headRefOid?: string }[]) {
  const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  let view = 0;
  const run = (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    assert.equal(command, 'gh'); calls.push({ args, env: options?.env });
    if (args[0] === 'pr') { const state = states[Math.min(view++, states.length - 1)]!; return JSON.stringify({ mergeStateStatus: 'CLEAN', headRefOid: H, ...state }); }
    return JSON.stringify({ id: 9001, state: 'APPROVED' });
  };
  return { run, calls, posts: () => calls.filter(call => call.args[0] === 'api') };
}
const body = 'AC-1 met.\nResolved threads: none\nFollow-up threads: none\nOverridden threads: none';

test('unit:review-post-head-guard — review post posts nothing without a binding, for another KEY@SHA, or when the pull request head moved', async () => {
  const { postReview, ReviewPostRefusal } = await reviewPost();
  const { commands } = await import('../src/cli/index.js');
  const bound = await session();
  try {
    const refused = async (environment: NodeJS.ProcessEnv, states: { mergeable: string; headRefOid?: string }[] = [{ mergeable: 'MERGEABLE' }], pattern: RegExp) => {
      const stub = gh(states);
      await assert.rejects(postReview({ event: 'APPROVE', body, cliPath: launcher, environment }, { run: stub.run, sleep: async () => {} }), (error: Error) => error instanceof ReviewPostRefusal && pattern.test(error.message));
      assert.equal(stub.posts().length, 0, 'nothing is posted');
    };
    const empty = await temporaryDirectory('review-post-empty');
    try { await refused({ GH_CONFIG_DIR: empty, GRAPHYARD_REVIEW: `GY-42@${H}` }, undefined, /holds no review-binding\.json/); } finally { await rm(empty, { recursive: true, force: true }); }
    await refused({ GRAPHYARD_REVIEW: `GY-42@${H}` }, undefined, /GH_CONFIG_DIR is unset/);
    await refused({ ...bound.environment, GRAPHYARD_REVIEW: `GY-42@${'c'.repeat(40)}` }, undefined, /not this launch's GY-42@a{40}/);
    await refused({ ...bound.environment, GRAPHYARD_REVIEW: undefined }, undefined, /GRAPHYARD_REVIEW is unset/);
    await refused(bound.environment, [{ mergeable: 'MERGEABLE', headRefOid: 'c'.repeat(40) }], /head is c{40}, not a{40}/);
    // A head that moves while mergeability is being recomputed is refused too.
    await refused(bound.environment, [{ mergeable: 'UNKNOWN' }, { mergeable: 'MERGEABLE', headRefOid: 'c'.repeat(40) }], /head is c{40}/);
    // The launcher itself: no binding, a non-zero exit, nothing posted.
    const empty2 = await temporaryDirectory('review-post-cli');
    try {
      const failure = await execFile(process.execPath, [launcher, 'review', 'post', '--event', 'APPROVE', '--body', body], { env: { ...process.env, GH_CONFIG_DIR: empty2, GRAPHYARD_REVIEW: `GY-42@${H}` } }).then(() => null, error => error);
      assert.ok(failure, 'the CLI exits non-zero'); assert.match(failure.stderr, /Review not posted: .*holds no review-binding\.json/);
      assert.ok(failure.stderr.includes(`node ${launcher} review post --event APPROVE <<'EOF'`));
    } finally { await rm(empty2, { recursive: true, force: true }); }
    const review = commands.find(entry => entry.name === 'review');
    assert.ok(review, 'review is registered'); assert.equal(review!.readsConnection?.(undefined), false, 'review post needs no Graphyard credential');
  } finally { await bound.cleanup(); }
});

test('unit:review-post-mergeable-poll — while mergeable is UNKNOWN, review post polls every 5 seconds for at most 2 minutes, then refuses with a retry instruction', async () => {
  const { mergeablePollBoundMs, mergeablePollMs, postReview } = await reviewPost();
  const bound = await session();
  try {
    let clock = 0; const slept: number[] = [];
    const dependencies = (run: ReturnType<typeof gh>['run']) => ({ run, now: () => clock, sleep: async (ms: number) => { slept.push(ms); clock += ms; } });
    // Recomputed after two polls: the verdict posts once mergeable is known.
    const settles = gh([{ mergeable: 'UNKNOWN' }, { mergeable: 'UNKNOWN' }, { mergeable: 'CONFLICTING' }]);
    await postReview({ event: 'REQUEST_CHANGES', body, cliPath: launcher, environment: bound.environment }, dependencies(settles.run));
    assert.deepEqual(slept, [mergeablePollMs, mergeablePollMs]); assert.equal(mergeablePollMs, 5_000);
    assert.deepEqual(settles.calls.filter(call => call.args[0] === 'pr').map(call => call.args), Array(3).fill(['pr', 'view', '42', '--repo', 'owner/project', '--json', 'mergeable,mergeStateStatus,headRefOid']));
    assert.equal(settles.posts().length, 1);
    // Never recomputed: refused after two minutes, nothing posted.
    clock = 0; slept.length = 0;
    const stuck = gh([{ mergeable: 'UNKNOWN' }]);
    await assert.rejects(postReview({ event: 'APPROVE', body, cliPath: launcher, environment: bound.environment }, dependencies(stuck.run)), /mergeable UNKNOWN .* after 120 seconds.*run the same command again/s);
    assert.equal(mergeablePollBoundMs, 120_000);
    assert.ok(clock <= mergeablePollBoundMs, 'it waits at most two minutes');
    assert.equal(slept.length, mergeablePollBoundMs / mergeablePollMs);
    assert.equal(stuck.posts().length, 0);
  } finally { await bound.cleanup(); }
});

test('unit:review-post-thread-lines — an approval accounts for every listed thread on the three lines; any verdict naming an unlisted ID, or a resolved thread after a failed read, is refused', async () => {
  const { threadLineRefusals } = await reviewPost();
  const listed = { threadsListed: ['PRRT_listed0001', 'PRRT_listed0002'], threadAliases: { PRRT_listed0001: ['PRRC_comment0001'] } };
  const lines = (resolved: string, followUp: string, overridden: string) => `Judged.\nResolved threads: ${resolved}\nFollow-up threads: ${followUp}\nOverridden threads: ${overridden}`;
  assert.deepEqual(threadLineRefusals('APPROVE', lines('PRRT_listed0001', 'PRRT_listed0002', 'none'), listed), []);
  assert.deepEqual(threadLineRefusals('APPROVE', lines('PRRC_comment0001', 'none', 'PRRT_listed0002'), listed), [], 'a comment ID of a listed thread names it');
  const missing = threadLineRefusals('APPROVE', 'Judged.\nResolved threads: PRRT_listed0001 PRRT_listed0002', listed);
  assert.match(missing.join(), /lacks "Follow-up threads:", "Overridden threads:"/);
  assert.match(threadLineRefusals('APPROVE', lines('PRRT_listed0001', 'none', 'none'), listed).join(), /leaves PRRT_listed0002 on none of the three thread lines/);
  assert.match(threadLineRefusals('APPROVE', lines('PRRT_listed0001 PRRT_unlisted99', 'PRRT_listed0002', 'none'), listed).join(), /name PRRT_unlisted99, which is not a thread this launch listed/);
  // REQUEST_CHANGES and COMMENT: only an unlisted ID refuses.
  for (const event of ['REQUEST_CHANGES', 'COMMENT'] as const) {
    assert.deepEqual(threadLineRefusals(event, 'Blocking: AC-1 unmet.', listed), []);
    assert.deepEqual(threadLineRefusals(event, lines('none', 'PRRT_listed0001', 'none'), listed), []);
    assert.match(threadLineRefusals(event, lines('PRRT_unlisted99', 'none', 'none'), listed).join(), /PRRT_unlisted99/);
  }
  // A launch that listed no threads: an approval needs no lines, and names no ID.
  assert.deepEqual(threadLineRefusals('APPROVE', 'All criteria met.', { threadsListed: [] }), []);
  assert.match(threadLineRefusals('APPROVE', lines('PRRT_unlisted99', 'none', 'none'), { threadsListed: [] }).join(), /it listed none/);
  // A failed read accepts no ID on the Resolved threads line.
  const failure = { threadReadFailure: 'the review threads could not be read' };
  assert.match(threadLineRefusals('APPROVE', lines('PRRT_listed0001', 'none', 'none'), failure).join(), /no thread can be claimed resolved; remove PRRT_listed0001/);
  assert.match(threadLineRefusals('COMMENT', lines('PRRT_listed0001', 'none', 'none'), failure).join(), /remove PRRT_listed0001/);
  assert.deepEqual(threadLineRefusals('APPROVE', lines('none', 'none', 'none'), failure), []);
});

test('unit:review-post-example-on-error — a valid call makes exactly one review POST bound to the head under the inherited GH_CONFIG_DIR; every refusal ends with a correct invocation', async () => {
  const { postReview, ReviewPostRefusal } = await reviewPost();
  const bound = await session({ threadsListed: ['PRRT_listed0001'] });
  try {
    const stub = gh([{ mergeable: 'MERGEABLE' }]);
    const approval = 'AC-1 met.\nResolved threads: PRRT_listed0001\nFollow-up threads: none\nOverridden threads: none';
    const posted = await postReview({ event: 'approve', body: approval, cliPath: launcher, environment: bound.environment }, { run: stub.run, sleep: async () => {} });
    assert.deepEqual(posted, { reviewId: 9001, event: 'APPROVE', key: 'GY-42', pr: 42, sha: H });
    assert.equal(stub.posts().length, 1);
    assert.deepEqual(stub.posts()[0]!.args, ['api', '--method', 'POST', 'repos/owner/project/pulls/42/reviews', '-f', `commit_id=${H}`, '-f', 'event=APPROVE', '-f', `body=${approval}`]);
    assert.equal(stub.posts()[0]!.env?.GH_CONFIG_DIR, bound.directory, 'posted with the session credential');
    // Every refusal: the reason, then this session's invocation with its CLI path, the event and a heredoc ending in the three lines.
    const refusals: [string | undefined, string, RegExp][] = [
      ['MERGE', approval, /--event must be one of APPROVE, REQUEST_CHANGES, COMMENT/],
      ['APPROVE', '   ', /review body is empty/],
      ['APPROVE', 'AC-1 met.', /lacks "Resolved threads:"/],
      ['REQUEST_CHANGES', 'Blocking.\nResolved threads: PRRT_unlisted99', /PRRT_unlisted99/],
    ];
    for (const [event, text, reason] of refusals) {
      const refused = gh([{ mergeable: 'MERGEABLE' }]);
      const error = await postReview({ event, body: text, cliPath: launcher, environment: bound.environment }, { run: refused.run }).then(() => null, error => error);
      assert.ok(error instanceof ReviewPostRefusal); assert.match(error.message, reason);
      assert.equal(refused.calls.length, 0, 'a refused verdict reaches no gh call');
      const example = error.message.slice(error.message.indexOf('Post it like this:\n') + 'Post it like this:\n'.length).split('\n');
      assert.equal(example[0], `node ${launcher} review post --event ${event === 'MERGE' ? 'APPROVE' : event} <<'EOF'`);
      assert.deepEqual(example.slice(-4), ['Resolved threads: none', 'Follow-up threads: PRRT_listed0001', 'Overridden threads: none', 'EOF']);
      assert.ok(error.message.indexOf('Review not posted:') < error.message.indexOf('Post it like this'), 'the reason comes first');
    }
  } finally { await bound.cleanup(); }
});

test('unit:reviewer-harness-review-post — the reviewer may post only through review post, a raw review call is denied, and nothing else changes', async () => {
  const input = { kind: 'claude', cliPath: launcher, repository: 'owner/project', baseBranch: 'main', credentialHome: '/creds', credentialDirectories: ['/creds/masters'] };
  const reviewer = sessionHarnessPlan({ ...input, role: 'reviewer', pr: 42, checkout: '/managed/review/checkout' });
  assert.deepEqual(reviewer.allow.map(entry => entry.rule), ['Bash(gh pr diff:*)', 'Bash(gh pr view:*)', `Bash(node ${launcher} review post:*)`, 'Bash(git fetch:*)', 'Bash(git worktree add --detach /managed/review/checkout:*)']);
  assert.ok(reviewer.deny.some(entry => entry.rule === 'Bash(gh api *pulls/*/reviews*)'));
  assert.equal(harnessDecision(reviewer, `node ${launcher} review post --event APPROVE --body judged`).decision, 'allow');
  for (const command of [`gh api --method POST repos/owner/project/pulls/42/reviews -f commit_id=${H} -f event=APPROVE -f body=x`, 'gh api repos/owner/project/pulls/42/reviews']) assert.equal(harnessDecision(reviewer, command).decision, 'deny', command);
  const others = reviewer.deny.filter(entry => entry.rule !== 'Bash(gh api *pulls/*/reviews*)').map(entry => entry.rule);
  for (const rule of [`Bash(node ${launcher} evidence:*)`, 'Edit(./**)', 'Write(./**)', 'Bash(git push:*)', 'Bash(gh pr merge:*)', 'Read(//creds/masters/**)']) assert.ok(others.includes(rule), rule);
  // Worker and producer plans carry no review post, and still deny every review call.
  for (const plan of [sessionHarnessPlan({ ...input, role: 'worker', branch: 'graphyard/gy-42-1' }), sessionHarnessPlan({ ...input, role: 'producer' })]) {
    assert.equal(plan.allow.some(entry => entry.rule.includes('review post')), false);
    assert.equal(harnessDecision(plan, `gh api --method POST repos/owner/project/pulls/42/reviews -f event=APPROVE`).decision, 'deny');
  }
  // The minted reviewer token asks for the same permissions as before.
  let requested: any;
  const credential = { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, repository: 'owner/project' } as any;
  await mintReviewerToken(credential, 'owner/project', (async (_url: string, init: RequestInit) => { requested = JSON.parse(String(init.body)); return new Response(JSON.stringify({ token: 'x'.repeat(30), expires_at: new Date(Date.now() + 3_000_000).toISOString(), permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } })); }) as unknown as typeof fetch);
  assert.deepEqual(requested, { repositories: ['project'], permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } });
});

test('unit:reviewer-prompt-review-post — the launch and retry prompts post only through review post and carry no polling, head-guard or raw posting prose', () => {
  const binding = { key: 'GY-42', pr: 42, sha: H, baseSha: B, policyRevision: 2 };
  const prompt = reviewPrompt({ repository: 'owner/project', cliPath: launcher }, binding, undefined, undefined, [{ id: 'AC-1', text: 'Works' }]);
  const retry = reviewRetryPrompt('owner/project', { ...binding }, [{ id: 'AC-1', text: 'Works' }], launcher);
  for (const text of [prompt, retry]) {
    assert.ok(text.includes(`node ${launcher} review post --event APPROVE <<'EOF'`), 'posts through review post');
    assert.match(text, /Never post a review any other way/);
    for (const banned of [/gh api --method POST/, /commit_id=/, /mergeable/, /every 5 seconds/, /headRefOid/, /head commit other than/]) assert.doesNotMatch(text, banned);
    // The thread-line forms stay in the criteria rule.
    for (const form of ['"Resolved threads: ID1 ID2"', '"Follow-up threads: ID3 ID4"', '"Overridden threads: ID5 ID6"']) assert.ok(text.includes(form), form);
  }
  assert.match(retry, /^You stopped before posting the verdict for GY-42/);
});
