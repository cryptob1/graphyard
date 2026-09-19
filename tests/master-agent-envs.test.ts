import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountLaunch, agentLaunchPlan, buildMasterStatus, checkAgentEnvironment, deliverPrompt, discoverAgentEnvironments, dispatchWork, herdrErrorCode, inspectProducerCredentials, inspectWorkerCredentials, loadMasterConfig, masterHarness, masterSettingsFromArgs, NoHealthyAccountError, prepareAgentEnvironment, PromptNotAcceptedError, readEnvironmentLog, saveMasterSettings, selectAccount, sessionHarnessFile, setupAgentEnvironments, setupMaster, sharedGitDirectory, startMaster, type EnvironmentProbe } from '../src/master.js';
import { bindReviewer, launchReview, readReviewLedger, saveReviewLedger, saveReviewerProfile } from '../src/reviewer.js';
import { launchProducer, readProducerLedger, saveProducerLedger } from '../src/producer.js';
import { dispatchSummary, readDispatchCursor, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';
import { atomicPrivateWrite } from '../src/master.js';
import type { Work } from '../src/model.js';

// Each test is named for the proof it produces: integration:agent-env-discovery,
// integration:agent-quota-failover, integration:prompt-delivery-confirmed and
// integration:max-autonomy-permissions. The docs check at the end backs manual:agent-env-docs-review.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const installed = async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } });
const hour = 3_600_000, future = (ms = hour) => new Date(Date.now() + ms).toISOString();

// A private directory of agent environments for the whole file, so nothing reads the machine's own.
let environments = '';
const previousRoot = process.env.GRAPHYARD_AGENT_ENVIRONMENTS;
before(async () => { environments = await mkdtemp(join(tmpdir(), 'graphyard-agent-environments-')); process.env.GRAPHYARD_AGENT_ENVIRONMENTS = environments; });
after(async () => { if (previousRoot === undefined) delete process.env.GRAPHYARD_AGENT_ENVIRONMENTS; else process.env.GRAPHYARD_AGENT_ENVIRONMENTS = previousRoot; await rm(environments, { recursive: true, force: true }); });

async function account(directory: string, name: string, login: 'claude' | 'codex' | 'opencode' | 'cursor' | null, token = `${name}-oauth-token`) {
  const home = join(directory, name); await mkdir(home, { recursive: true });
  if (login === 'claude') await writeFile(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `${token}-refresh`, expiresAt: Date.now() + 5 * hour, subscriptionType: 'max' } }), { mode: 0o600 });
  if (login === 'codex') await writeFile(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: token, refresh_token: 'r', id_token: 'i', account_id: 'a' } }), { mode: 0o600 });
  if (login === 'opencode') { await mkdir(join(home, 'opencode'), { recursive: true }); await writeFile(join(home, 'opencode/auth.json'), JSON.stringify({ 'zai-coding-plan': { type: 'api', key: 'k' } }), { mode: 0o600 }); }
  if (login === 'cursor') await writeFile(join(home, 'cli-config.json'), JSON.stringify({ authInfo: { userId: 7, email: 'agent@example.com' } }));
  return home;
}
async function codexUsage(home: string, percent: number, resetsInMs = hour) {
  const day = join(home, 'sessions/2026/09/19'); await mkdir(day, { recursive: true });
  const event = { timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex', primary: { used_percent: percent, window_minutes: 10080, resets_at: Math.floor((Date.now() + resetsInMs) / 1000) }, secondary: null, rate_limit_reached_type: null } } };
  await writeFile(join(day, 'rollout-2026-09-19T08-50-44-session.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: {} })}\n${JSON.stringify(event)}\n`);
}
/** The provider usage endpoint, answering per stored access token. */
function usage(byToken: Record<string, { five: number; seven: number } | number>): EnvironmentProbe & { calls: string[] } {
  const calls: string[] = [];
  const fetcher = (async (url: string, init: any) => {
    const token = String(init.headers.Authorization).replace('Bearer ', ''); calls.push(`${url} ${token}`);
    const entry = byToken[token];
    if (typeof entry === 'number') return new Response('{}', { status: entry });
    if (!entry) return new Response('{}', { status: 401 });
    return new Response(JSON.stringify({ five_hour: { utilization: entry.five, resets_at: future(2 * hour) }, seven_day: { utilization: entry.seven, resets_at: future(48 * hour) } }));
  }) as unknown as typeof fetch;
  return { fetch: fetcher, cacheMs: 0, calls };
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-agent-envs-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  return root;
}
async function master(options: { reviewer?: boolean } = {}) {
  const root = await repository(), credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-agent-envs-credentials-'));
  const setup = await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory, herdrWorkspace: 'workspace-graphyard' }, coordinatorStatus as typeof fetch);
  if (options.reviewer) await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentialDirectory, 'reviewers') }, installed);
  return { root, credentialDirectory, setup, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); } };
}
async function token(directory: string, folder: string, name: string, value: string) {
  await mkdir(join(directory, folder), { recursive: true, mode: 0o700 });
  const file = join(directory, folder, `${name}.token`); await writeFile(file, value.padEnd(40, 'x'), { mode: 0o600 }); return file;
}
async function configure(root: string, change: (config: any) => void) {
  const config = await loadMasterConfig(root); change(config);
  await atomicPrivateWrite(join(root, '.graphyard/master.json'), config);
  return loadMasterConfig(root);
}
function work(overrides: Partial<Work> = {}) {
  const candidate = { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 68, branch: 'graphyard/gy-68-1', author: 'worker' };
  return { id: 'work-68', key: 'GY-68', title: 'Agent environments', description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:agent-env-discovery'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage: 'review', revision: 9, policyRevision: 2, createdAt: '', updatedAt: '', stageEnteredAt: '', ready: true, epoch: 1, lease: null, workspaces: [],
    candidate, submission: { epoch: 1, pr: 68 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [],
    observation: { at: new Date().toISOString(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: [], scopeFiles: [], prState: 'open', draft: false },
    ...overrides } as unknown as Work;
}
const ready = () => work({ stage: 'ready', lease: null, submission: null, candidate: null, observation: null } as any);
const herdr = (calls: string[][], answer: (args: string[]) => unknown = () => ({})) => (_command: string, args: string[]) => {
  calls.push(args);
  const custom = answer(args);
  if (custom !== undefined && custom !== null && typeof custom === 'object' && Object.keys(custom as object).length) return JSON.stringify(custom);
  return JSON.stringify({ result: args[0] === 'tab' && args[1] === 'create' ? { type: 'tab_created', root_pane: { pane_id: 'pane-1', tab_id: 'tab-1' }, tab: { tab_id: 'tab-1' } }
    : args[0] === 'agent' && args[1] === 'get' ? { agent: { pane_id: 'pane-1', agent_status: 'idle' } }
    : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
};
const tabEnvironment = (tab: string[]) => Object.fromEntries(tab.flatMap((value, index) => value === '--env' ? [tab[index + 1].split(/=(.*)/s).slice(0, 2)] : []));
const fast = { attempts: 3, pauseMs: 0, acceptMs: 1_000 };

test('integration:agent-env-discovery — onboarding discovers or creates one environment per agent account, reports which are logged in, and generates worker, reviewer and producer profiles from them', async () => {
  await rm(environments, { recursive: true, force: true }); await mkdir(environments, { recursive: true });
  const claudeA = await account(environments, 'claude-a', 'claude');
  await account(environments, 'claude-b', null);
  const codexHome = await account(environments, 'codex', 'codex');
  await account(environments, 'opencode-a', 'opencode');
  await account(environments, 'cursor-a', 'cursor');
  await mkdir(join(environments, 'notes')); await writeFile(join(environments, 'README.md'), '# not an environment');
  await codexUsage(codexHome, 20);
  const { root, credentialDirectory, setup, cleanup } = await master();
  try {
    // master init already names what it found and which are logged in, without reading quota.
    assert.deepEqual(setup.agentEnvironments.discovered.map(entry => [entry.environment, entry.loggedIn]), [['claude-a', true], ['claude-b', false], ['codex', true], ['cursor-a', true], ['opencode-a', true]]);
    assert.match(setup.agentEnvironments.discovered.find(entry => entry.environment === 'claude-b')!.login!, /CLAUDE_CONFIG_DIR=.*claude-b.* claude, then \/login/);
    assert.match(setup.next, /master environments --apply/);
    assert.deepEqual((await discoverAgentEnvironments(environments)).map(entry => [entry.name, entry.kind]), [['claude-a', 'claude'], ['claude-b', 'claude'], ['codex', 'codex'], ['cursor-a', 'cursor'], ['opencode-a', 'opencode']]);

    // Principals the operator issued beside the coordinator credential; each is verified for its role.
    const workerA = await token(credentialDirectory, 'workers', 'graphyard-worker-1', 'worker-1-token-');
    await token(credentialDirectory, 'workers', 'graphyard-worker-2', 'worker-2-token-');
    await token(credentialDirectory, 'workers', 'mislabelled', 'producer-in-workers-');
    await token(credentialDirectory, 'producers', 'proof-runner', 'proof-runner-token-');
    const verify = async (value: string) => ({ actor: value.startsWith('worker-1-') ? { id: 'graphyard-worker-1', role: 'worker' } : value.startsWith('worker-2-') ? { id: 'graphyard-worker-2', role: 'worker' } : value.startsWith('proof-runner-') ? { id: 'proof-runner', role: 'producer', proofs: ['integration:*'] } : { id: 'someone', role: 'producer' } });
    // An existing hand-pinned reviewer is migrated onto the accounts, keeping its own home first.
    await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude', environment: { CLAUDE_CONFIG_DIR: claudeA } });
    const probe = usage({ 'claude-a-oauth-token': { five: 10, seven: 40 } });

    const plan = await setupAgentEnvironments(root, { create: ['cursor'], probe, verify });
    assert.equal(plan.applied, false);
    assert.deepEqual(plan.environments.map(entry => [entry.environment, entry.loggedIn, entry.quota]), [['claude-a', true, 'available'], ['claude-b', false, 'unknown'], ['codex', true, 'available'], ['cursor-a', true, 'unknown'], ['opencode-a', true, 'unknown']]);
    assert.deepEqual(plan.environments.find(entry => entry.environment === 'claude-a')!.usage.map(entry => [entry.window, entry.percent]), [['5h', 10], ['7d', 40]]);
    assert.deepEqual(plan.environments.find(entry => entry.environment === 'codex')!.usage.map(entry => [entry.window, entry.percent]), [['7d', 20]]);
    assert.match(plan.environments.find(entry => entry.environment === 'claude-b')!.login!, /\/login/);
    assert.match(plan.created[0], /--apply/); assert.match(plan.next, /Rerun with --apply/);
    assert.equal((await loadMasterConfig(root)).environments, undefined, 'a plan writes nothing');
    await assert.rejects(stat(join(environments, 'cursor-b')), /ENOENT/);
    assert.equal(JSON.stringify(plan).includes('oauth-token'), false, 'no provider token appears in the report');

    const applied = await setupAgentEnvironments(root, { create: ['cursor'], apply: true, probe, verify });
    assert.deepEqual(applied.created, ['cursor-b']);
    assert.equal((await stat(join(environments, 'cursor-b'))).mode & 0o777, 0o700);
    assert.equal(applied.counts.loggedIn, 4, 'the new cursor-b has no login yet');
    assert.match(applied.next, /Log in the rest .*cursor-agent login/);
    // The fresh Claude homes get the one setting an unattended bypass-mode launch needs.
    assert.equal(JSON.parse(await readFile(join(claudeA, 'settings.json'), 'utf8')).skipDangerousModePermissionPrompt, true);
    const config = await loadMasterConfig(root);
    assert.deepEqual(config.environments!.map(entry => entry.name), ['claude-a', 'claude-b', 'codex', 'cursor-a', 'cursor-b', 'opencode-a']);
    const logged = ['claude-a', 'codex', 'cursor-a', 'opencode-a'];
    // Workers from the issued worker principals, never the mislabelled one.
    assert.deepEqual(config.workers.map(profile => [profile.name, profile.principal, profile.mode, profile.approvals]), [['graphyard-worker-1', 'graphyard-worker-1', 'launch', 'auto'], ['graphyard-worker-2', 'graphyard-worker-2', 'launch', 'auto']]);
    assert.equal(config.workers[0].credentialFile, workerA);
    for (const profile of config.workers) assert.deepEqual([...profile.accounts!].sort(), [...logged].sort(), `${profile.name} may run on every logged-in account`);
    assert.notEqual(config.workers[0].accounts![0], config.workers[1].accounts![0], 'consecutive profiles start on different accounts');
    assert.ok(applied.skipped.some(entry => entry.file.endsWith('mislabelled.token') && /not worker/.test(entry.reason)));
    // One reviewer per logged-in account, the migrated one first on its own home and no longer pinning it.
    assert.deepEqual(config.reviewers.map(profile => profile.name), ['claude-reviewer', 'review-claude-a', 'review-codex', 'review-cursor-a', 'review-opencode-a']);
    assert.equal(config.reviewers[0].accounts![0], 'claude-a'); assert.equal(config.reviewers[0].environment.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(config.reviewers.find(profile => profile.name === 'review-codex')!.accounts![0], 'codex');
    assert.equal(config.reviewers.find(profile => profile.name === 'review-codex')!.kind, 'codex');
    assert.equal(config.run.reviewerProfile, 'claude-reviewer');
    assert.deepEqual(config.producers.map(profile => [profile.name, profile.principal]), [['produce-proof-runner', 'proof-runner']]);
    assert.ok(config.producers[0].accounts!.every(name => logged.includes(name)));
    assert.ok([...config.workers, ...config.reviewers, ...config.producers].every(profile => !profile.accounts!.includes('claude-b')), 'a logged-out account is never generated into a profile');

    // Rerunning changes nothing; logging an account in adds it to every profile, after the chosen order.
    const again = await setupAgentEnvironments(root, { apply: true, probe, verify });
    assert.deepEqual(again.profiles, []);
    await account(environments, 'claude-b', 'claude', 'claude-b-oauth-token');
    const widened = await setupAgentEnvironments(root, { apply: true, probe: usage({ 'claude-a-oauth-token': { five: 10, seven: 40 }, 'claude-b-oauth-token': { five: 1, seven: 1 } }), verify });
    const after = await loadMasterConfig(root);
    assert.deepEqual(after.workers[0].accounts!.slice(0, 4), config.workers[0].accounts, 'an existing order is kept');
    assert.equal(after.workers[0].accounts!.at(-1), 'claude-b');
    assert.ok(widened.profiles.some(change => change.profile === 'review-claude-b' && change.action === 'added'));
  } finally { await cleanup(); }
});

test('integration:agent-quota-failover — every launch checks login and quota, skips an exhausted or logged-out account with its reason in master status, and fails over to the next healthy one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-quota-'));
  const homes = { spent: await account(directory, 'claude-a', 'claude'), out: await account(directory, 'claude-b', null), fresh: await account(directory, 'claude-c', 'claude'), codex: await account(directory, 'codex', 'codex'), codexB: await account(directory, 'codex-b', 'codex') };
  await codexUsage(homes.codex, 98);
  const { root, credentialDirectory, cleanup } = await master({ reviewer: true });
  try {
    // The repository carries Claude project settings, as master start writes them: a Claude session
    // launched here must load its role file instead of inheriting the repository's rules.
    await mkdir(join(root, '.claude'), { recursive: true });
    await writeFile(join(root, '.claude', 'settings.local.json'), '{}\n');
    const probe = usage({ 'claude-a-oauth-token': { five: 3, seven: 100 }, 'claude-c-oauth-token': { five: 12, seven: 3 } });
    const credential = await token(credentialDirectory, 'workers', 'worker-a', 'worker-a-token-');
    const producerCredential = await token(credentialDirectory, 'producers', 'proof-runner', 'proof-runner-token-');
    let config = await configure(root, next => {
      next.environments = [{ name: 'claude-a', kind: 'claude', home: homes.spent }, { name: 'claude-b', kind: 'claude', home: homes.out }, { name: 'claude-c', kind: 'claude', home: homes.fresh }, { name: 'codex', kind: 'codex', home: homes.codex }, { name: 'codex-b', kind: 'codex', home: homes.codexB }];
      next.workers = [{ name: 'worker-a', principal: 'worker-a', agentName: 'eng-a', mode: 'launch', kind: 'codex', credentialFile: credential, agentArgs: ['--model', 'gpt-codex'], approvals: 'auto', environment: {}, accounts: ['codex', 'claude-a', 'claude-b', 'claude-c'] },
        { name: 'worker-spent', principal: 'worker-b', agentName: 'eng-b', mode: 'launch', kind: 'claude', credentialFile: credential, agentArgs: [], approvals: 'auto', environment: {}, accounts: ['claude-a', 'claude-b'] }];
      next.reviewers = [{ name: 'review-spent', agentName: 'review-a', kind: 'claude', agentArgs: [], approvals: 'auto', environment: {}, accounts: ['claude-a', 'claude-b'] },
        { name: 'review-fresh', agentName: 'review-c', kind: 'claude', agentArgs: [], approvals: 'auto', environment: {}, accounts: ['claude-c'] },
        { name: 'review-cross', agentName: 'review-x', kind: 'codex', agentArgs: [], approvals: 'auto', environment: {}, accounts: ['codex', 'claude-c'] }];
      next.producers = [{ name: 'producer-a', principal: 'proof-runner', agentName: 'produce-a', kind: 'claude', credentialFile: producerCredential, agentArgs: [], approvals: 'auto', environment: {}, accounts: ['claude-b', 'claude-c'] },
        { name: 'producer-cross', principal: 'proof-runner', agentName: 'produce-x', kind: 'claude', credentialFile: producerCredential, agentArgs: [], approvals: 'auto', environment: {}, accounts: ['claude-a', 'claude-b', 'codex-b'] }];
      next.run.reviewerProfile = 'review-spent';
    });

    // Each account's own reason: a spent window with its reset, a missing login with its command.
    const spent = await checkAgentEnvironment(config.environments![0], { ...probe, ceilingPercent: 95 });
    assert.equal(spent.quota, 'exhausted'); assert.equal(spent.healthy, false); assert.match(spent.reason!, /claude-a quota is exhausted \(7d window at 100% until .*; ceiling 95%\)/);
    const out = await checkAgentEnvironment(config.environments![1], probe);
    assert.equal(out.loggedIn, false); assert.match(out.reason!, /claude-b is not logged in/); assert.match(out.login!, /claude-b/);
    const codex = await checkAgentEnvironment(config.environments![3], probe);
    assert.equal(codex.quota, 'exhausted'); assert.match(codex.reason!, /7d window at 98%/);
    assert.equal((await checkAgentEnvironment(config.environments![3], { ...probe, ceilingPercent: 99 })).quota, 'available', 'the ceiling is the operator\'s to set');
    await codexUsage(join(directory, 'codex-reset'), 100, -hour);
    await writeFile(join(directory, 'codex-reset/auth.json'), JSON.stringify({ tokens: { access_token: 't' } }));
    assert.equal((await checkAgentEnvironment({ name: 'codex-reset', kind: 'codex', home: join(directory, 'codex-reset') }, probe)).quota, 'available', 'a window past its reset is spendable again');
    assert.equal((await checkAgentEnvironment(config.environments![2], usage({ 'claude-c-oauth-token': 503 }))).quota, 'unknown', 'an unreadable quota does not block a launch');

    const selected = await selectAccount(config, 'worker', config.workers[0], { ...probe, work: 'GY-68' });
    assert.equal(selected.account!.name, 'claude-c');
    assert.deepEqual(selected.skipped.map(entry => entry.environment), ['codex', 'claude-a', 'claude-b']);
    await assert.rejects(selectAccount(config, 'worker', config.workers[1], probe), (error: any) => error instanceof NoHealthyAccountError && error.skipped.length === 2 && /claude-a quota is exhausted.*claude-b is not logged in/.test(error.message));

    // Worker dispatch: the exhausted Codex account is skipped before anything is claimed, and the
    // session starts on claude-c with that runtime, its home, and without the Codex-only arguments.
    const calls: string[][] = []; let claims = 0;
    const dispatched = await dispatchWork(root, ready(), config.workers[0], [], herdr(calls), [ready()], async () => ({ epoch: ++claims, path: join(root, 'assigned'), base: 'c'.repeat(40) }), async () => {}, 5_000, new Date().toISOString(), { probe });
    const tab = tabEnvironment(calls[0]);
    assert.equal(tab.CLAUDE_CONFIG_DIR, homes.fresh); assert.equal(tab.GRAPHYARD_HERDR_AGENT_KIND, 'claude'); assert.equal(tab.CODEX_HOME, undefined);
    assert.ok(calls[1][3]!.endsWith(`'--' 'claude' '--permission-mode' 'bypassPermissions' '--setting-sources' 'user' '--settings' '${sessionHarnessFile(root, 'worker', 'worker-a')}'`), 'the failed-over worker runs the account runtime and loads its role file, not the repository settings');
    assert.doesNotMatch(calls[1][3]!, /gpt-codex/);
    assert.equal(dispatched.account!.environment, 'claude-c'); assert.deepEqual(dispatched.account!.skipped.map(entry => entry.environment), ['codex', 'claude-a', 'claude-b']);
    let claimed = false;
    await assert.rejects(dispatchWork(root, ready(), config.workers[1], [], herdr([]), [ready()], async () => { claimed = true; return { epoch: 9, path: root, base: 'c'.repeat(40) }; }, async () => {}, 5_000, new Date().toISOString(), { probe }), /No healthy agent account for worker profile worker-spent/);
    assert.equal(claimed, false, 'a profile with no healthy account claims nothing');

    // The durable loop and master status read the same health: the spent profile is unavailable, with reasons.
    const health = await inspectWorkerCredentials(root, config.workers, probe);
    assert.equal(health['worker-a'].available, true); assert.equal(health['worker-spent'].available, false);
    assert.match(health['worker-spent'].reason!, /No healthy agent account: claude-a quota is exhausted.*; claude-b is not logged in/);
    const status = buildMasterStatus({ work: [], now: new Date().toISOString() }, config.workers, [], health);
    assert.match(status.workers.find(row => row.profile === 'worker-spent')!.credential.reason!, /claude-a quota is exhausted/);
    assert.equal((await inspectProducerCredentials(root, config.producers, probe))['producer-a'].available, true);

    // A reviewer launch: the configured profile has no healthy account, so it refuses before minting
    // a token; the automatic loop fails over to the next reviewer profile and says why.
    const mint = async () => ({ token: 'ghs_session_token_value', expiresAt: future(3_000_000) });
    let minted = 0;
    await assert.rejects(launchReview(root, work(), 'review-spent', [], new Date().toISOString(), { run: herdr([]), mint: async () => { minted++; return mint(); }, probe }), (error: any) => error.accountsExhausted === true);
    assert.equal(minted, 0); assert.deepEqual((await readReviewLedger(root)).reviews, []);
    const reviewCalls: string[][] = [];
    const reviewed = await launchReview(root, work(), 'review-fresh', [], new Date().toISOString(), { run: herdr(reviewCalls), mint, probe });
    assert.equal(reviewed.account!.environment, 'claude-c'); assert.equal(tabEnvironment(reviewCalls[0]).CLAUDE_CONFIG_DIR, homes.fresh);
    const produceCalls: string[][] = [];
    const requested = { id: 'request-producer', kind: 'producer', sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyRevision: 2, pr: 68, group: 'integration', proofs: ['integration:agent-quota-failover'], state: 'requested', requestedAt: new Date().toISOString(), reason: 'r' } as any;
    const producing = work({ autoDispatch: { review: null, producers: [requested], history: [] } } as any);
    const produced = await launchProducer(root, producing, requested, config.producers[0], [], new Date().toISOString(), { run: herdr(produceCalls), probe });
    assert.equal(produced.account!.environment, 'claude-c'); assert.deepEqual(produced.account!.skipped.map(entry => entry.environment), ['claude-b']);
    assert.equal(tabEnvironment(produceCalls[0]).GRAPHYARD_TOKEN_FILE, producerCredential);

    // Cross-runtime failover for a reviewer: the Codex profile's only Codex account is exhausted, so
    // the session runs on the Claude account — with the reviewer's role harness following the
    // account's --kind, never the repository's master rules.
    const reviewLedger = await readReviewLedger(root);
    await saveReviewLedger(root, { ...reviewLedger, reviews: reviewLedger.reviews.filter(record => record.state !== 'pending') });
    const reviewCrossCalls: string[][] = [];
    const reviewedCross = await launchReview(root, work(), 'review-cross', [], new Date().toISOString(), { run: herdr(reviewCrossCalls), mint, probe });
    assert.equal(reviewedCross.account!.environment, 'claude-c');
    assert.equal(tabEnvironment(reviewCrossCalls[0]).CLAUDE_CONFIG_DIR, homes.fresh);
    const reviewStart = reviewCrossCalls.find(args => args[0] === 'agent' && args[1] === 'start')!;
    assert.equal(reviewStart[4], 'claude', 'the session runs the account\'s runtime, not the profile\'s');
    assert.deepEqual(reviewStart.slice(reviewStart.indexOf('--') + 1), ['--permission-mode', 'bypassPermissions', '--setting-sources', 'user', '--settings', sessionHarnessFile(root, 'reviewer', 'review-cross')]);
    const roleFile = JSON.parse(await readFile(sessionHarnessFile(root, 'reviewer', 'review-cross'), 'utf8'));
    assert.ok(roleFile.permissions.allow.includes('Bash(gh api --method POST repos/owner/project/pulls/68/reviews*)'), 'the failed-over reviewer keeps its one verdict allow');
    assert.ok(roleFile.permissions.deny.includes('Bash(git push:*)'), 'the failed-over reviewer keeps its role denies');
    assert.equal(JSON.stringify(roleFile).includes('master:*'), false, 'the master\'s own rules never ride a reviewer session');

    // Cross-runtime failover for a producer: the Claude profile's Claude accounts are spent or
    // logged out, so the session runs on the healthy Codex account with no Claude flags on its line.
    const produceLedger = await readProducerLedger(root);
    await saveProducerLedger(root, { ...produceLedger, producers: produceLedger.producers.filter(record => record.state !== 'pending') });
    const requestedCross = { ...requested, id: 'request-producer-cross', proofs: ['integration:prompt-delivery-confirmed'] };
    const producingCross = work({ autoDispatch: { review: null, producers: [requestedCross], history: [] } } as any);
    const produceCrossCalls: string[][] = [];
    const producedCross = await launchProducer(root, producingCross, requestedCross, config.producers.find(profile => profile.name === 'producer-cross')!, [], new Date().toISOString(), { run: herdr(produceCrossCalls), probe });
    assert.equal(producedCross.account!.environment, 'codex-b'); assert.deepEqual(producedCross.account!.skipped.map(entry => entry.environment), ['claude-a', 'claude-b']);
    const produceStart = produceCrossCalls.find(args => args[0] === 'agent' && args[1] === 'start')!;
    assert.equal(produceStart[4], 'codex', 'the session runs the account\'s runtime, not the profile\'s');
    const produceTail = produceStart.slice(produceStart.indexOf('--') + 1);
    assert.deepEqual(produceTail, ['--ask-for-approval', 'never', '--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true', '--add-dir', '/tmp', '--add-dir', sharedGitDirectory(root)]);
    assert.equal(produceTail.includes('--setting-sources'), false, 'no Claude harness flags ride a Codex command line');

    const review = { id: 'request-review', kind: 'review', provider: 'github', sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyRevision: 2, pr: 68, state: 'requested', requestedAt: new Date().toISOString(), reason: 'r' } as any;
    const item = work({ autoDispatch: { review, producers: [], history: [] } } as any);
    const tried: string[] = [];
    const effects: DispatchEffects = {
      snapshot: async () => ({ work: [item], now: new Date().toISOString() }), agents: () => [], credentials: async () => ({}),
      reconcileReviews: async () => ({ reviews: [] }), reconcileProducers: async () => ({ producers: [] }),
      launchReview: async (_work, _request, profile) => { tried.push(profile.name); if (profile.name === 'review-spent') throw new NoHealthyAccountError('No healthy agent account for reviewer profile review-spent: claude-a quota is exhausted', []); return {}; },
      launchProducer: async () => ({}), persist: async () => {},
    };
    const cursor = await readDispatchCursor(root, config);
    const tick = await runDispatchTick(config, cursor, effects);
    assert.deepEqual(tried, ['review-spent', 'review-fresh']);
    assert.equal(tick.launched[0].profile, 'review-fresh'); assert.match(tick.launched[0].failover![0], /review-spent: .*claude-a quota is exhausted/);

    // master status: every account's last observed health and each skipped launch with its reason.
    const summary = dispatchSummary(await readDispatchCursor(root, config), Date.now(), 10_000);
    assert.equal(summary.accounts.environments.find(entry => entry.environment === 'claude-a')!.quota, 'exhausted');
    assert.ok(summary.accounts.skipped.some(entry => entry.role === 'worker' && entry.environment === 'codex' && entry.work === 'GY-68' && /98%/.test(entry.reason)));
    assert.ok(summary.accounts.skipped.some(entry => entry.role === 'reviewer' && entry.environment === 'claude-a'));
    assert.ok(summary.accounts.skipped.some(entry => entry.role === 'producer' && entry.environment === 'claude-b' && /not logged in/.test(entry.reason)));
    const log = await readEnvironmentLog(config);
    assert.equal(JSON.stringify(log).includes('oauth-token'), false, 'the log never holds a provider token');
    assert.equal((await stat(join(credentialDirectory, 'masters', (await readdir(join(credentialDirectory, 'masters'))).find(name => name.endsWith('.environments.json'))!))).mode & 0o777, 0o600);
  } finally { await cleanup(); await rm(directory, { recursive: true, force: true }); }
});

test('integration:prompt-delivery-confirmed — a launch counts only once the runtime visibly accepted its prompt; a dropped prompt is redelivered, or the session is closed and relaunched', async () => {
  // Herdr's own confirmation: the prompt must move the agent out of idle.
  const stalled = { error: { code: 'agent_prompt_stalled', message: 'agent did not start working within 5000ms' } };
  let prompts = 0; const calls: string[][] = [];
  const delivered = deliverPrompt('opencode-worker', 'Implement GY-68', herdr(calls, args => args[1] === 'prompt' && ++prompts < 3 ? stalled : undefined), fast);
  assert.equal(delivered.attempts, 3);
  assert.deepEqual(calls[0], ['agent', 'prompt', 'opencode-worker', 'Implement GY-68', '--wait', '--until', 'working', '--until', 'blocked', '--timeout', '1000']);
  assert.throws(() => deliverPrompt('dropped', 'x', herdr([], () => stalled), fast), (error: any) => error instanceof PromptNotAcceptedError && error.promptDropped && /after 3 deliveries/.test(error.message));
  const blocked: string[][] = [];
  assert.throws(() => deliverPrompt('blocked', 'x', herdr(blocked, () => ({ error: { code: 'agent_blocked', message: 'agent is blocked' } })), fast), /agent is blocked/);
  assert.equal(blocked.length, 1, 'a refusal other than a stall is not retried');
  // The real CLI exits non-zero with the error JSON on its output.
  assert.equal(herdrErrorCode(Object.assign(new Error('Command failed: herdr agent prompt'), { stdout: '{"error":{"code":"agent_prompt_stalled","message":"m"}}' })), 'agent_prompt_stalled');
  const follow: string[][] = []; let waits = 0;
  assert.equal(deliverPrompt('master', 'You are the master', herdr(follow, args => args[1] === 'wait' && ++waits === 1 ? { error: { code: 'timeout', message: 'timed out' } } : undefined), { ...fast, confirm: 'follow' }).attempts, 2);
  assert.deepEqual(follow.map(args => args[1]), ['prompt', 'wait', 'prompt', 'wait']);
  assert.equal(follow[0].at(-1), 'You are the master');

  const { root, credentialDirectory, cleanup } = await master({ reviewer: true });
  try {
    // A reviewer whose runtime never takes the prompt is closed with its credential, not left idle.
    await saveReviewerProfile(root, { name: 'review-opencode', agentName: 'review-oc', kind: 'opencode' });
    const reviewCalls: string[][] = [];
    await assert.rejects(launchReview(root, work(), 'review-opencode', [], new Date().toISOString(), { run: herdr(reviewCalls, args => args[1] === 'prompt' ? stalled : undefined), mint: async () => ({ token: 'ghs_x', expiresAt: future(3_000_000) }), prompt: fast }), (error: any) => error.promptDropped === true);
    assert.deepEqual(reviewCalls.filter(args => args[1] === 'prompt').length, 3);
    assert.ok(reviewCalls.some(args => args[0] === 'pane' && args[1] === 'close' && args[2] === 'pane-1'), 'the idle session is closed');
    assert.deepEqual((await readReviewLedger(root)).reviews, [], 'no launch is recorded for a prompt nobody accepted');

    // The loop relaunches such a session once before it records a refusal.
    const config = await loadMasterConfig(root);
    const review = { id: 'request-review', kind: 'review', provider: 'github', sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyRevision: 2, pr: 68, state: 'requested', requestedAt: new Date().toISOString(), reason: 'r' } as any;
    const item = work({ autoDispatch: { review, producers: [], history: [] } } as any);
    let launches = 0;
    const effects: DispatchEffects = {
      snapshot: async () => ({ work: [item], now: new Date().toISOString() }), agents: () => [], credentials: async () => ({}),
      reconcileReviews: async () => ({ reviews: [] }), reconcileProducers: async () => ({ producers: [] }),
      launchReview: async () => { if (++launches === 1) throw new PromptNotAcceptedError('review-oc did not visibly accept its prompt'); return {}; },
      launchProducer: async () => ({}), persist: async () => {},
    };
    const tick = await runDispatchTick(config, await readDispatchCursor(root, config), effects);
    assert.equal(launches, 2); assert.equal(tick.launched[0].relaunched, true); assert.deepEqual(tick.refused, []);

    // A worker: the dropped launch releases its claim and closes the pane, then a fresh claim relaunches it.
    const credential = await token(credentialDirectory, 'workers', 'worker-oc', 'worker-oc-token-');
    const profile = { name: 'opencode-worker', principal: 'worker-oc', agentName: 'eng-oc', mode: 'launch' as const, kind: 'opencode' as const, credentialFile: credential, agentArgs: [], approvals: 'auto' as const, environment: {} };
    const workerCalls: string[][] = []; const claims: number[] = [], released: number[] = []; let workerPrompts = 0;
    const result = await dispatchWork(root, ready(), profile, [], herdr(workerCalls, args => args[1] === 'prompt' && ++workerPrompts <= 3 ? stalled : undefined), [ready()],
      async () => { claims.push(claims.length + 1); return { epoch: claims.length, path: join(root, `assigned-${claims.length}`), base: 'c'.repeat(40) }; }, async (_root, _key, epoch) => { released.push(epoch); }, 5_000, new Date().toISOString(), { prompt: fast });
    assert.deepEqual(claims, [1, 2]); assert.deepEqual(released, [1], 'the first claim is released before the relaunch');
    assert.equal(result.relaunched, 1); assert.equal(workerCalls.filter(args => args[0] === 'pane' && args[1] === 'close').length, 1);
    assert.deepEqual(workerCalls.at(-1)!.slice(0, 5), ['agent', 'prompt', 'eng-oc', workerCalls.at(-1)![3], '--wait']);
    // Twice dropped: the item is released, never left with an idle session.
    const stuck: number[] = [];
    await assert.rejects(dispatchWork(root, ready(), profile, [], herdr([], args => args[1] === 'prompt' ? stalled : undefined), [ready()], async () => ({ epoch: 7, path: join(root, 'stuck'), base: 'c'.repeat(40) }), async (_root, _key, epoch) => { stuck.push(epoch); }, 5_000, new Date().toISOString(), { prompt: fast }), (error: any) => error.promptDropped === true);
    assert.deepEqual(stuck, [7, 7]);
  } finally { await cleanup(); }
});

test('integration:max-autonomy-permissions — every launched agent gets its runtime\'s broadest non-interactive approval mode, the master harness covers what the master owns, and role credentials are unchanged', async () => {
  assert.deepEqual(agentLaunchPlan('claude', 'auto').args, ['--permission-mode', 'bypassPermissions']);
  assert.deepEqual(agentLaunchPlan('codex', 'auto').args.slice(0, 2), ['--ask-for-approval', 'never']);
  assert.deepEqual(agentLaunchPlan('cursor', 'auto').args, ['--force', '--trust']);
  const opencode = JSON.parse(agentLaunchPlan('opencode', 'auto').environment.OPENCODE_PERMISSION);
  for (const permission of ['*', 'edit', 'bash', 'webfetch', 'external_directory', 'doom_loop']) assert.equal(opencode[permission], 'allow', `opencode ${permission} is allowed`);
  assert.equal(agentLaunchPlan('opencode', 'prompt').applied, false, 'an explicit opt-out is still honoured');
  // Codex keeps its sandbox, widened to what the role needs: network, and the shared Git directory.
  const codex = accountLaunch({ kind: 'codex', approvals: 'auto', agentArgs: [], environment: {} }, null, { writable: ['/repo/.git'] });
  assert.deepEqual(codex.args.slice(-4), ['-c', 'sandbox_workspace_write.network_access=true', '--add-dir', '/repo/.git']);
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-autonomy-'));
  const fresh = { name: 'claude-z', kind: 'claude' as const, home: await account(directory, 'claude-z', null) };
  assert.equal((await prepareAgentEnvironment(fresh)).length, 1); assert.deepEqual(await prepareAgentEnvironment(fresh), [], 'preparing is idempotent');
  assert.equal(JSON.parse(await readFile(join(fresh.home, 'settings.json'), 'utf8')).skipDangerousModePermissionPrompt, true);
  const opencodeAccount = { name: 'opencode-a', kind: 'opencode' as const, home: await account(directory, 'opencode-a', 'opencode') };
  assert.equal(accountLaunch({ kind: 'opencode', approvals: 'auto', agentArgs: [], environment: {} }, opencodeAccount).environment.XDG_DATA_HOME, opencodeAccount.home);

  const { root, credentialDirectory, cleanup } = await master({ reviewer: true });
  try {
    const config = await configure(root, next => { next.run.smokeWorkflow = 'deploy-smoke.yml'; next.run.deploymentUrl = 'https://graphyard.example/api/health'; next.environments = [opencodeAccount]; });
    // Worker, reviewer and producer sessions: broadest approval, each with only its own role's credential.
    const credential = await token(credentialDirectory, 'workers', 'worker-oc', 'worker-oc-token-');
    const workerCalls: string[][] = [];
    await dispatchWork(root, ready(), { name: 'oc', principal: 'worker-oc', agentName: 'eng-oc', mode: 'launch', kind: 'opencode', credentialFile: credential, agentArgs: [], approvals: 'auto', environment: {}, accounts: ['opencode-a'] }, [], herdr(workerCalls), [ready()], async () => ({ epoch: 1, path: join(root, 'assigned'), base: 'c'.repeat(40) }), async () => {}, 5_000, new Date().toISOString(), { probe: { cacheMs: 0 } });
    const workerTab = tabEnvironment(workerCalls[0]);
    assert.equal(JSON.parse(workerTab.OPENCODE_PERMISSION).external_directory, 'allow'); assert.equal(workerTab.GRAPHYARD_TOKEN_FILE, credential);
    assert.equal(workerTab.GH_CONFIG_DIR, undefined); assert.equal(JSON.stringify(workerCalls).includes('worker-oc-token-'), false);
    await saveReviewerProfile(root, { name: 'review-oc', agentName: 'review-oc', kind: 'opencode', accounts: ['opencode-a'] });
    const reviewCalls: string[][] = [];
    await launchReview(root, work(), 'review-oc', [], new Date().toISOString(), { run: herdr(reviewCalls), mint: async () => ({ token: 'ghs_x', expiresAt: future(3_000_000) }), probe: { cacheMs: 0 } });
    const reviewTab = tabEnvironment(reviewCalls[0]);
    assert.equal(JSON.parse(reviewTab.OPENCODE_PERMISSION)['*'], 'allow'); assert.ok(reviewTab.GH_CONFIG_DIR);
    assert.equal(reviewTab.GRAPHYARD_TOKEN_FILE, undefined, 'a reviewer still holds no Graphyard credential');

    // The master itself launches with its broadest mode and its prompt is confirmed.
    const masterCalls: string[][] = [];
    await startMaster(root, 'codex', [], [], herdr(masterCalls));
    const start = masterCalls.find(args => args[0] === 'agent' && args[1] === 'start')!;
    assert.deepEqual(start.slice(start.indexOf('--') + 1, start.indexOf('--') + 5), ['--ask-for-approval', 'never', '--sandbox', 'workspace-write']);
    assert.ok(start.includes('sandbox_workspace_write.network_access=true') && start.includes(join(credentialDirectory, 'masters')));
    assert.deepEqual(masterCalls.slice(-2).map(args => args[1]), ['prompt', 'wait']);

    // The master harness covers everything the master owns, and still no merge path or credential
    // read: master.json is read, never edited — its owned settings change through `master config` —
    // the loop's systemd unit is exact, and no rule lets curl take arbitrary arguments.
    const plan = masterHarness(root, config, 'claude');
    const allow = plan.allow.map(entry => entry.rule), deny = plan.deny.map(entry => entry.rule);
    for (const rule of ['Read(./.graphyard/master.json)', 'Bash(systemctl --user restart graphyard-master.service)', 'Bash(systemctl --user stop graphyard-master.service)', 'Bash(journalctl --user -u graphyard-master.service:*)', 'Bash(railway redeploy:*)', 'Bash(railway deployment:*)', 'Bash(gh run rerun:*)', 'Bash(gh workflow run deploy-smoke.yml:*)', `Bash(node ${config.cliPath} master:*)`]) assert.ok(allow.includes(rule), `${rule} is the master's own`);
    for (const entry of plan.allow) assert.ok(entry.why.length > 30, `${entry.rule} explains itself`);
    for (const rule of allow) assert.doesNotMatch(rule, /merge|access_tokens|reviews|graphql|\.pem|\.token|credential|cookies/i);
    for (const rule of allow.filter(rule => rule.includes('master.json'))) assert.match(rule, /^Read\(/, `${rule} must not write the master's configuration file; the owned fields go through master config`);
    for (const rule of allow.filter(rule => /(^|[( ])curl /.test(rule))) assert.ok(!/\*/.test(rule), `${rule} would let curl take arbitrary arguments`);
    for (const rule of allow.filter(rule => /systemctl --user (restart|start|stop)/.test(rule))) assert.match(rule, /graphyard-master\.service\)$/, `${rule} must name the loop's unit exactly`);
    for (const rule of ['Bash(gh pr merge:*)', 'Bash(gh pr review:*)', 'Bash(gh api *merge*)', 'Bash(git push:*)', 'Read(**/*.token)', 'Read(./.graphyard/connection.json)']) assert.ok(deny.includes(rule), `${rule} stays denied`);
    assert.equal(new Set(allow).size, allow.length, 'no rule is listed twice');
    assert.match(masterHarness(root, config, 'codex').manual!, /--ask-for-approval never .*network_access=true/);

    // The owned-fields path is the only configuration write a master session can reach: the owned
    // run settings and a profile's account order round-trip; autoMerge and credential paths are
    // unreachable from it and stay exactly as the operator set them.
    await configure(root, next => { next.autoMerge = false; });
    const before = await loadMasterConfig(root);
    assert.throws(() => masterSettingsFromArgs(['autoMerge=false']), /changes only what the master owns/, 'autoMerge is not an owned field');
    assert.throws(() => masterSettingsFromArgs([`credentialFile=${join(credentialDirectory, 'elsewhere.token')}`]), /changes only what the master owns/, 'credential paths are not owned fields');
    await assert.rejects(saveMasterSettings(root, { autoMerge: false } as any), /changes only what the master owns/, 'the writer refuses unknown fields too');
    const tuned = await saveMasterSettings(root, masterSettingsFromArgs(['intervalSeconds=25', 'quotaCeilingPercent=90', 'deploymentUrl=https://graphyard.example/api/health', 'accounts:review-oc=opencode-a']));
    const after = await loadMasterConfig(root);
    assert.deepEqual(tuned.changed, ['intervalSeconds', 'deploymentUrl', 'quotaCeilingPercent', 'accounts:review-oc']);
    assert.equal(after.run.intervalSeconds, 25); assert.equal(after.run.quotaCeilingPercent, 90);
    assert.equal(after.run.deploymentUrl, 'https://graphyard.example/api/health');
    assert.equal(after.autoMerge, false, 'an autoMerge flip never rides the owned fields');
    assert.equal(after.credentialFile, before.credentialFile, 'credential paths never move through the owned fields');
    assert.deepEqual(after.reviewers.find(profile => profile.name === 'review-oc')!.accounts, ['opencode-a']);
    await assert.rejects(saveMasterSettings(root, { intervalSeconds: null }), /can only be set, never cleared/);
    await assert.rejects(saveMasterSettings(root, { reviewerProfile: 'no-such' }), /No reviewer profile named no-such/);
    await assert.rejects(saveMasterSettings(root, { accounts: [{ profile: 'no-such', accounts: ['opencode-a'] }] }), /No worker, reviewer, or producer profile named no-such/);
    await assert.rejects(saveMasterSettings(root, masterSettingsFromArgs(['accounts:review-oc=claude-a'])), /claude-a is not a configured agent environment/);
    const cleared = await saveMasterSettings(root, masterSettingsFromArgs(['deploymentUrl=', 'accounts:review-oc=']));
    assert.equal(cleared.run.deploymentUrl, undefined, 'an optional owned field can be cleared');
    assert.equal((await loadMasterConfig(root)).reviewers.find(profile => profile.name === 'review-oc')!.accounts, undefined, 'an empty account list clears the pinned order');
  } finally { await cleanup(); await rm(directory, { recursive: true, force: true }); }
});

test('manual:agent-env-docs-review — the onboarding and master guides describe agent environments, quota failover and permissions', async () => {
  const read = async (name: string) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
  const [onboarding, masterGuide, help] = await Promise.all([read('docs/onboarding.md'), read('docs/master-agent.md'), read('src/cli/master.ts')]);
  for (const fragment of ['master environments', '~/.coding_agents', '--create', '--apply', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_DATA_HOME', 'CURSOR_CONFIG_DIR', 'quota']) assert.ok(onboarding.includes(fragment), `onboarding describes ${fragment}`);
  for (const fragment of ['master environments', 'quotaCeilingPercent', 'fails over', 'accounts', 'prompt', 'bypassPermissions', 'OPENCODE_PERMISSION', 'master harness', 'systemctl --user restart graphyard-master']) assert.ok(masterGuide.includes(fragment), `the master guide describes ${fragment}`);
  assert.match(help, /master environments \[--create KIND/);
});
