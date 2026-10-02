import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Principal, Work } from '../src/model.js';
import { GitHub } from '../src/github.js';
import { issuePushCredential } from '../src/server/push-credential.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { dispatchWork, loadMasterConfig, masterConfigSchema, setupMaster, type CredentialMinter, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { hostProcessLaunchTargets, readOnlyMountWrapper, sessionMountNamespaceWorks } from '../src/master/profiles.js';
import { roleSessionMaximumMs } from '../src/model/sessions.js';
import { credentialBlockedReason, credentialFailure, refreshWorkerCredential, superviseSessionCredential, sweepExpiredWorkerCredentials, workerCredentialDirectory, workerCredentialRoot, workerCredentialEnvironment, workerPushPermissions, writeWorkerCredential, type MintedPushCredential } from '../src/worker-credential.js';
import { environmentBlocker } from '../src/worker-sandbox.js';
import { attemptRetryHold, maxFailedAttempts, retryBackoffMs } from '../src/daemon/reblocked-attempts.js';
import { expandTypedCommand, startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-999: on 2026-09-30 eleven finished items blocked on "could not read Username for
// 'https://github.com'" and held every worker slot for hours: workers run confined with the session
// bus bound to /dev/null, so `gh` could not reach the keyring the host's login lives in. Each worker
// session now pushes with its own short-lived, repository-scoped credential. One case per proof:
// unit:worker-session-scoped-push-credential, unit:sandboxed-worker-push-without-keyring,
// unit:credential-block-releases-slot.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const token = (label: string) => `ghs_${label}`.padEnd(40, '0');
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const worker: Principal = { id: 'worker-a', role: 'worker' } as Principal;

function item(overrides: Partial<Work> = {}): Work {
  const at = new Date().toISOString();
  return { id: 'work-999', key: 'GY-999', title: 'Sandboxed workers can push', description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Push credential', proofs: ['unit:worker-session-scoped-push-credential'] }],
    policy: { checks: ['test'], review: true }, stage: 'ready', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 3,
    lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [], ...overrides } as Work;
}

/** A master installed in a throwaway repository, its credentials outside it. */
async function installed() {
  const root = await temporaryDirectory('push-credential'), credentials = await temporaryDirectory('push-credential-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'wE' }, coordinatorStatus as typeof fetch);
  const credentialFile = join(credentials, 'worker.token');
  await writeFile(credentialFile, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const profile: WorkerProfile = { name: 'worker-oc', principal: 'worker-a', agentName: 'eng-oc', mode: 'launch', kind: 'opencode', credentialFile, agentArgs: [], approvals: 'auto', environment: {} };
  return { root, credentials, profile, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); } };
}

/** A Herdr stub whose runtimes start at once, recording the tab each launch creates and the line typed into it. */
function herdr() {
  const tabs: string[][] = [], typed: ReturnType<typeof expandTypedCommand>[] = [];
  const run = (_command: string, args: string[]) => {
    if (args[0] === 'tab' && args[1] === 'create') { tabs.push(args); return JSON.stringify({ result: { root_pane: { pane_id: `pane-${tabs.length}`, tab_id: `tab-${tabs.length}` } } }); }
    if (args[0] === 'pane' && args[1] === 'run') typed.push(expandTypedCommand(args[3]));
    return startedAtOnce(args) ?? JSON.stringify({ result: {} });
  };
  return { run, tabs, typed };
}
const tabEnvironment = (args: string[]) => Object.fromEntries(args.flatMap((arg, index) => arg === '--env' ? [args[index + 1].split(/=(.*)/s).slice(0, 2)] : []));
const mode = (path: string) => statSync(path).mode & 0o777;

test('unit:worker-session-scoped-push-credential — a worker launched under its supervisor gets GH_CONFIG_DIR on a session directory holding a repository-scoped credential that expires no later than the lease bound; the files are 0600 and removed when the session ends', async () => {
  const { root, credentials, profile, cleanup } = await installed();
  const realFetch = globalThis.fetch;
  try {
    // The control plane mints for the lease holder only, narrowed to the repository and to push.
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const github = new GitHub({ repository: 'owner/project', base: 'main', appId: 1234, installationId: 5678, privateKey });
    const requests: { url: string; body: any }[] = [];
    let minted = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (!String(url).endsWith('/access_tokens')) return realFetch(url, init);
      requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      minted++;
      return new Response(JSON.stringify({ token: token(`session${minted}`), expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' } }), { status: 201 });
    }) as typeof fetch;
    const now = new Date();
    // Claimed 3.5 hours ago: the implementation time box (4 h) ends before GitHub's one-hour token does.
    const claimedAt = new Date(now.getTime() - roleSessionMaximumMs.implementation + 30 * 60_000).toISOString();
    const leased = (overrides: Partial<Work> = {}) => item({ stage: 'build', epoch: 4, lease: { owner: 'worker-a', epoch: 4, expiresAt: new Date(now.getTime() + 120_000).toISOString() }, lastAssignment: { owner: 'worker-a', epoch: 4, claimedAt }, ...overrides });
    const services = (work: Work) => ({ engine: { store: { list: async () => [work] } }, github, repository: 'owner/project' }) as unknown as Parameters<typeof issuePushCredential>[0];
    const issued = await issuePushCredential(services(leased()), worker, 'GY-999', { epoch: 4 }, now);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.github.com/app/installations/5678/access_tokens');
    assert.deepEqual(requests[0].body, { repositories: ['project'], permissions: { contents: 'write', pull_requests: 'write', workflows: 'write' } }, 'one repository, and only the permissions a push, its pull request and a base sync that touched a workflow need');
    assert.deepEqual(workerPushPermissions, { contents: 'write', pull_requests: 'write', workflows: 'write' });
    const leaseBound = Date.parse(claimedAt) + roleSessionMaximumMs.implementation;
    assert.equal(issued.leaseBound, new Date(leaseBound).toISOString());
    assert.ok(Date.parse(issued.expiresAt) <= leaseBound, 'the credential expires no later than the lease bound');
    assert.equal(issued.expiresAt, issued.leaseBound, 'capped by the bound, which comes before the token\'s own hour');
    assert.equal(issued.repository, 'owner/project');
    // Nobody else is minted one: another principal, another epoch, a lapsed lease, a submitted epoch, an attempt past its time box.
    await assert.rejects(issuePushCredential(services(leased()), { id: 'worker-b', role: 'worker' } as Principal, 'GY-999', { epoch: 4 }, now), /Lease missing, expired, or superseded/);
    await assert.rejects(issuePushCredential(services(leased()), { id: 'reader', role: 'reader' } as Principal, 'GY-999', { epoch: 4 }, now), /Only the worker holding/);
    await assert.rejects(issuePushCredential(services(leased()), worker, 'GY-999', { epoch: 3 }, now), /Lease missing, expired, or superseded/);
    await assert.rejects(issuePushCredential(services(leased({ lease: { owner: 'worker-a', epoch: 4, expiresAt: new Date(now.getTime() - 1).toISOString() } })), worker, 'GY-999', { epoch: 4 }, now), /Lease missing, expired/);
    await assert.rejects(issuePushCredential(services(leased({ submission: { epoch: 4, pr: 9 } } as Partial<Work>)), worker, 'GY-999', { epoch: 4 }, now), /was submitted/);
    await assert.rejects(issuePushCredential(services(leased({ lastAssignment: { owner: 'worker-a', epoch: 4, claimedAt: new Date(now.getTime() - roleSessionMaximumMs.implementation - 1).toISOString() } })), worker, 'GY-999', { epoch: 4 }, now), /outrun its implementation time box/);
    assert.equal(requests.length, 1, 'a refused request mints nothing');

    // The launcher mints before anything starts and hands the session its directory.
    const mints: string[] = [];
    const credential: CredentialMinter = async (_root, input) => { mints.push(`${input.key}@${input.epoch}`); const epoch = input.epoch;
      return writeWorkerCredential(input.directory, await issuePushCredential(services(leased({ epoch, lease: { owner: 'worker-a', epoch, expiresAt: new Date(now.getTime() + 120_000).toISOString() }, lastAssignment: { owner: 'worker-a', epoch, claimedAt } })), worker, input.key, { epoch }, now)); };
    const stub = herdr();
    await dispatchWork(root, item(), profile, [], stub.run, [item()], async () => ({ epoch: 4, path: join(root, 'assigned'), base: 'c'.repeat(40) }), async () => {}, 5_000, new Date().toISOString(), { credential });
    assert.deepEqual(mints, ['GY-999@4']);
    const directory = workerCredentialDirectory(profile.credentialFile!, 'GY-999', 4);
    assert.ok(directory.startsWith(`${credentials}/`) && !directory.startsWith(root), 'the session directory sits beside the worker credential, outside the repository and every worktree');
    const env = tabEnvironment(stub.tabs[0]);
    assert.equal(env.GH_CONFIG_DIR, directory, 'GH_CONFIG_DIR points at the session directory');
    for (const [key, value] of Object.entries(workerCredentialEnvironment(directory))) assert.equal(env[key], value, `the launch environment carries ${key}`);
    assert.equal(env.GH_TOKEN, '', 'a host GH_TOKEN cannot outrank the session credential');
    assert.equal(env.GIT_CONFIG_KEY_0, 'credential.helper');
    assert.equal(env.GIT_CONFIG_VALUE_0, '', 'every host credential helper is reset');
    // The session runs under its watch supervisor — the containment that refreshes and withdraws the credential.
    const words = stub.typed[0].words, watch = words.indexOf('watch');
    assert.deepEqual(words.slice(watch, watch + 4), ['watch', 'GY-999', '4', '--'], 'the runtime starts under the lease supervisor');
    assert.equal(mode(directory), 0o700);
    for (const file of ['hosts.yml', 'config.yml', 'token', 'credential.json']) assert.equal(mode(join(directory, file)), 0o600, `${file} is 0600`);
    assert.match(await readFile(join(directory, 'hosts.yml'), 'utf8'), new RegExp(`oauth_token: ${token('session2')}`));
    const record = JSON.parse(await readFile(join(directory, 'credential.json'), 'utf8'));
    assert.ok(!JSON.stringify(record).includes(token('session2')), 'the record beside the token never repeats it');
    assert.ok(Date.parse(record.expiresAt) <= Date.parse(record.leaseBound));

    // While the session runs, its supervisor refreshes the credential before it expires, revoking
    // the one it replaced; when the session ends, however it ends, the credential is withdrawn.
    const revoked: string[] = [];
    const revoke = async (value: string) => { revoked.push(value); };
    const refreshedAt = new Date(Date.parse(record.expiresAt) - 60_000);
    const exit = await superviseSessionCredential(directory, 'GY-999', 4, async () => ({ ...issued, token: token('refreshed'), expiresAt: record.expiresAt }), async refresh => {
      assert.equal(await refreshWorkerCredential(directory, async () => ({ ...issued, token: token('refreshed') }), { now: refreshedAt, revoke }), 'refreshed');
      await refresh();
      assert.equal(mode(join(directory, 'token')), 0o600, 'a refreshed token is 0600 too');
      assert.equal((await readFile(join(directory, 'token'), 'utf8')).trim(), token('refreshed'));
      return 7;
    }, { revoke });
    assert.equal(exit, 7);
    assert.deepEqual(revoked, [token('session2'), token('refreshed')], 'the replaced token and, at the end, the session\'s own are revoked');
    assert.equal(existsSync(directory), false, 'the session directory is removed when the session ends');
    await assert.rejects(superviseSessionCredential(await (async () => { await writeWorkerCredential(directory, { ...issued, token: token('crashed') }); return directory; })(), 'GY-999', 4, async () => issued, async () => { throw new Error('runtime crashed'); }, { revoke }), /runtime crashed/);
    assert.equal(existsSync(directory), false, 'a session that fails is withdrawn too');

    // A launch that fails after the mint leaves no credential behind.
    const failing = herdr();
    const tabFails = (command: string, args: string[]) => { if (args[0] === 'tab') throw new Error('herdr is down'); return failing.run(command, args); };
    await assert.rejects(dispatchWork(root, item(), { ...profile, agentName: 'eng-oc-2' }, [], tabFails, [item()], async () => ({ epoch: 5, path: join(root, 'assigned-5'), base: 'c'.repeat(40) }), async () => {}, 5_000, new Date().toISOString(), { credential }), /herdr is down/);
    assert.equal(existsSync(workerCredentialDirectory(profile.credentialFile!, 'GY-999', 5)), false, 'a failed launch withdraws the credential it minted');

    // A supervisor killed outright never withdraws its own: the next launch's sweep revokes the
    // expired credential's token before it removes the directory, and leaves a current one alone.
    const stale = workerCredentialDirectory(profile.credentialFile!, 'GY-999', 6), current = workerCredentialDirectory(profile.credentialFile!, 'GY-999', 7);
    await writeWorkerCredential(stale, { ...issued, epoch: 6, token: token('killed'), expiresAt: new Date(Date.now() - 60_000).toISOString() });
    await writeWorkerCredential(current, { ...issued, epoch: 7, token: token('current'), expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const swept: string[] = [];
    assert.deepEqual(await sweepExpiredWorkerCredentials(workerCredentialRoot(profile.credentialFile!), new Date(), async value => { swept.push(value); }), [stale]);
    assert.deepEqual(swept, [token('killed')], 'the expired token is revoked, not merely deleted');
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(current), true, 'a credential still current is kept');
  } finally {
    globalThis.fetch = realFetch;
    await cleanup();
  }
});

test('unit:sandboxed-worker-push-without-keyring — under the containment sandbox (session bus bound to /dev/null) git\'s credential helper path and gh answer with the session credential and never ask the host keyring', async () => {
  const scratch = await temporaryDirectory('push-keyring');
  try {
    // The coordinator checkout with an ssh origin, and the worker's linked worktree on its item branch.
    const coordinator = join(scratch, 'coordinator'), worktree = join(coordinator, '.graphyard', 'worktrees', 'GY-999-4');
    execFileSync('git', ['init', '-q', '-b', 'main', coordinator]);
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'base'], { cwd: coordinator });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:owner/project.git'], { cwd: coordinator });
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'graphyard/gy-999-4', worktree], { cwd: coordinator });

    // The host's own login: a keyring helper in the user's git config that records every time it is asked.
    const home = join(scratch, 'home'), asked = join(scratch, 'keyring-asked');
    await mkdir(join(home, '.config'), { recursive: true });
    const keyring = join(scratch, 'keyring-helper.sh');
    await writeFile(keyring, `#!/bin/sh\necho "$@" >> '${asked}'\nprintf 'username=operator\\npassword=host-keyring-token\\n'\n`, { mode: 0o700 });
    await writeFile(join(home, '.gitconfig'), `[credential]\n\thelper = ${keyring}\n[credential "https://github.com"]\n\thelper = ${keyring}\n`);

    const directory = join(scratch, 'session');
    const now = Date.now();
    await writeWorkerCredential(directory, { key: 'GY-999', epoch: 4, repository: 'owner/project', token: token('sandboxed'), tokenExpiresAt: new Date(now + 3_600_000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(), leaseBound: new Date(now + 4 * 3_600_000).toISOString(), permissions: { ...workerPushPermissions } });

    // The confinement a worker runs in (GY-888): bubblewrap with the checkout read-only and the
    // session bus masked by /dev/null. A host without working bubblewrap runs the same commands
    // with the bus address pointed at /dev/null, which is what the mask leaves a client.
    const bwrap = (process.env.PATH ?? '').split(delimiter).map(entry => join(entry, 'bwrap')).find(candidate => existsSync(candidate)) ?? null;
    const confined = !!bwrap && process.platform === 'linux' && await sessionMountNamespaceWorks(bwrap);
    const wrapper = confined ? [...readOnlyMountWrapper({ coordinatorRoot: coordinator, sessionDirectory: worktree, bwrap })] : [];
    const bus = hostProcessLaunchTargets().busSockets.find(socket => existsSync(socket));
    const base = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1', LANG: 'C', GH_TOKEN: 'host-environment-token', DBUS_SESSION_BUS_ADDRESS: confined && bus ? `unix:path=${bus}` : 'unix:path=/dev/null' };
    const inSandbox = (command: string, args: string[], env: NodeJS.ProcessEnv, input?: string) => {
      const [program, ...rest] = [...wrapper, command, ...args];
      const result = spawnSync(program, rest, { cwd: worktree, env, input, encoding: 'utf8', timeout: 30_000 });
      assert.equal(result.status, 0, `${command} ${args.join(' ')} failed: ${result.stderr}`);
      return result.stdout;
    };
    if (confined && bus) assert.equal(inSandbox('/bin/sh', ['-c', `test -c '${bus}' && echo masked`], base).trim(), 'masked', 'the session bus is /dev/null inside the sandbox');

    // Contrast: without the session credential, git's credential path asks the host keyring.
    const fill = 'protocol=https\nhost=github.com\npath=owner/project.git\n\n';
    assert.match(inSandbox('git', ['credential', 'fill'], base, fill), /password=host-keyring-token/);
    assert.ok(existsSync(asked), 'the fake keyring answers when nothing replaces it');
    await rm(asked);

    // With it: the helper path a `git push` takes answers the session token, and the keyring is never asked.
    const session = { ...base, ...workerCredentialEnvironment(directory) };
    const answered = inSandbox('git', ['credential', 'fill'], session, fill);
    assert.match(answered, /^username=x-access-token$/m);
    assert.match(answered, new RegExp(`^password=${token('sandboxed')}$`, 'm'));
    assert.equal(existsSync(asked), false, 'the host keyring helper is never asked');
    // The item branch is pushed over https, where that credential applies, even from an ssh origin.
    assert.equal(inSandbox('git', ['remote', 'get-url', '--push', 'origin'], session).trim(), 'https://github.com/owner/project.git');
    assert.equal(inSandbox('git', ['rev-parse', '--abbrev-ref', 'HEAD'], session).trim(), 'graphyard/gy-999-4');

    // gh — what `gh pr create` and `gh pr edit` authenticate with — reads the session directory alone.
    const gh = (process.env.PATH ?? '').split(delimiter).map(entry => join(entry, 'gh')).find(candidate => existsSync(candidate));
    if (gh) {
      assert.equal(inSandbox('gh', ['auth', 'token', '--hostname', 'github.com'], session).trim(), token('sandboxed'));
      assert.equal(existsSync(asked), false);
    }
    // gh reads hosts.yml as plain-text storage and leaves the directory as it was written: no keyring migration.
    assert.match(await readFile(join(directory, 'config.yml'), 'utf8'), /^version: "1"$/m);
    assert.match(await readFile(join(directory, 'hosts.yml'), 'utf8'), new RegExp(`^    oauth_token: ${token('sandboxed')}$`, 'm'));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// ---- The loop ends an attempt blocked on a credential failure -----------------------------------

const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
function held(overrides: Partial<Work> = {}): Work {
  return item({ key: 'GY-963', id: 'work-963', stage: 'build', epoch: 1, lease: { owner: 'alpha-principal', epoch: 1, expiresAt: iso(3_600_000) },
    lastAssignment: { owner: 'alpha-principal', epoch: 1, claimedAt: iso(-3_600_000) },
    workspaces: [{ host: 'machine-a', path: '/srv/worktrees/GY-963-1', epoch: 1, owner: 'alpha-principal', branch: 'graphyard/gy-963-1' }], ...overrides } as Partial<Work>);
}

test('unit:credential-block-releases-slot — an attempt blocked only by a GitHub credential failure is ended within one cycle with its committed work kept, and the item is launched again once a credential can be minted', async () => {
  // What the blocked items reported on 2026-09-30, and what they did not: the environment's own
  // write refusals and item decisions are not credential failures.
  for (const blocker of ["git push failed: fatal: could not read Username for 'https://github.com': No such device or address", 'gh pr create: The token in default is invalid.', "remote: Invalid username or token. fatal: Authentication failed for 'https://github.com/owner/project.git/'"])
    assert.ok(credentialFailure(blocker), blocker);
  for (const blocker of ['gh pr edit 530: HTTP 401: Bad credentials (https://api.github.com/graphql)', 'To get started with GitHub CLI, please run:  gh auth login'])
    assert.ok(credentialFailure(blocker), blocker);
  // A generic authentication refusal that names neither GitHub, git nor gh is the item's own.
  for (const blocker of ['needs a product decision on the retry bound', environmentBlocker('sync GY-963', 'claude', { path: '/srv/x/.git/FETCH_HEAD', detail: 'Permission denied' }),
    'the integration test gets HTTP 401 from the billing API: Requires authentication', 'staging answers Bad credentials for the seeded user'])
    assert.equal(credentialFailure(blocker), false, blocker);

  // The ending counts on the retry ladder (GY-885), so a failure no fresh mint cures is bounded:
  // each relaunch waits its backoff, and the third ending in a row holds the item for an approver.
  const ended = (epoch: number, at: number) => ({ role: 'worker', cause: 'interrupted', epoch, profile: 'alpha', account: null, runtime: 'claude', at: iso(at), resetsAt: null,
    reason: credentialBlockedReason({ key: 'GY-963' }, epoch, "fatal: could not read Username for 'https://github.com'") });
  const ladder = (count: number) => ({ submission: null, capacity: { exhaustions: Array.from({ length: count }, (_, index) => ended(index + 1, index * 60_000)) } }) as unknown as Work;
  assert.deepEqual(attemptRetryHold(ladder(1), clock + 60_000)?.kind, 'backoff');
  assert.equal(attemptRetryHold(ladder(1), clock + 60_000)?.resumeAt, clock + retryBackoffMs[0]);
  assert.equal(attemptRetryHold(ladder(maxFailedAttempts), clock + 24 * 3_600_000)?.kind, 'held', 'held at the cap however long it waits');

  const directory = await temporaryDirectory('credential-block');
  try {
    const credentialFile = join(directory, 'coordinator.token'), workerToken = join(directory, 'worker.token');
    await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    await writeFile(workerToken, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const profile = { name: 'alpha', principal: 'alpha-principal', agentName: 'agent-alpha', mode: 'launch', kind: 'claude', credentialFile: workerToken, agentArgs: [], environment: {} } as unknown as WorkerProfile;
    const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
      repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', herdrWorkspace: 'w1',
      masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [profile] });
    const current = { work: [held({ blocker: "git push failed: fatal: could not read Username for 'https://github.com': No such device or address" })] };
    const log = { prompts: [] as string[], closed: [] as string[], capacity: [] as Record<string, unknown>[], preserved: [] as string[] };
    const agent: HerdrAgent = { name: 'agent-alpha', pane_id: 'w1:p9', agent_status: 'idle', agent: 'claude' };
    const effects: DaemonEffects = {
      agents: () => [agent],
      credentials: async profiles => Object.fromEntries(profiles.map(entry => [entry.name, { available: true, reason: null }])),
      snapshot: async () => ({ work: current.work, now: iso(0) }),
      closeSession: pane => { log.closed.push(pane); },
      dispatch: async () => {},
      requestProof: () => {},
      merge: async () => ({ result: 'merge requested' }),
      observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
      recordDeployment: async () => {},
      requestSmoke: () => {},
      persist: async () => {},
      promptSession: (_agent, text) => { log.prompts.push(text); },
      recordSession: async () => {},
      reportCapacity: async (work, event) => {
        log.capacity.push(event);
        current.work = current.work.map(entry => entry.id === work.id ? { ...entry, lease: null, containmentQuarantine: null, ...(event.endsBlocker ? { blocker: null } : {}) } as Work : entry);
        return current.work[0];
      },
      preserveWork: async work => { log.preserved.push(work.key); return { state: 'committed', commit: 'a'.repeat(40), branch: 'graphyard/gy-963-1', detail: 'committed work kept on its branch' }; },
    };
    const state = emptyDaemonState(master);
    // The first cycle that sees the blocker ends the attempt: no clearance, no re-prompt, no wait.
    await runCycle(master, state, effects, () => clock);
    assert.equal(log.capacity.length, 1, 'the attempt is ended on the record in the cycle that sees the blocker');
    const report = log.capacity[0];
    assert.equal(report.cause, 'interrupted');
    assert.equal(report.epoch, 1);
    assert.equal(report.endsBlocker, true, 'its blocker ends with it, so it holds no slot and the item is dispatchable');
    assert.match(String(report.reason), /GitHub credential failure \("git push failed: fatal: could not read Username/);
    assert.match(String(report.reason), /freshly minted push credential/);
    assert.deepEqual(log.preserved, ['GY-963'], 'its work is kept on its branch');
    assert.deepEqual(log.closed, ['w1:p9'], 'its pane is closed');
    assert.equal(log.prompts.length, 0, 'the blocked session is not re-prompted to fail the same way');
    assert.equal(state.actions['resume:credential:work-963:1']?.state, 'done');
    assert.equal(state.actions['resume:blocker:work-963:1'], undefined, 'nothing is left waiting on the blocker');
    assert.equal(current.work[0].lease, null, 'the lease is released');
    assert.equal(current.work[0].blocker, null);
    await runCycle(master, state, effects, () => clock + 30_000);
    assert.equal(log.capacity.length, 1, 'ended once');

    // Any other blocker still waits for its clearance.
    const other = { work: [held({ key: 'GY-964', id: 'work-964', blocker: 'needs a product decision on the retry bound' })] };
    const waiting = emptyDaemonState(master);
    await runCycle(master, waiting, { ...effects, snapshot: async () => ({ work: other.work, now: iso(0) }), reportCapacity: async () => { throw new Error('an item blocker must not end the attempt'); } }, () => clock);
    assert.equal(waiting.actions['resume:blocker:work-964:1']?.state, 'waiting');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  // The next launch mints a fresh credential before anything starts: while none can be minted the
  // launch is refused, its claim released and no session started; once one can, it launches.
  const { root, profile, cleanup } = await installed();
  try {
    const released: number[] = [];
    let mintable = false;
    const credential: CredentialMinter = async (_root, input) => {
      if (!mintable) throw new Error(`Worker launch failed: no push credential could be minted for ${input.key} epoch ${input.epoch} (GitHub returned 503); the item is launched again once one can be`);
      return writeWorkerCredential(input.directory, { key: input.key, epoch: input.epoch, repository: 'owner/project', token: token('fresh'), tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), leaseBound: new Date(Date.now() + 4 * 3_600_000).toISOString(), permissions: { ...workerPushPermissions } });
    };
    let epoch = 1;
    const prepare = async () => ({ epoch: ++epoch, path: join(root, `assigned-${epoch}`), base: 'c'.repeat(40) });
    const refused = herdr();
    await assert.rejects(dispatchWork(root, item(), profile, [], refused.run, [item()], prepare, async (_root, _key, claimed) => { released.push(claimed); }, 5_000, new Date().toISOString(), { credential }), /no push credential could be minted for GY-999 epoch 2/);
    assert.deepEqual(released, [2], 'the claim is released at once, holding no slot');
    assert.equal(refused.tabs.length, 0, 'no session is started without a credential');
    mintable = true;
    const launched = herdr();
    await dispatchWork(root, item(), profile, [], launched.run, [item()], prepare, async (_root, _key, claimed) => { released.push(claimed); }, 5_000, new Date().toISOString(), { credential });
    assert.equal(launched.tabs.length, 1, 'launched once a credential can be minted');
    assert.equal(tabEnvironment(launched.tabs[0]).GH_CONFIG_DIR, workerCredentialDirectory(profile.credentialFile!, 'GY-999', 3));
    assert.deepEqual(released, [2]);
    assert.equal((await loadMasterConfig(root)).repository, 'owner/project');
  } finally {
    await cleanup();
  }
});
