import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runUp, type UpDependencies, type UpEvent, type UpRequest } from '../src/up.js';
import { loadMasterConfig, setupAgentEnvironments, setupMaster, type EnvironmentProbe } from '../src/master.js';
import { Vault, writeInstallRecord } from '../src/install/secrets.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * A second install on one host gets its own worker credentials (GY-1885). AC-1 is the proof
 * unit:environments-reads-only-own-install-credentials: `master environments` reads the install
 * directory `graphyard install` manages and never another install's token folder. AC-2 is
 * unit:up-issues-install-worker-credentials: up's accounts step issues the install's own worker
 * identities instead of waiting on an account sign-in, and stops naming the files a plane refuses.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const hour = 3_600_000, future = (ms = hour) => new Date(Date.now() + ms).toISOString();
const tokenValue = (name: string) => name.padEnd(40, 'x');

async function account(directory: string, name: string, login: 'claude' | 'codex', token = `${name}-oauth-token`) {
  const home = join(directory, name); await mkdir(home, { recursive: true });
  if (login === 'claude') await writeFile(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `${token}-refresh`, expiresAt: Date.now() + 5 * hour, subscriptionType: 'max' } }), { mode: 0o600 });
  if (login === 'codex') await writeFile(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: token, refresh_token: 'r', id_token: 'i', account_id: 'a' } }), { mode: 0o600 });
  return home;
}

/** The provider usage endpoint, answering per stored access token. */
function usage(byToken: Record<string, { five: number; seven: number }>): EnvironmentProbe {
  return {
    fetch: (async (url: string, init: any) => {
      const token = String(init.headers.Authorization).replace('Bearer ', '');
      const entry = byToken[token];
      if (!entry) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ five_hour: { utilization: entry.five, resets_at: future(2 * hour) }, seven_day: { utilization: entry.seven, resets_at: future(48 * hour) } }));
    }) as unknown as typeof fetch,
    cacheMs: 0,
  };
}

async function repository(name: string) {
  const root = await temporaryDirectory(`install-credentials-${name.replace('/', '-')}`);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', `https://github.com/${name}.git`]);
  return root;
}

const installRecordBody = (installId: string, repository: string, principals: { id: string; role: 'admin' | 'coordinator' | 'worker' | 'reader' }[]) => ({
  version: 1 as const, installId, repository, provider: 'compose' as const, baseBranch: 'main',
  principals: principals.map(principal => ({ ...principal, fingerprint: '0123456789ab' })),
  createdAt: new Date(Date.now() - hour).toISOString(), updatedAt: new Date(Date.now() - hour).toISOString(),
});

test('unit:environments-reads-only-own-install-credentials — with two installs on one host home, master environments for the second install reads only its own install directory (the shared workers folder is never scanned, so none of the other install\'s files is refused) and writes one worker profile per logged-in launch account once the install\'s credentials exist', async () => {
  const home = await temporaryDirectory('worker-credentials-home');
  const environments = await temporaryDirectory('worker-credentials-accounts');
  const previousHome = process.env.GRAPHYARD_CONFIG_HOME, previousEnvironments = process.env.GRAPHYARD_AGENT_ENVIRONMENTS;
  process.env.GRAPHYARD_CONFIG_HOME = home;
  process.env.GRAPHYARD_AGENT_ENVIRONMENTS = environments;
  try {
    // Two logged-in launch accounts on the host: one per runtime, so the profiles spread over both.
    await account(environments, 'claude-a', 'claude', 'claude-a-oauth-token');
    await account(environments, 'codex', 'codex', 'codex-oauth-token');
    // The first install's worker credentials sit in the host-wide folder the shared masters layout
    // produces; the second plane refuses them (its verify accepts only its own tokens).
    const shared = join(home, 'workers');
    await mkdir(shared, { recursive: true, mode: 0o700 });
    const sharedToken = join(shared, 'graphyard-claude-1.token');
    await writeFile(sharedToken, tokenValue('main-install-worker-1'), { mode: 0o600 });
    const vault = new Vault();
    await mkdir(join(home, 'acme-main'), { recursive: true, mode: 0o700 });
    await writeInstallRecord(join(home, 'acme-main'), installRecordBody('acme-main', 'acme/main', [{ id: 'acme-main-worker-1', role: 'worker' }]), vault);

    // The second install: its own install record with two worker principals, and a master.json whose
    // coordinator credential sits in the shared masters folder, exactly as up's host-supervisor writes it.
    const root = await repository('acme/snake');
    const snakeStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'acme/snake', baseBranch: 'main', githubAppId: 1234 }));
    await setupMaster(root, { url: 'https://snake.example', token: tokenValue('snake-coordinator'), cliPath: launcher, credentialDirectory: home }, snakeStatus as typeof fetch);
    const snakeDir = join(home, 'acme-snake');
    await mkdir(snakeDir, { recursive: true, mode: 0o700 });
    await writeInstallRecord(snakeDir, installRecordBody('acme-snake', 'acme/snake', [
      { id: 'acme-snake-worker-1', role: 'worker' }, { id: 'acme-snake-worker-2', role: 'worker' },
    ]), vault);
    await mkdir(join(snakeDir, 'tokens'), { recursive: true, mode: 0o700 });
    await writeFile(join(snakeDir, 'tokens', 'acme-snake-worker-1.token'), tokenValue('snake-worker-1'), { mode: 0o600 });
    await writeFile(join(snakeDir, 'tokens', 'acme-snake-worker-2.token'), tokenValue('snake-worker-2'), { mode: 0o600 });
    // One of this install's own files the plane refuses (a producer token mislabelled as a worker's):
    // the scan must still see it, and only it.
    await mkdir(join(snakeDir, 'workers'), { recursive: true, mode: 0o700 });
    await writeFile(join(snakeDir, 'workers', 'mislabelled.token'), tokenValue('producer-in-workers'), { mode: 0o600 });

    const verified: string[] = [];
    const verify = async (value: string) => {
      verified.push(value);
      if (value.startsWith('snake-worker-1')) return { actor: { id: 'acme-snake-worker-1', role: 'worker' } };
      if (value.startsWith('snake-worker-2')) return { actor: { id: 'acme-snake-worker-2', role: 'worker' } };
      throw new Error('the control plane refused the credential (401)');
    };
    const probe = usage({ 'claude-a-oauth-token': { five: 10, seven: 40 } });

    const plan = await setupAgentEnvironments(root, { probe, verify });
    assert.deepEqual(plan.skipped.map((entry: any) => entry.file), [join(snakeDir, 'workers', 'mislabelled.token')],
      'the scan reads only the install\'s own directory: the one refusal is its own mislabelled file, never a shared-folder file');
    assert.deepEqual(plan.skipped.map((entry: any) => entry.reason), ['the control plane refused the credential (401)']);
    assert.ok(!verified.includes(tokenValue('main-install-worker-1')), `the main install's shared credential is never read, verified: ${verified.join(', ')}`);

    // The install's credentials exist, exactly as up issues them: 0600 copies in the install
    // directory's workers folder. One worker profile per logged-in launch account, each running on both.
    await writeFile(join(snakeDir, 'workers', 'acme-snake-worker-1.token'), tokenValue('snake-worker-1'), { mode: 0o600 });
    await writeFile(join(snakeDir, 'workers', 'acme-snake-worker-2.token'), tokenValue('snake-worker-2'), { mode: 0o600 });
    const applied = await setupAgentEnvironments(root, { probe, verify, apply: true });
    assert.deepEqual(applied.skipped.map((entry: any) => entry.file), [join(snakeDir, 'workers', 'mislabelled.token')]);
    const config = await loadMasterConfig(root);
    assert.deepEqual(config.workers.map(profile => [profile.principal, profile.mode]), [['acme-snake-worker-1', 'launch'], ['acme-snake-worker-2', 'launch']]);
    for (const profile of config.workers) {
      assert.deepEqual([...profile.accounts!].sort(), ['claude-a', 'codex'], `${profile.name} runs on every logged-in launch account`);
      assert.equal(await stat(profile.credentialFile!).then(info => info.mode & 0o777), 0o600);
      assert.ok(profile.credentialFile!.startsWith(snakeDir), 'a profile credential is read from the install directory');
    }
    assert.deepEqual(config.reviewers.map(profile => profile.name).sort(), ['review-claude-a', 'review-codex'], 'one reviewer profile per logged-in account');
    assert.equal(config.workers.some(profile => profile.principal === 'acme-main-worker-1'), false, 'the other install\'s principal makes no profile here');
    // The main install's credentials are untouched.
    assert.equal(await readFile(sharedToken, 'utf8'), tokenValue('main-install-worker-1'));
  } finally {
    if (previousHome === undefined) delete process.env.GRAPHYARD_CONFIG_HOME; else process.env.GRAPHYARD_CONFIG_HOME = previousHome;
    if (previousEnvironments === undefined) delete process.env.GRAPHYARD_AGENT_ENVIRONMENTS; else process.env.GRAPHYARD_AGENT_ENVIRONMENTS = previousEnvironments;
    await rm(home, { recursive: true, force: true });
    await rm(environments, { recursive: true, force: true });
  }
});

// --- up's accounts step (AC-2) -----------------------------------------------------------------

const UP_SERVER = 'http://127.0.0.1:4310';
const UP_ADMIN = 'a'.repeat(40);

interface AccountsWorldOptions {
  /** Sleeps before the fleet folds and the account lines turn green. */
  fleetAfterTicks?: number;
  /** What the profiles write counts as logged-in environments (a function reads it at call time). */
  loggedIn?: number | (() => number);
}

/**
 * A github-mode up world whose accounts step is exercised: the install record and its worker tokens
 * are real files under INSTALLDIR, and the fake `master environments --apply` judges that folder the
 * way the real write does — one worker profile per 0600 token it finds there, `refused*` files refused.
 */
function accountsWorld(checkout: string, installDir: string, options: AccountsWorldOptions = {}) {
  const calls: string[][] = [], events: UpEvent[] = [];
  let clock = 0, installed = false, loop = false, fleetReady = false;
  const status = () => ({
    github: true, githubRepository: 'acme/shop', appPermissions: { missing: [] },
    reviewerApps: [{ id: 'claude', appId: 9 }],
    mergeWriter: { merger: 'github', line: null },
    fleet: fleetReady
      ? { roles: [{ role: 'worker', accounts: ['claude-a'] }, { role: 'reviewer', accounts: ['claude-a'] }], accounts: [{ name: 'claude-a', enabled: true, loggedIn: true, smoke: { result: 'pass' } }] }
      : { roles: [], accounts: [] },
    setup: { protection: 'checks', loop },
  });
  const deps: UpDependencies = {
    root: checkout, pollMs: 1, emit: event => events.push(event),
    now: () => clock,
    sleep: async () => { clock += 1; if (clock >= (options.fleetAfterTicks ?? 2)) fleetReady = true; },
    humanWaitMs: 200, machineWaitMs: 300,
    serverUrl: async () => installed ? UP_SERVER : null,
    masterToken: async () => installed ? 'm'.repeat(40) : null,
    operatorToken: async () => UP_ADMIN,
    signIn: async () => null,
    status: async () => installed ? status() : null,
    installDirectory: () => installDir,
    publishOnboarding: async () => null,
    onboardingMerged: async () => true,
    async cli(args) {
      calls.push(args);
      const joined = args.join(' ');
      if (args[0] === 'install' && args.includes('--plan')) return { code: 0, stdout: JSON.stringify({ installId: 'acme-shop', installDirectory: installDir, browserApps: [], principals: [{ id: 'acme-shop-operator', role: 'admin', sessionKind: 'human' }], preflight: [{ name: 'GitHub CLI', ok: true }] }) };
      if (args[0] === 'install' && args.includes('--apply')) { installed = true; return { code: 0, stdout: JSON.stringify({ ok: true }) }; }
      if (joined === 'master registry propose --apply') return { code: 0, stdout: '{}' };
      if (joined === 'master environments --apply') {
        const folder = join(installDir, 'workers');
        const names = existsSync(folder) ? readdirSync(folder).filter(name => name.endsWith('.token')) : [];
        return { code: 0, stdout: JSON.stringify({
          counts: { environments: 2, loggedIn: typeof options.loggedIn === 'function' ? options.loggedIn() : options.loggedIn ?? 2, workers: names.filter(name => !name.startsWith('refused')).length, reviewers: names.length ? 2 : 0 },
          skipped: names.filter(name => name.startsWith('refused')).map(name => ({ file: join(folder, name), reason: 'Graphyard rejected the worker credential (401)' })),
        }) };
      }
      if (joined === 'master restart') { loop = true; return { code: 0, stdout: '{}' }; }
      return { code: 0, stdout: '{}' };
    },
  };
  return {
    deps, calls, events,
    installWorker: async (id: string, value: string) => {
      await mkdir(join(installDir, 'tokens'), { recursive: true, mode: 0o700 });
      await writeFile(join(installDir, 'tokens', `${id}.token`), tokenValue(value), { mode: 0o600 });
    },
  };
}

const request = (extra: Partial<UpRequest> = {}): UpRequest => ({ repository: 'acme/shop', provider: 'compose', agent: true, reviewer: 'claude', master: 'claude', goalFile: null, browserProfile: null, ...extra });

async function installRecordIn(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const vault = new Vault();
  await writeInstallRecord(directory, installRecordBody('acme-shop', 'acme/shop', [
    { id: 'acme-shop-operator', role: 'admin' }, { id: 'acme-shop-master', role: 'coordinator' },
    { id: 'acme-shop-worker-1', role: 'worker' }, { id: 'acme-shop-worker-2', role: 'worker' },
    { id: 'acme-shop-dashboard', role: 'reader' },
  ]), vault);
}

test('unit:up-issues-install-worker-credentials — up\'s accounts step, on an install whose accounts are logged in but whose profiles write found no worker credential, issues the install\'s own worker identities (0600 files in the install directory), writes the profiles and completes without an accounts handoff', async () => {
  const { runUp } = await import('../src/up.js');
  const checkout = await temporaryDirectory('worker-credentials-up');
  const installDir = join(checkout, 'install-dir');
  await mkdir(join(checkout, '.graphyard'), { recursive: true });
  await writeFile(join(checkout, '.graphyard', 'master.json'), JSON.stringify({ version: 1, url: UP_SERVER }), { mode: 0o600 });
  await installRecordIn(installDir);
  const world = accountsWorld(checkout, installDir, { fleetAfterTicks: 2, loggedIn: 2 });
  await world.installWorker('acme-shop-worker-1', 'shop-worker-1');
  await world.installWorker('acme-shop-worker-2', 'shop-worker-2');

  const result = await runUp(request(), world.deps);
  assert.equal(result.exitCode, 0, result.next);
  assert.ok(result.completed.includes('accounts'));
  assert.ok(!result.handoffs.some(entry => entry.step === 'accounts'), 'no sign-in is asked for: the accounts are logged in, the missing profiles were a credential problem');
  // The install's own worker identities, issued as 0600 files in the install directory.
  const issued = { 'acme-shop-worker-1': 'shop-worker-1', 'acme-shop-worker-2': 'shop-worker-2' } as Record<string, string>;
  for (const [id, value] of Object.entries(issued)) {
    const file = join(installDir, 'workers', `${id}.token`);
    assert.equal((await stat(file)).mode & 0o777, 0o600, `${id} is issued 0600`);
    assert.equal((await readFile(file, 'utf8')).trim(), tokenValue(value), 'the issued credential is the install\'s own token, never a generated one');
  }
  assert.equal((await stat(join(installDir, 'workers'))).mode & 0o777, 0o700, 'the install directory\'s workers folder is private');
  assert.ok(!existsSync(join(installDir, 'workers', 'acme-shop-operator.token')), 'only worker identities are issued, never the admin\'s or coordinator\'s');
  // The profiles write ran before and after the issuing, and found the credentials the second time.
  const writes = world.calls.filter(args => args.join(' ') === 'master environments --apply');
  assert.ok(writes.length >= 2, `the profiles write runs again after the issuing (ran ${writes.length} times)`);
  const note = world.events.find(event => event.kind === 'note' && /issued this install's worker credentials/.test(event.text));
  assert.ok(note, 'the run names what it issued');
  await rm(checkout, { recursive: true, force: true });
});

test('unit:up-issues-install-worker-credentials — with credentials the plane refuses, up stops naming the refused files and the plane instead of asking for a sign-in', async () => {
  const { runUp } = await import('../src/up.js');
  const checkout = await temporaryDirectory('worker-credentials-refused');
  const installDir = join(checkout, 'install-dir');
  await mkdir(join(checkout, '.graphyard'), { recursive: true });
  await writeFile(join(checkout, '.graphyard', 'master.json'), JSON.stringify({ version: 1, url: UP_SERVER }), { mode: 0o600 });
  await installRecordIn(installDir);
  await mkdir(join(installDir, 'workers'), { recursive: true, mode: 0o700 });
  await writeFile(join(installDir, 'workers', 'refused-acme-shop-worker-1.token'), tokenValue('rotated-worker-1'), { mode: 0o600 });
  const world = accountsWorld(checkout, installDir, { fleetAfterTicks: 0, loggedIn: 2 });

  const result = await runUp(request(), world.deps);
  assert.equal(result.exitCode, 1, 'a refused credential is a failed run, not a wait');
  assert.match(result.next, new RegExp(`${installDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/workers/refused-acme-shop-worker-1\\.token`), 'the refused file is named');
  assert.match(result.next, /the control plane at http:\/\/127\.0\.0\.1:4310 refuses/, 'the plane is named');
  assert.ok(!result.handoffs.some(entry => entry.step === 'accounts'), 'no sign-in is asked for: a sign-in cannot fix a refused credential');
  await rm(checkout, { recursive: true, force: true });
});

test('unit:up-issues-install-worker-credentials — with no logged-in account, up still hands off the sign-in; once one is signed in the workers are issued and the run completes', async () => {
  const { runUp } = await import('../src/up.js');
  const checkout = await temporaryDirectory('worker-credentials-signin');
  const installDir = join(checkout, 'install-dir');
  await mkdir(join(checkout, '.graphyard'), { recursive: true });
  await writeFile(join(checkout, '.graphyard', 'master.json'), JSON.stringify({ version: 1, url: UP_SERVER }), { mode: 0o600 });
  await installRecordIn(installDir);
  const world = accountsWorld(checkout, installDir, { fleetAfterTicks: 3, loggedIn: 0 });
  await world.installWorker('acme-shop-worker-1', 'shop-worker-1');
  await world.installWorker('acme-shop-worker-2', 'shop-worker-2');

  const result = await runUp(request(), world.deps);
  assert.equal(result.exitCode, 0, result.next);
  const handoff = result.handoffs.find(entry => entry.step === 'accounts');
  assert.ok(handoff, 'the sign-in handoff is raised while no account is logged in');
  assert.match(handoff!.sentence, /Sign in to an AI coding account for worker and reviewer/);
  assert.ok(result.completed.includes('accounts'));
  assert.equal((await stat(join(installDir, 'workers', 'acme-shop-worker-1.token'))).mode & 0o777, 0o600, 'the install\'s workers are issued 0600');
  await rm(checkout, { recursive: true, force: true });
});
