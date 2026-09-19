import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { execFile as execFileCallback, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { appManifest, reviewerAppManifest } from '../src/github-setup.js';
import { buildMasterStatus, dispatchWork, loadMasterConfig, masterHarness, reviewerProfileSchema, setupMaster, workerProfileSchema } from '../src/master.js';
import { launchPlan, masterHarnessPlan, nonInteractiveLaunch, writeHarnessPermissions } from '../src/harness.js';
import { applyProtection, protectionPlan, requiredReviewProtection } from '../src/protection.js';
import { assertReviewCandidate, bindReviewer, launchReview, mintReviewerToken, observeReviewVerdict, readReviewLedger, reconcileReviews, reviewPrompt, saveReviewerProfile, summarizeReviews } from '../src/reviewer.js';
import { nativeReviewRequired, type Work } from '../src/model.js';

const execFile = promisify(execFileCallback);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-reviewer-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  return root;
}
async function master() {
  const root = await repository(), credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-reviewer-credentials-'));
  await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory, herdrWorkspace: 'workspace-graphyard' }, coordinatorStatus as typeof fetch);
  return { root, credentialDirectory, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); } };
}
const installed = async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } });
async function boundMaster() {
  const context = await master();
  await bindReviewer(context.root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(context.credentialDirectory, 'reviewers') }, installed);
  return context;
}
function work(overrides: Partial<Work> = {}) {
  const candidate = { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' };
  return { id: 'work-id', key: 'GY-42', title: 'Prove the reviewer flow', description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:reviewer'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage: 'review', revision: 9, policyRevision: 2, createdAt: '', updatedAt: '', stageEnteredAt: '', ready: true, epoch: 1, lease: null, workspaces: [],
    candidate, submission: { epoch: 1, pr: 42 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [],
    observation: { at: new Date().toISOString(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: [], scopeFiles: [], prState: 'open', draft: false },
    ...overrides } as unknown as Work;
}

test('the reviewer App is a separate identity that cannot write code, checks, or administration', async () => {
  const manifest = reviewerAppManifest('reviewer', 'owner/project', 'https://graphyard.example', 'http://127.0.0.1:4312');
  const permissions = manifest.default_permissions as Record<string, string>;
  // The criterion is about what a reviewer identity must never hold, not about the exact
  // read permissions the manifest flow grants it.
  assert.equal(permissions.contents, 'read');
  assert.equal(permissions.pull_requests, 'write');
  assert.equal(permissions.checks, undefined);
  assert.equal(permissions.administration, undefined);
  assert.equal(permissions.workflows, undefined);
  assert.equal(manifest.public, false);
  // A reviewer App is never the control-plane App: different name, and no gate-check authority.
  const control = appManifest('owner/project', 'https://graphyard.example', 'http://127.0.0.1:4311');
  assert.notEqual(manifest.name, control.name);
  assert.equal((control.default_permissions as Record<string, string>).checks, 'write');
  assert.ok(manifest.name.length <= 34);
  assert.throws(() => reviewerAppManifest('reviewer', 'owner/project', 'http://graphyard.example', 'http://127.0.0.1:4312'));
  assert.throws(() => reviewerAppManifest('Reviewer', 'owner/project', 'https://graphyard.example', 'http://127.0.0.1:4312'), /lowercase identifier/);
});

test('reviewer binding refuses the control-plane App and stores its key privately outside the repository', async () => {
  const { root, credentialDirectory, cleanup } = await master();
  try {
    const reviewers = join(credentialDirectory, 'reviewers');
    await assert.rejects(bindReviewer(root, { appId: 1234, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: reviewers }, installed), /different GitHub App/);
    await assert.rejects(bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey: 'not-a-key'.padEnd(80, '-'), credentialDirectory: reviewers }, installed), /PEM GitHub issued/);
    await assert.rejects(bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: reviewers }, async () => ({ repository: 'owner/other', permissions: {} })), /does not cover the managed repository/);
    await assert.rejects(bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: reviewers }, async () => ({ repository: 'owner/project', permissions: { contents: 'write' } })), /must not/);
    await assert.rejects(bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(root, 'inside') }, installed), /outside the managed repository/);
    const result = await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: reviewers }, installed);
    assert.equal(result.identity, 'graphyard-reviewer[bot]'); assert.notEqual(result.reviewer.appId, result.controlPlaneAppId);
    const config = await loadMasterConfig(root);
    assert.equal(config.reviewer!.appId, 5678); assert.equal(config.reviewer!.installationId, 91011); assert.equal(config.reviewer!.slug, 'graphyard-reviewer');
    assert.equal(config.reviewer!.credentialFile.startsWith(`${root}/`), false, 'reviewer credentials never live inside the repository');
    assert.equal((await stat(config.reviewer!.credentialFile)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(config.reviewer!.credentialFile, 'utf8')).privateKey, privateKey);
    assert.equal((await readFile(join(root, '.graphyard/master.json'), 'utf8')).includes('PRIVATE KEY'), false, 'the key stays out of master configuration');
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory }, coordinatorStatus as typeof fetch);
    assert.equal((await loadMasterConfig(root)).reviewer!.appId, 5678, 'rerunning master init keeps the bound reviewer identity');
  } finally { await cleanup(); }
});

test('a reviewer token is repository-scoped, short-lived, and unable to write code', async () => {
  const credential = { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', repository: 'owner/project', privateKey };
  const requests: any[] = [];
  const respond = (body: any) => (async (url: any, init: any) => { requests.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify(body)); }) as unknown as typeof fetch;
  const hour = new Date(Date.now() + 3_500_000).toISOString();
  const minted = await mintReviewerToken(credential, 'owner/project', respond({ token: 'ghs_reviewer_token_value', expires_at: hour, permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
  assert.equal(minted.token, 'ghs_reviewer_token_value');
  assert.deepEqual(requests[0].body, { repositories: ['project'], permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } });
  assert.match(String(requests[0].url), /\/app\/installations\/91011\/access_tokens$/);
  await assert.rejects(mintReviewerToken(credential, 'owner/other', respond({ token: 'x'.repeat(30), expires_at: hour, permissions: {} })), /another repository/);
  await assert.rejects(mintReviewerToken(credential, 'owner/project', respond({ token: 'x'.repeat(30), expires_at: new Date(Date.now() + 86_400_000).toISOString(), permissions: { pull_requests: 'write' } })), /short expiry/);
  await assert.rejects(mintReviewerToken(credential, 'owner/project', respond({ token: 'x'.repeat(30), expires_at: hour, permissions: { contents: 'write', pull_requests: 'write' } })), /write code/);
  await assert.rejects(mintReviewerToken(credential, 'owner/project', respond({ token: 'x'.repeat(30), expires_at: hour, permissions: { checks: 'write', pull_requests: 'write' } })), /write code/);
  await assert.rejects(mintReviewerToken(credential, 'owner/project', respond({ token: 'x'.repeat(30), expires_at: hour, permissions: { pull_requests: 'read' } })), /cannot post a review/);
  await assert.rejects(mintReviewerToken(credential, 'owner/project', (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch), /could not mint/);
});

test('a reviewer launch is bound to the exact observed candidate and its prompt is read-only', () => {
  const now = new Date(Date.now() + 1_000).toISOString();
  const binding = assertReviewCandidate(work(), now);
  assert.deepEqual(binding, { key: 'GY-42', pr: 42, sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyRevision: 2, author: 'worker', branch: 'graphyard/gy-42-1' });
  assert.throws(() => assertReviewCandidate(work({ policy: { checks: ['test'], review: false } as any }), now), /does not require independent review/);
  assert.throws(() => assertReviewCandidate(work({ policy: { checks: ['test'], review: true, reviewProvider: 'codex' } as any }), now), /codex review provider/);
  assert.throws(() => assertReviewCandidate(work({ candidate: null, submission: null }), now), /no independently observed pull-request candidate/);
  assert.throws(() => assertReviewCandidate(work({ reworkRequested: true }), now), /awaiting rework/);
  assert.throws(() => assertReviewCandidate(work({ observation: { ...work().observation!, candidate: { ...work().candidate!, sha: 'c'.repeat(40) } } }), now), /does not match the current candidate/);
  assert.throws(() => assertReviewCandidate(work({ observation: { ...work().observation!, at: new Date(Date.now() - 300_000).toISOString() } }), now), /older than two minutes/);
  assert.throws(() => assertReviewCandidate(work({ observation: { ...work().observation!, draft: true } }), now), /still a draft/);
  assert.throws(() => assertReviewCandidate(work({ observation: { ...work().observation!, prState: 'closed' } }), now), /is closed/);
  assert.throws(() => assertReviewCandidate(work(), 'not-a-time'), /valid Graphyard snapshot clock/);
  const prompt = reviewPrompt({ repository: 'owner/project' } as any, binding);
  for (const fragment of ['owner/project', '#42', 'a'.repeat(40), 'b'.repeat(40), 'policy revision 2', 'read-only', `commit_id=${'a'.repeat(40)}`, 'REQUEST_CHANGES']) assert.ok(prompt.includes(fragment), `prompt must state ${fragment}`);
  assert.match(prompt, /do not edit, stage, commit, push, rebase, or merge/);
  assert.match(prompt, /never weaken a requirement/);
});

test('master review mints a private session credential, records the request, and closes on the verdict', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await saveReviewerProfile(root, { name: 'reviewer-claude', agentName: 'review-claude-1', kind: 'claude' });
    const config = await loadMasterConfig(root);
    const calls: string[][] = [];
    const run = (_command: string, args: string[]) => { calls.push(args); return JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'pane-review', tab_id: 'tab-review' }, tab: { tab_id: 'tab-review' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} }); };
    const mint = async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() });
    const launched = await launchReview(root, work(), 'reviewer-claude', [], new Date().toISOString(), { run, mint });
    assert.equal(launched.work, 'GY-42'); assert.equal(launched.sha, 'a'.repeat(40)); assert.equal(launched.reviewer, 'graphyard-reviewer[bot]'); assert.equal(launched.pane, 'pane-review');
    const tab = calls[0];
    assert.equal(JSON.stringify(calls).includes('ghs_review_session_token'), false, 'the minted token never reaches a command line');
    const sessionDirectory = tab[tab.indexOf(tab.find(value => value.startsWith('GH_CONFIG_DIR='))!)].slice('GH_CONFIG_DIR='.length);
    assert.equal((await stat(join(sessionDirectory, 'hosts.yml'))).mode & 0o777, 0o600);
    assert.match(await readFile(join(sessionDirectory, 'hosts.yml'), 'utf8'), /oauth_token: ghs_review_session_token/);
    assert.equal(sessionDirectory.startsWith(`${root}/`), false, 'session credentials never live inside the repository');
    assert.deepEqual(calls[1].slice(0, 6), ['agent', 'start', 'review-claude-1', '--kind', 'claude', '--pane']);
    assert.deepEqual(calls[1].slice(-3), ['--', '--permission-mode', 'bypassPermissions']);
    assert.deepEqual(calls[2].slice(0, 3), ['agent', 'prompt', 'review-claude-1']);
    assert.match(calls[2][3], /pull request #42 at head a{40} against base b{40}/);
    const ledger = await readReviewLedger(root);
    assert.equal(ledger.reviews.length, 1); assert.equal(ledger.reviews[0].state, 'pending'); assert.equal(ledger.reviews[0].policyRevision, 2);
    assert.equal((await stat(join(root, '.graphyard/reviews.json'))).mode & 0o777, 0o600);
    await assert.rejects(launchReview(root, work(), 'reviewer-claude', [], new Date().toISOString(), { run, mint }), /already pending/);
    await assert.rejects(launchReview(root, work(), 'unknown', [], new Date().toISOString(), { run, mint }), /Unknown reviewer profile/);

    const stale = summarizeReviews((await reconcileReviews(root, config, { run, observe: () => null })).reviews);
    assert.equal(stale.pending.length, 1); assert.equal(stale.completed.length, 0);
    const other = await reconcileReviews(root, config, { run, observe: () => null });
    assert.equal(other.reviews[0].state, 'pending');
    const closeCalls: string[][] = [];
    const closeRun = (_command: string, args: string[]) => { closeCalls.push(args); return JSON.stringify({ result: args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} }); };
    const settled = await reconcileReviews(root, config, { run: closeRun, observe: () => ({ state: 'APPROVED', reviewer: 'graphyard-reviewer[bot]', reviewId: 77, submittedAt: new Date().toISOString() }) });
    assert.equal(settled.reviews[0].state, 'completed'); assert.equal(settled.reviews[0].verdict!.state, 'APPROVED');
    assert.deepEqual(closeCalls[0], ['pane', 'close', 'pane-review']);
    await assert.rejects(stat(sessionDirectory), /ENOENT/, 'the reviewer credential directory is removed once the session is closed');
    const summary = summarizeReviews((await readReviewLedger(root)).reviews);
    assert.equal(summary.pending.length, 0); assert.equal(summary.completed[0].verdict, 'APPROVED');
    const status = buildMasterStatus({ work: [], now: new Date().toISOString() }, [], [], {}, {}, summary);
    assert.equal(status.counts.reviewsPending, 0); assert.equal(status.reviews.completed[0].work, 'GY-42');
  } finally { await cleanup(); }
});

test('a reviewer launch leaves no credential or record behind when Herdr refuses', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    await saveReviewerProfile(root, { name: 'reviewer-cursor', agentName: 'review-cursor-1', kind: 'cursor' });
    const config = await loadMasterConfig(root);
    const calls: string[][] = [];
    const run = (_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'agent' && args[1] === 'prompt') throw new Error('prompt refused');
      return JSON.stringify({ result: args[0] === 'tab' ? { pane_id: 'pane-failed' } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
    };
    await assert.rejects(launchReview(root, work(), 'reviewer-cursor', [], new Date().toISOString(), { run, mint: async () => ({ token: 'ghs_failed_session', expiresAt: new Date(Date.now() + 3_500_000).toISOString() }) }), /prompt refused/);
    assert.deepEqual(calls.at(-2), ['pane', 'close', 'pane-failed']);
    assert.deepEqual((await readReviewLedger(root)).reviews, [], 'a failed launch records no review request');
    assert.deepEqual(await readdir(join(config.reviewer!.credentialFile, '..', 'sessions')), [], 'the session credential directory is removed');
    await assert.rejects(launchReview(root, work(), 'reviewer-cursor', [{ name: 'review-cursor-1' }], new Date().toISOString(), { run, mint: async () => ({ token: 'x', expiresAt: new Date().toISOString() }) }), /already visible in Herdr/);
    await assert.rejects(launchReview(root, work({ policy: { checks: ['test'], review: true, reviewProvider: 'codex' } as any }), 'reviewer-cursor', [], new Date().toISOString(), { run }), /codex review provider/);
  } finally { await cleanup(); }
});

test('only the reviewer identity, on the exact head, settles a pending review', () => {
  const record = { id: '1', key: 'GY-42', pr: 42, sha: 'a'.repeat(40) } as any;
  const reviews = (values: any[]) => (_command: string, _args: string[]) => JSON.stringify(values);
  assert.equal(observeReviewVerdict('owner/project', record, 'graphyard-reviewer[bot]', reviews([{ id: 1, state: 'APPROVED', commit_id: 'c'.repeat(40), user: { login: 'graphyard-reviewer[bot]' } }])), null);
  assert.equal(observeReviewVerdict('owner/project', record, 'graphyard-reviewer[bot]', reviews([{ id: 2, state: 'APPROVED', commit_id: 'a'.repeat(40), user: { login: 'worker' } }])), null);
  assert.equal(observeReviewVerdict('owner/project', record, 'graphyard-reviewer[bot]', reviews([{ id: 3, state: 'COMMENTED', commit_id: 'a'.repeat(40), user: { login: 'graphyard-reviewer[bot]' } }])), null);
  const verdict = observeReviewVerdict('owner/project', record, 'graphyard-reviewer[bot]', reviews([{ id: 4, state: 'CHANGES_REQUESTED', commit_id: 'a'.repeat(40), user: { login: 'Graphyard-Reviewer[bot]' }, submitted_at: '2026-09-18T00:00:00Z' }]));
  assert.deepEqual(verdict, { state: 'CHANGES_REQUESTED', reviewer: 'graphyard-reviewer[bot]', reviewId: 4, submittedAt: '2026-09-18T00:00:00Z' });
  assert.throws(() => observeReviewVerdict('owner/project', record, 'graphyard-reviewer[bot]', () => '{}'), /did not return a review list/);
});

test('launched profiles carry each runtime non-interactive contract and honour a per-profile opt-out', () => {
  assert.deepEqual(launchPlan('claude', 'auto').args, ['--permission-mode', 'bypassPermissions']);
  assert.deepEqual(launchPlan('codex', 'auto').args, ['--ask-for-approval', 'never', '--sandbox', 'workspace-write']);
  assert.deepEqual(launchPlan('cursor', 'auto').args, ['--force', '--trust']);
  assert.deepEqual(launchPlan('opencode', 'auto').args, []);
  assert.equal(launchPlan('opencode', 'auto').environment.OPENCODE_PERMISSION, '{"edit":"allow","bash":"allow","webfetch":"allow"}');
  for (const kind of ['claude', 'codex', 'cursor', 'opencode']) {
    const plan = launchPlan(kind, 'auto');
    assert.equal(plan.applied, true); assert.ok(plan.tradeoff && plan.prompts, `${kind} must state what it stops asking and what that costs`);
    assert.equal(workerProfileSchema.shape.kind.safeParse(kind).success, true);
  }
  const optOut = launchPlan('cursor', 'prompt', ['--model', 'reviewer']);
  assert.deepEqual(optOut.args, ['--model', 'reviewer']); assert.equal(optOut.applied, false); assert.match(optOut.reason!, /opted out/);
  assert.ok(optOut.tradeoff, 'the opt-out still states the trade-off it avoids');
  const configured = launchPlan('codex', 'auto', ['--ask-for-approval', 'on-request']);
  assert.deepEqual(configured.args, ['--ask-for-approval', 'on-request']); assert.match(configured.reason!, /already configures/);
  const presetEnvironment = launchPlan('opencode', 'auto', [], { OPENCODE_PERMISSION: '{"edit":"ask"}' });
  assert.deepEqual(presetEnvironment.environment, {}); assert.match(presetEnvironment.reason!, /already configures/);
  assert.match(launchPlan('gemini', 'auto').reason!, /no non-interactive launch contract/);
  assert.equal(Object.keys(nonInteractiveLaunch).every(kind => workerProfileSchema.shape.kind.safeParse(kind).success), true);
});

test('profiles added by setup report the launch contract they will start with', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    const reviewer = await saveReviewerProfile(root, { name: 'reviewer-codex', agentName: 'review-codex-1', kind: 'codex' });
    assert.deepEqual(reviewer.launch.args, ['--ask-for-approval', 'never', '--sandbox', 'workspace-write']);
    assert.equal((await loadMasterConfig(root)).reviewers[0].approvals, 'auto');
    await assert.rejects(saveReviewerProfile(root, { name: 'reviewer-codex', agentName: 'other', kind: 'codex' }), /must be unique/);
    await assert.rejects(saveReviewerProfile(root, { name: 'reviewer-two', agentName: 'review-codex-1', kind: 'codex' }), /must be unique/);
    const optOut = await saveReviewerProfile(root, { name: 'reviewer-manual', agentName: 'review-manual-1', kind: 'cursor', approvals: 'prompt' });
    assert.deepEqual(optOut.launch.args, []); assert.equal(optOut.launch.applied, false);
    assert.equal(reviewerProfileSchema.safeParse({ name: 'r', agentName: 'a', kind: 'claude', environment: { GH_TOKEN: 'secret' } }).success, false);
    assert.equal(reviewerProfileSchema.safeParse({ name: 'r', agentName: 'a', kind: 'claude', principal: 'worker-a' }).success, false);
  } finally { await cleanup(); }
});

test('dispatch starts a supervised worker with its runtime approval contract, or without it when opted out', async () => {
  const { root, credentialDirectory, cleanup } = await master();
  try {
    const credential = join(credentialDirectory, 'worker.token');
    await writeFile(credential, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const profile = { name: 'cursor-primary', principal: 'worker-a', agentName: 'eng-cursor-1', mode: 'launch' as const, kind: 'cursor' as const, credentialFile: credential, agentArgs: [], approvals: 'auto' as const, environment: {} };
    const calls: string[][] = [];
    const run = (_command: string, args: string[]) => { calls.push(args); return JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'p1', tab_id: 't1' }, tab: { tab_id: 't1' } } : args[1] === 'get' ? { type: 'agent_info', agent: { pane_id: 'p1', agent_status: 'idle' } } : {} });
    };
    const ready = () => work({ stage: 'ready', lease: null, submission: null, candidate: null, observation: null });
    const dispatched = await dispatchWork(root, ready(), profile, [], run, [ready()], async () => ({ epoch: 4, path: join(root, 'assigned'), base: 'c'.repeat(40) }));
    assert.equal(dispatched.launch.applied, true);
    assert.match(calls[1][3], /'--' 'cursor' '--force' '--trust'$/, 'the supervised command carries the runtime non-interactive flags');
    const optOutCalls: string[][] = [];
    await dispatchWork(root, ready(), { ...profile, approvals: 'prompt', agentName: 'eng-cursor-2' }, [], (_command, args) => { optOutCalls.push(args); return run(_command, args); }, [ready()], async () => ({ epoch: 5, path: join(root, 'assigned-2'), base: 'd'.repeat(40) }));
    assert.match(optOutCalls[1][3], /'--' 'cursor'$/, 'an opted-out profile starts exactly as the operator configured it');
    const opencodeCalls: string[][] = [];
    await dispatchWork(root, ready(), { ...profile, kind: 'opencode', agentName: 'eng-opencode-1' }, [], (_command, args) => { opencodeCalls.push(args); return run(_command, args); }, [ready()], async () => ({ epoch: 6, path: join(root, 'assigned-3'), base: 'e'.repeat(40) }));
    assert.ok(opencodeCalls[0].some(value => value.startsWith('OPENCODE_PERMISSION=')), 'runtimes configured by environment get their contract in the tab environment');
  } finally { await cleanup(); }
});

test('the example reviewer profiles ship valid, launchable configuration', async () => {
  const directory = new URL('../examples/master/', import.meta.url);
  const names = (await readdir(directory)).filter(name => name.endsWith('.json'));
  const reviewers = names.filter(name => name.includes('reviewer'));
  assert.ok(reviewers.length >= 1, 'examples/master must ship at least one reviewer profile');
  for (const name of reviewers) {
    const profile = reviewerProfileSchema.parse(JSON.parse(await readFile(new URL(name, directory), 'utf8')));
    assert.equal(JSON.stringify(profile).includes('credentialFile'), false, 'a reviewer profile holds no Graphyard credential');
    assert.ok(['auto', 'prompt'].includes(profile.approvals));
  }
  for (const name of names.filter(entry => !entry.includes('reviewer') && !entry.includes('producer'))) {
    const profile = workerProfileSchema.parse(JSON.parse(await readFile(new URL(name, directory), 'utf8')));
    if (profile.mode === 'launch') assert.equal(profile.approvals, 'auto');
  }
});

test('master harness rules cover the master loop and grant no merge path or credential read', async () => {
  const { root, cleanup } = await boundMaster();
  try {
    const config = await loadMasterConfig(root);
    const plan = masterHarness(root, config, 'claude');
    assert.equal(plan.file, '.claude/settings.local.json');
    assert.ok(plan.allow.every(entry => entry.why.length > 20), 'every generated rule explains itself');
    assert.ok(plan.deny.every(entry => entry.why.length > 20));
    const allow = plan.allow.map(entry => entry.rule);
    assert.ok(allow.includes(`Bash(node ${config.cliPath} master:*)`), 'the master can run its own commands, including review');
    assert.ok(allow.includes('Bash(herdr:*)') && allow.includes('Bash(jq:*)'));
    assert.ok(allow.some(rule => rule.includes('resolve-thread.mjs')), 'audited review threads can be resolved');
    assert.ok(allow.some(rule => rule.startsWith('Write(./.graphyard/profiles/')), 'the master can edit its own profiles');
    assert.ok(allow.some(rule => rule === `Bash(node ${config.cliPath} status:*)`), 'status is readable without an operator');
    // gh api is allowed only for the protection and installation reads and subresource writes the
    // master's administration needs; merges, verdicts, and token minting stay denied by pattern.
    for (const rule of allow) assert.doesNotMatch(rule, /merge|access_tokens|reviews|graphql|\.pem|\.token|credential/i, `allow rule ${rule} must not reach a merge, a verdict, or a credential`);
    for (const rule of allow.filter(entry => entry.includes('gh api'))) assert.match(rule, /^Bash\(gh api (user|user\/installations\*|apps\/\*|repos\/owner\/project\/branches\/main\/protection\*|--method PATCH repos\/owner\/project\/branches\/main\/protection\/\*)\)$/, `gh api rule ${rule} must name one administration endpoint`);
    assert.ok(!allow.some(rule => rule.includes('agent-browser')), 'the operator browser profile is driven only through master browser');
    const deny = plan.deny.map(entry => entry.rule);
    for (const rule of ['Bash(gh pr merge:*)', 'Bash(gh pr review:*)', 'Bash(gh api *merge*)', 'Bash(gh api *access_tokens*)', 'Bash(gh api graphql*)', 'Bash(gh api *PUT*)', 'Bash(gh api *DELETE*)', 'Bash(agent-browser *)', 'Bash(git push:*)', 'Read(**/*.pem)', 'Read(**/*.token)']) assert.ok(deny.includes(rule), `${rule} must be denied`);
    assert.ok(deny.some(rule => rule.startsWith(`Read(//${join(config.credentialFile, '../..')}`)), 'the credential home is denied');

    const preview = await writeHarnessPermissions(root, plan, false);
    assert.equal(preview.applied, false); assert.equal(preview.added.length, plan.allow.length + plan.deny.length);
    await assert.rejects(stat(join(root, '.claude/settings.local.json')), /ENOENT/, 'a preview writes nothing');
    execFileSync('git', ['init', '-q', root]);
    await writeHarnessPermissions(root, plan, true);
    const settings = JSON.parse(await readFile(join(root, '.claude/settings.local.json'), 'utf8'));
    assert.deepEqual(settings.permissions.allow, plan.allow.map(entry => entry.rule));
    assert.equal((await stat(join(root, '.claude/settings.local.json'))).mode & 0o777, 0o600);
    assert.equal(execFileSync('git', ['check-ignore', '.claude/settings.local.json'], { cwd: root, encoding: 'utf8' }).trim(), '.claude/settings.local.json');
    await writeFile(join(root, '.claude/settings.local.json'), JSON.stringify({ model: 'operator-choice', permissions: { allow: ['Bash(make:*)', ...plan.allow.map(entry => entry.rule)], deny: plan.deny.map(entry => entry.rule) } }), { mode: 0o600 });
    const second = await writeHarnessPermissions(root, plan, true);
    assert.deepEqual(second.added, [], 'regeneration is idempotent');
    const merged = JSON.parse(await readFile(join(root, '.claude/settings.local.json'), 'utf8'));
    assert.equal(merged.model, 'operator-choice'); assert.ok(merged.permissions.allow.includes('Bash(make:*)'), 'operator rules are never removed');
    const codex = masterHarness(root, config, 'codex');
    assert.equal(codex.file, null); assert.match(codex.manual!, /trust_level = "trusted"/);
    assert.equal((await writeHarnessPermissions(root, codex, true)).applied, false);
    assert.match(masterHarness(root, config, 'cursor').note, /no generated rules/);
    await assert.rejects(writeHarnessPermissions(root, { ...plan, file: '../escape.json' }, true), /inside the managed repository/);
  } finally { await cleanup(); }
});

test('branch protection reconciles to the review policy of every open item and refuses a mix', () => {
  const config = { repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 };
  const native = work(), agent = work({ id: 'agent', key: 'GY-43', policy: { checks: ['test'], review: true, reviewProvider: 'agent' } as any });
  const codex = work({ id: 'codex', key: 'GY-45', policy: { checks: ['test'], review: true, reviewProvider: 'codex' } as any });
  const current = (reviews: any) => ({ required_pull_request_reviews: reviews, required_status_checks: { strict: false, checks: [{ context: 'Graphyard / merge', app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } });
  assert.equal(requiredReviewProtection([native]).protection.requiredApprovals, 1);
  // Every provider nativeReviewRequired rejects lands on the zero-approval side, so the model and the branch never disagree.
  for (const item of [agent, codex]) {
    assert.equal(nativeReviewRequired(item.policy), false);
    assert.equal(requiredReviewProtection([item]).protection.mode, 'agent');
    assert.equal(requiredReviewProtection([item]).protection.requiredApprovals, 0);
  }
  const gated = requiredReviewProtection([agent, codex]);
  assert.equal(gated.protection.requiredApprovals, 0, 'agent and codex items agree with each other');
  assert.deepEqual(gated.items, { github: [], codex: ['GY-45'], agent: ['GY-43'] });
  assert.equal(requiredReviewProtection([native, work({ id: 'done', key: 'GY-9', stage: 'done', policy: { checks: ['test'], review: true, reviewProvider: 'agent' } as any })]).protection.mode, 'native');
  assert.equal(requiredReviewProtection([native, work({ id: 'unreviewed', key: 'GY-10', policy: { checks: ['test'], review: false, reviewProvider: 'agent' } as any })]).protection.mode, 'native');
  for (const other of [agent, codex]) {
    assert.throws(() => requiredReviewProtection([native, other]), new RegExp(`GY-42.*${other.key}|${other.key}.*GY-42`, 's'));
    assert.throws(() => requiredReviewProtection([native, other]), /one review provider/);
    assert.throws(() => requiredReviewProtection([other, native]), /GY-42 require a native GitHub approval/);
  }
  assert.throws(() => requiredReviewProtection([native, agent]), /GY-43 \(agent\) require the native approval count to be zero/);
  const switching = protectionPlan(current({ required_approving_review_count: 1, require_last_push_approval: true, dismiss_stale_reviews: true }), config, [agent]);
  assert.equal(switching.mode, 'agent'); assert.equal(switching.consistent, false); assert.deepEqual(switching.items.agent, ['GY-43']); assert.deepEqual(switching.items.github, []);
  assert.ok(switching.changes.some(change => change.startsWith('required_approving_review_count 1 to 0')));
  assert.ok(switching.changes.some(change => change.startsWith('require_last_push_approval true to false')));
  assert.equal(protectionPlan(current({ required_approving_review_count: 0, require_last_push_approval: false, dismiss_stale_reviews: true }), config, [agent]).consistent, true, 'an agent-review branch at zero approvals is left alone');
  assert.equal(protectionPlan(current({ required_approving_review_count: 1, require_last_push_approval: true, dismiss_stale_reviews: true }), config, [native]).consistent, true);
  assert.throws(() => protectionPlan(current({ required_approving_review_count: 1, require_last_push_approval: true, dismiss_stale_reviews: true }), config, [native, agent]), /one review provider/);
  const unprotected = protectionPlan({ required_status_checks: { strict: true, checks: [] }, enforce_admins: { enabled: false } }, config, [native]);
  assert.equal(unprotected.blockers.length, 3); assert.match(unprotected.refusal!, /merge queue requires it off/); assert.match(unprotected.refusal!, /Graphyard \/ merge/);
  assert.match(protectionPlan(current({ required_approving_review_count: 1, require_code_owner_reviews: true, require_last_push_approval: true, dismiss_stale_reviews: true }), config, [native]).refusal!, /CODEOWNERS/);
  assert.equal(protectionPlan(current({ required_approving_review_count: 1, require_last_push_approval: true, dismiss_stale_reviews: true }), { ...config, githubAppId: 4321 }, [native]).blockers.length, 1);
});

test('applying protection changes only the review subresource and verifies the result', async () => {
  const config = { repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 };
  const agent = work({ policy: { checks: ['test'], review: true, reviewProvider: 'agent' } as any });
  const codex = work({ id: 'codex', key: 'GY-45', policy: { checks: ['test'], review: true, reviewProvider: 'codex' } as any });
  let reviews = { required_approving_review_count: 1, require_last_push_approval: true, dismiss_stale_reviews: true };
  const calls: { args: string[]; input?: string }[] = [];
  const run = (_command: string, args: string[], input?: string) => {
    calls.push({ args, input });
    if (args.includes('PATCH')) { reviews = { ...reviews, ...JSON.parse(input!) }; return '{}'; }
    return JSON.stringify({ required_pull_request_reviews: reviews, required_status_checks: { strict: false, checks: [{ context: 'Graphyard / merge', app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } });
  };
  const applied = await applyProtection(config, [agent], run);
  assert.equal(applied.applied, true); assert.equal(applied.consistent, true); assert.equal(reviews.required_approving_review_count, 0);
  const patch = calls.find(call => call.args.includes('PATCH'))!;
  assert.match(patch.args[3], /protection\/required_pull_request_reviews$/, 'only the review subresource is patched');
  assert.equal(JSON.parse(patch.input!).required_approving_review_count, 0);
  assert.equal((await applyProtection(config, [agent], run)).applied, false, 'a matching branch is left alone');
  assert.equal((await applyProtection(config, [agent, codex], run)).applied, false, 'codex items share the agent-review protection');
  await assert.rejects(applyProtection(config, [agent, work({ id: 'native', key: 'GY-44' })], run), /one review provider/);
  await assert.rejects(applyProtection(config, [codex, work({ id: 'native', key: 'GY-44' })], run), /one review provider/);
  assert.equal(reviews.required_approving_review_count, 0, 'a refused mix changes nothing');
  const stubborn = (_command: string, args: string[], input?: string) => args.includes('PATCH') ? '{}' : run(_command, args, input);
  await assert.rejects(applyProtection(config, [work({ id: 'native', key: 'GY-44' })], stubborn), /did not report the reconciled protection/);
});

test('the master CLI installs its harness rules and reconciles protection against a live snapshot', async () => {
  const root = await repository(), credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-cli-master-')), binary = join(credentialDirectory, 'bin');
  const item = work({ policy: { checks: ['test'], review: true, reviewProvider: 'agent' } as any });
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/status') return response.end(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
    if (request.url === '/api/work-snapshot') return response.end(JSON.stringify({ work: [item], now: new Date().toISOString() }));
    response.statusCode = 404; response.end('{}');
  });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    await mkdir(binary, { recursive: true });
    const state = join(credentialDirectory, 'protection.json');
    await writeFile(state, JSON.stringify({ required_approving_review_count: 1, require_last_push_approval: true, dismiss_stale_reviews: true }));
    await writeFile(join(binary, 'gh'), `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2), state = ${JSON.stringify(state)};
if (args.includes('PATCH')) { writeFileSync(state, JSON.stringify({ ...JSON.parse(readFileSync(state, 'utf8')), ...JSON.parse(readFileSync(0, 'utf8')) })); console.log('{}'); process.exit(0); }
console.log(JSON.stringify({ required_pull_request_reviews: JSON.parse(readFileSync(state, 'utf8')), required_status_checks: { strict: false, checks: [{ context: 'Graphyard / merge', app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } }));
`, { mode: 0o755 });
    const environment: NodeJS.ProcessEnv = { ...process.env, PATH: `${binary}:${process.env.PATH}`, GRAPHYARD_CONFIG_HOME: credentialDirectory };
    for (const name of Object.keys(environment)) if (name.startsWith('GRAPHYARD_') && name !== 'GRAPHYARD_CONFIG_HOME') delete environment[name];
    const cli = async (args: string[], input?: string) => {
      const child = execFile(process.execPath, [launcher, ...args], { cwd: root, env: environment, encoding: 'utf8' });
      if (input !== undefined) { child.child.stdin!.end(input); } else child.child.stdin!.end();
      return (await child).stdout;
    };
    await cli(['master', 'init', '--url', url, '--token-stdin', '--cli-path', launcher], coordinatorToken);
    const harness = JSON.parse(await cli(['master', 'harness', 'claude', '--apply']));
    assert.equal(harness.applied, true);
    assert.ok(JSON.parse(await readFile(join(root, '.claude/settings.local.json'), 'utf8')).permissions.allow.some((rule: string) => rule.includes('master:*')));
    assert.ok(JSON.parse(await readFile(join(root, '.claude/settings.local.json'), 'utf8')).permissions.allow.includes('Bash(gh api repos/owner/project/branches/main/protection*)'), 'the harness names the managed branch from master configuration');
    const plan = JSON.parse(await cli(['master', 'protection']));
    assert.equal(plan.mode, 'agent'); assert.equal(plan.consistent, false); assert.deepEqual(plan.items.agent, ['GY-42']); assert.equal(plan.apply, false);
    assert.equal(JSON.parse(await readFile(state, 'utf8')).required_approving_review_count, 1, 'a plan changes nothing');
    const applied = JSON.parse(await cli(['master', 'protection', '--apply']));
    assert.equal(applied.applied, true); assert.equal(applied.consistent, true);
    assert.equal(JSON.parse(await readFile(state, 'utf8')).required_approving_review_count, 0);
    const status = JSON.parse(await cli(['master', 'status']));
    assert.equal(status.reviewer, null); assert.deepEqual(status.reviews, { pending: [], completed: [] }); assert.equal(status.counts.reviewsPending, 0);
    await assert.rejects(cli(['master', 'review', 'GY-99']), /Unknown work item|herdr/i);
  } finally {
    await new Promise<void>(accept => server.close(() => accept()));
    await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true });
  }
});

test('the reviewer path is documented end to end in the install runbook and guides', async () => {
  const read = async (name: string) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
  const [masterAgent, github, onboarding, help] = await Promise.all([read('docs/master-agent.md'), read('docs/github.md'), read('docs/onboarding.md'), read('src/cli/master.ts')]);
  for (const command of ['master reviewer setup', 'master reviewer add', 'master review GY-N', 'master protection', 'master harness']) {
    assert.ok(help.includes(command), `${command} must appear in CLI help`);
    assert.ok(masterAgent.includes(command), `docs/master-agent.md must document ${command}`);
  }
  assert.ok(onboarding.includes('master reviewer setup') && onboarding.includes('master review'), 'the install runbook must cover the reviewer path');
  for (const fragment of ['reviewer App', 'control-plane App', 'Pull requests write', 'one hour']) assert.ok(github.includes(fragment), `docs/github.md must describe the reviewer identity: ${fragment}`);
  for (const [name, document] of [['docs/master-agent.md', masterAgent], ['docs/onboarding.md', onboarding]] as const) {
    assert.ok(/examples\/master\/(claude|cursor|opencode)-reviewer\.json/.test(document), `${name} must link a shipped reviewer profile`);
    assert.ok(document.includes('approvals'), `${name} must state the approval mode`);
  }
  for (const fragment of ['trade-off', 'opt out', 'harness', 'App confirmation']) assert.ok(`${masterAgent}${onboarding}`.includes(fragment), `the reviewer path must document ${fragment}`);
  assert.ok(!/paste the reviewer private key into|copy the key by hand/i.test(onboarding), 'the runbook must not add hand-run credential steps');
});
