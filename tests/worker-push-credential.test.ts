import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Principal, Work } from '../src/model.js';
import { GitHub } from '../src/github.js';
import { issuePushCredential } from '../src/server/push-credential.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { dispatchWork, loadMasterConfig, masterConfigSchema, setupMaster, type CredentialMinter, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { bwrapOnPath, hostProcessLaunchTargets, readOnlyMountWrapper, sessionMountNamespaceWorks } from '../src/master/profiles.js';
import { roleSessionMaximumMs } from '../src/model/sessions.js';
import { credentialBlockedReason, credentialFailure, grantedPushPermissions, refreshWorkerCredential, revokeInstallationToken, withdrawWorkerCredential, superviseSessionCredential, sweepExpiredWorkerCredentials, workerCredentialDirectory, workerCredentialRoot, workerCredentialEnvironment, workerPushPermissions, writeWorkerCredential, type MintedPushCredential } from '../src/worker-credential.js';
import { installationOwner } from '../src/master/attention.js';
import { environmentBlocker } from '../src/worker-sandbox.js';
import { attemptRetryHold, maxFailedAttempts, retryBackoffMs } from '../src/daemon/reblocked-attempts.js';
import { expandTypedCommand, startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// Time-bomb allowance (GY-1694): the 2030-01-01 clock is the loop's injected now and the snapshot's now iso(0), so held() leases are judged against it; Date.now() mints token expiries and credentials swept with new Date().

// GY-999: on 2026-09-30 eleven finished items blocked on "could not read Username for
// 'https://github.com'" and held every worker slot for hours: workers run confined with the session
// bus bound to /dev/null, so `gh` could not reach the keyring the host's login lives in. Each worker
// session now pushes with its own short-lived, repository-scoped credential. One case per proof:
// unit:worker-session-scoped-push-credential, unit:sandboxed-worker-push-without-keyring,
// unit:credential-block-releases-slot. GY-1100 adds unit:mint-requests-granted-subset.

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
    // session bus masked by /dev/null — a worker carries its own credential, so the keyring-only
    // proxy is never bound in (GY-1039). A host without working bubblewrap runs the same commands
    // with the bus address pointed at /dev/null, which is what the mask leaves a client.
    const bwrap = (process.env.PATH ?? '').split(delimiter).map(entry => join(entry, 'bwrap')).find(candidate => existsSync(candidate)) ?? null;
    const confined = !!bwrap && process.platform === 'linux' && await sessionMountNamespaceWorks(bwrap);
    const wrapper = confined ? [...readOnlyMountWrapper({ coordinatorRoot: coordinator, sessionDirectory: worktree, bwrap, ownGitHubCredential: true })] : [];
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

test('unit:worker-without-credential-no-keyring — a worker launched without a minted credential still gets no route to the operator\'s keyring: it has no GitHub credential at all, never the host\'s login (GY-1039)', async () => {
  const { root, profile, cleanup } = await installed();
  const runtime = await temporaryDirectory('kr');
  const server = createServer();
  const saved = { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, GRAPHYARD_SECRETS_BUS: process.env.GRAPHYARD_SECRETS_BUS };
  try {
    // A live keyring-only proxy beside the session bus: a coordination session would be given it.
    const bus = join(runtime, 'bus'), proxy = join(runtime, 'graphyard-secrets-bus'), assigned = join(root, 'assigned');
    await writeFile(bus, ''); await mkdir(assigned, { recursive: true });
    await new Promise<void>(done => server.listen(proxy, done));
    process.env.XDG_RUNTIME_DIR = runtime; delete process.env.GRAPHYARD_SECRETS_BUS;
    const replacement = (words: readonly string[]) => words[words.indexOf(realpathSync(bus)) - 1];
    assert.equal(replacement(readOnlyMountWrapper({ coordinatorRoot: root, sessionDirectory: assigned })), realpathSync(proxy), 'the proxy is live and bound for a session that may read the keyring');
    // No minter: an injected preparer and no `credential` option, so nothing is minted for the attempt.
    // The stub's runtime is opencode whatever leads the typed line: here the supervisor's prefix, then the confinement.
    const stub = herdr(), started = stub.run;
    stub.run = (command: string, args: string[]) => args[0] === 'pane' && args[1] === 'run' ? (started(command, args), startedAtOnce(['pane', 'run', '', 'opencode']) ?? '') : started(command, args);
    const bwrap = bwrapOnPath();
    const confined = process.platform === 'linux' && !!bwrap && await sessionMountNamespaceWorks(bwrap);
    const launch = dispatchWork(root, item(), profile, [], stub.run, [item()], async () => ({ epoch: 4, path: assigned, base: 'c'.repeat(40) }), async () => {}, 5_000, new Date().toISOString(), { coordinatorRoot: root });
    if (!confined) { await assert.rejects(launch, /never starts a session unconfined/, 'a host that cannot confine refuses the worker'); return; }
    await launch;
    assert.equal(tabEnvironment(stub.tabs[0]).GH_CONFIG_DIR, undefined, 'no credential was minted for this worker');
    const words = stub.typed[0].words, wrapper = words.findIndex(word => /(^|\/)bwrap$/.test(word));
    assert.ok(wrapper > words.indexOf('watch') && words[words.indexOf('--', wrapper) + 1] === 'opencode', 'the worker runs confined under its supervisor, its runtime inside the wrapper');
    assert.equal(replacement(words), '/dev/null', 'its session bus stays unconnectable');
    assert.ok(!words.includes(realpathSync(proxy)), 'the keyring proxy is bound nowhere in its namespace');
  } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await new Promise<void>(done => server.close(() => done()));
    await cleanup();
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

test('unit:mint-requests-granted-subset — when the installation lacks a wanted permission the mint asks for the granted subset and succeeds, and attention names the missing permission and installation-accept; when every wanted permission is granted the token carries all of them', async () => {
  // GY-1100: hotfix 7ef4cb702d added workflows: write to the wanted set while installation
  // 161493384 did not grant it; GitHub refused every mint with 422 and no worker could launch.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const realFetch = globalThis.fetch;
  let granted: Record<string, string> = { contents: 'write', pull_requests: 'write', metadata: 'read', checks: 'write', actions: 'write', issues: 'read', administration: 'read' };
  const installationReads: string[] = [], mints: Record<string, string>[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.includes('/rules/branches/')) return new Response('[]', { status: 200 });
    if (path.endsWith('/access_tokens') && !init?.body) return new Response(JSON.stringify({ token: token('client'), expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: {} }), { status: 201 });
    if (path.endsWith('/app/installations/5678')) { installationReads.push(path); return new Response(JSON.stringify({ app_slug: 'graphyard-test', html_url: 'https://github.com/settings/installations/5678', permissions: granted }), { status: 200 }); }
    if (path.endsWith('/access_tokens') && init?.body) {
      const asked: Record<string, string> = JSON.parse(String(init.body)).permissions;
      mints.push(asked);
      // GitHub's own rule: one permission the installation lacks refuses the whole mint.
      if (Object.entries(asked).some(([permission, level]) => granted[permission] !== level && !(granted[permission] === 'write' && level === 'read'))) return new Response('{"message":"The permissions requested are not granted to this installation."}', { status: 422 });
      return new Response(JSON.stringify({ token: token(`mint${mints.length}`), expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: { ...asked, metadata: 'read' } }), { status: 201 });
    }
    return realFetch(url, init);
  }) as typeof fetch;
  try {
    const github = new GitHub({ repository: 'owner/project', base: 'main', appId: 1234, installationId: 5678, privateKey });
    const pushLine = (report: { attention: string[] } | null) => report?.attention.filter(line => /worker push credentials/.test(line)) ?? [];

    // Lacking workflows, before any preflight: the installation is read and the subset minted.
    const subset = await github.mintPushToken();
    assert.deepEqual(mints.at(-1), { contents: 'write', pull_requests: 'write' }, 'only the granted subset is requested');
    assert.deepEqual(subset.permissions, { contents: 'write', pull_requests: 'write', metadata: 'read' });
    assert.equal(installationReads.length, 1);
    const report = await github.preflight();
    const [line] = pushLine(report);
    assert.ok(line, 'the shortfall is raised as attention');
    assert.match(line, /workflows: write/, 'attention names the missing permission');
    assert.match(line, /master browser installation-accept/, 'attention names the installation-accept remedy');
    assert.match(line, /https:\/\/github\.com\/settings\/installations\/5678/);
    assert.match(installationOwner('app-permissions', line).next, /installation-accept/, 'the master owns it with the installation-accept step');
    // After a preflight the mint reads its verified grants and spends no installation read.
    const reads = installationReads.length;
    await github.mintPushToken();
    assert.deepEqual(mints.at(-1), { contents: 'write', pull_requests: 'write' });
    assert.equal(installationReads.length, reads);
    assert.equal(pushLine(github.permissionReport()).length, 1, 'the line is raised once, not once per mint');

    // Everything granted: the token carries every wanted permission and no attention remains.
    granted = { ...granted, workflows: 'write' };
    const full = await github.preflight();
    assert.deepEqual(pushLine(full), []);
    const all = await github.mintPushToken();
    assert.deepEqual(mints.at(-1), { ...workerPushPermissions });
    for (const [permission, level] of Object.entries(workerPushPermissions)) assert.equal(all.permissions[permission], level, `the token carries ${permission}: ${level}`);

    // Revoked since the last preflight: the 422 re-reads the installation once and mints the subset.
    const { workflows: _revoked, ...withoutWorkflows } = granted; granted = withoutWorkflows;
    const before = mints.length;
    const recovered = await github.mintPushToken();
    assert.deepEqual(mints.slice(before), [{ ...workerPushPermissions }, { contents: 'write', pull_requests: 'write' }]);
    assert.equal(recovered.permissions.workflows, undefined);
    assert.equal(pushLine(github.permissionReport()).length, 1, 'the re-read shortfall is raised at once');

    // The pure rule: granted levels at most what is wanted; nothing granted at all is a shortfall per permission.
    assert.deepEqual(grantedPushPermissions({ contents: 'admin', pull_requests: 'read' }), { permissions: { contents: 'write', pull_requests: 'read' }, missing: [{ permission: 'pull_requests', wanted: 'write', granted: 'read' }, { permission: 'workflows', wanted: 'write', granted: null }] });
    // Without Contents: write a worker cannot push at all, so that mint is refused with the installation to fix.
    granted = { pull_requests: 'write', metadata: 'read' };
    await github.preflight();
    await assert.rejects(github.mintPushToken(), /grants no Contents: write/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('unit:push-mint-falls-back-without-workflows — an installation that has not accepted workflows still mints the contents and pull_requests credential instead of refusing every launch', async () => {
  const realFetch = globalThis.fetch;
  try {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const github = new GitHub({ repository: 'owner/project', base: 'main', appId: 1234, installationId: 5678, privateKey });
    const asked: Record<string, string>[] = [];
    // No merge-queue ruleset, so the bypass check (GY-1066) passes and the mint itself is what is judged.
    (github as any).request = async () => [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      // GY-1100: the installation's grants are read first, so the mint never asks for what it lacks.
      if (String(url).endsWith('/app/installations/5678')) return new Response(JSON.stringify({ permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' } }), { status: 200 });
      if (!String(url).endsWith('/access_tokens')) return realFetch(url, init);
      const { permissions } = JSON.parse(String(init!.body));
      asked.push(permissions);
      if (permissions.workflows) return new Response(JSON.stringify({ message: 'The permissions requested are not granted to this installation.' }), { status: 422 });
      return new Response(JSON.stringify({ token: token('fallback'), expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions }), { status: 201 });
    }) as typeof fetch;
    const minted = await github.mintPushToken();
    assert.deepEqual(asked, [{ contents: 'write', pull_requests: 'write' }], 'only the granted subset is asked, with no refused round trip');
    assert.deepEqual(minted.permissions, { contents: 'write', pull_requests: 'write' });
  } finally { globalThis.fetch = realFetch; }
});

// ---- GY-1066: the review follow-ups of GY-999 ----------------------------------------------------

test('GY-1066 — no worker token from a merge-queue bypass App, the lease checked again after the mint, and a token kept until GitHub confirms its revocation', async () => {
  const realFetch = globalThis.fetch;
  const directory = await temporaryDirectory('push-credential-followups');
  try {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    let rules: unknown = [], ruleset: unknown = null, rulesetStatus = 404, mints = 0, revokeStatus = 204;
    const revocations: string[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/rules/branches/')) return new Response(JSON.stringify(rules), { status: 200 });
      if (/\/rulesets\/\d+$/.test(target)) return ruleset ? new Response(JSON.stringify(ruleset), { status: 200 }) : new Response('{"message":"unavailable"}', { status: rulesetStatus });
      if (target.endsWith('/app/installations/5678')) return new Response(JSON.stringify({ permissions: { ...workerPushPermissions, metadata: 'read' } }), { status: 200 });
      if (target.endsWith('/installation/token')) { revocations.push(String((init?.headers as Record<string, string>).Authorization)); return new Response(null, { status: revokeStatus }); }
      if (!target.endsWith('/access_tokens')) throw new Error(`unexpected request ${target}`);
      if (!init?.body) return new Response(JSON.stringify({ token: token('client'), expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: {} }), { status: 201 });
      mints++;
      return new Response(JSON.stringify({ token: token(`mint${mints}`), expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: workerPushPermissions }), { status: 201 });
    }) as typeof fetch;

    // 1. A merge queue that lets this App bypass it — or whose bypass cannot be read — mints nothing.
    const github = new GitHub({ repository: 'owner/project', base: 'main', appId: 1234, installationId: 5678, privateKey });
    rules = [{ type: 'merge_queue', ruleset_id: 77, parameters: {} }];
    ruleset = { id: 77, bypass_actors: [{ actor_id: 1234, actor_type: 'Integration', bypass_mode: 'pull_request' }] };
    await assert.rejects(github.mintPushToken(), /App 1234 is a bypass actor of the merge queue on main \(ruleset 77\)/);
    ruleset = { id: 77, current_user_can_bypass: 'pull_requests_only' };
    await assert.rejects(github.mintPushToken(), /may bypass the merge queue on main \(ruleset 77: pull_requests_only\)/);
    ruleset = null;
    await assert.rejects(github.mintPushToken(), (error: any) => error.status === 409 && /bypass actors of the merge queue on main \(ruleset 77\) cannot be read/.test(error.message)
      && /no worker can launch on this repository until workers push as an App the queue does not exempt/.test(error.message));
    // A ruleset GitHub fails to answer transiently is retryable (502), never the standing policy refusal.
    for (const status of [500, 503]) {
      rulesetStatus = status;
      await assert.rejects(github.mintPushToken(), (error: any) => error.status === 502 && /ruleset 77\) could not be read now .*ask again/.test(error.message), `HTTP ${status}`);
    }
    rulesetStatus = 404;
    assert.equal(mints, 0, 'nothing is minted from a bypass App');
    ruleset = { id: 77, current_user_can_bypass: 'never', bypass_actors: [{ actor_id: 9, actor_type: 'Integration', bypass_mode: 'always' }] };
    assert.equal((await github.mintPushToken()).token, token('mint1'), 'a queue this App cannot bypass leaves the worker its credential');
    rules = [];
    assert.equal((await github.mintPushToken()).token, token('mint2'), 'a base with no merge queue (a user-owned repository) is unaffected');

    // 2. The lease moves while GitHub mints: nothing is answered, and the fresh token is revoked.
    const now = new Date();
    const leased = item({ stage: 'build', epoch: 4, lease: { owner: 'worker-a', epoch: 4, expiresAt: new Date(now.getTime() + 120_000).toISOString() }, lastAssignment: { owner: 'worker-a', epoch: 4, claimedAt: now.toISOString() } });
    const moves: Record<string, Work> = {
      submitted: { ...leased, submission: { epoch: 4, pr: 9 } } as Work,
      superseded: { ...leased, epoch: 5, lease: { owner: 'worker-b', epoch: 5, expiresAt: leased.lease!.expiresAt } } as Work,
      released: { ...leased, lease: null } as Work,
    };
    for (const [name, moved] of Object.entries(moves)) {
      let reads = 0;
      const services = { engine: { store: { workDocument: async () => reads++ === 0 ? leased : moved } }, github, repository: 'owner/project' } as unknown as Parameters<typeof issuePushCredential>[0];
      const revoked: string[] = [];
      await assert.rejects(issuePushCredential(services, worker, 'GY-999', { epoch: 4 }, now, async value => { revoked.push(value); }), /was submitted|Lease missing, expired, or superseded/, name);
      assert.deepEqual(revoked, [token(`mint${mints}`)], `the token minted for a ${name} lease is revoked`);
    }
    const kept = { engine: { store: { workDocument: async () => leased } }, github, repository: 'owner/project' } as unknown as Parameters<typeof issuePushCredential>[0];
    assert.equal((await issuePushCredential(kept, worker, 'GY-999', { epoch: 4 }, now, async () => { throw new Error('a held lease revokes nothing'); })).token, token(`mint${mints}`));

    // 3. Revocation is confirmed only by GitHub's 204 (or a 401: the token no longer authenticates).
    revokeStatus = 204; await revokeInstallationToken(token('a'));
    revokeStatus = 401; await revokeInstallationToken(token('b'));
    for (const status of [500, 429, 403]) { revokeStatus = status; await assert.rejects(revokeInstallationToken(token('c')), new RegExp(`HTTP ${status}`)); }
    assert.equal(revocations.length, 5);

    // A withdrawal GitHub does not confirm keeps the token to retry; the session's own files go.
    const session = join(directory, 'GY-999-4');
    const minted: MintedPushCredential = { key: 'GY-999', epoch: 4, repository: 'owner/project', token: token('session'), tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(), leaseBound: new Date(Date.now() - 60_000).toISOString(), permissions: workerPushPermissions };
    await writeWorkerCredential(session, minted);
    const failing = async () => { throw new Error('HTTP 502'); };
    assert.equal(await withdrawWorkerCredential(session, failing), 'retained');
    assert.equal(existsSync(join(session, 'token')), false, 'the session can no longer read the token');
    assert.equal(existsSync(join(session, 'credential.json')), false);
    assert.equal(mode(join(session, 'revoke.json')), 0o600, 'the token still to revoke is kept 0600');
    // The sweep retries it: still refused, it stays; confirmed, the directory goes.
    assert.deepEqual(await sweepExpiredWorkerCredentials(directory, new Date(), failing), []);
    assert.equal(existsSync(session), true);
    const swept: string[] = [];
    assert.deepEqual(await sweepExpiredWorkerCredentials(directory, new Date(), async value => { swept.push(value); }), [session]);
    assert.deepEqual(swept, [token('session')]);
    assert.equal(existsSync(session), false);
    // Once GitHub's own expiry of the token has passed, nothing is left to revoke.
    await writeWorkerCredential(session, minted);
    assert.equal(await withdrawWorkerCredential(session, failing), 'retained');
    assert.equal(await withdrawWorkerCredential(session, failing, new Date(Date.parse(minted.tokenExpiresAt) + 1)), 'withdrawn');
    assert.equal(existsSync(session), false);

    // A refresh whose old token GitHub does not confirm revoking keeps it and retries at the next refresh.
    const live = { ...minted, expiresAt: new Date(Date.now() + 60_000).toISOString(), leaseBound: new Date(Date.now() + 3_600_000).toISOString() };
    await writeWorkerCredential(session, live);
    assert.equal(await refreshWorkerCredential(session, async () => ({ ...live, token: token('second') }), { revoke: failing }), 'refreshed');
    assert.equal(JSON.parse(await readFile(join(session, 'revoke.json'), 'utf8'))[0].token, token('session'));
    const retried: string[] = [];
    assert.equal(await refreshWorkerCredential(session, async () => ({ ...live, token: token('third') }), { revoke: async value => { retried.push(value); } }), 'refreshed');
    assert.deepEqual(retried, [token('session'), token('second')]);
    assert.equal(existsSync(join(session, 'revoke.json')), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
