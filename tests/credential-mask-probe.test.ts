import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertCredentialsMasked, CredentialMaskError, credentialMaskFor, masterCredentialMask, readOnlyMountWrapper, type MaskProbe } from '../src/master/confinement.js';
import { prepareConfinedGitPaths } from '../src/master/launch.js';
import { dispatchWork, setupMaster, loadMasterConfig } from '../src/master.js';
import { readAccountStartFailures } from '../src/master/dispatch.js';
import { cycleBaseTip } from '../src/master/worktrees.js';
import { WorkerSandboxError } from '../src/worker-sandbox.js';
import { registryFixture } from './helpers/registry-fixture.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3228: before a session starts, the launch asks the sandbox it built whether it can still
// read a masked credential location that exists. One that can refuses the launch naming the
// path: a host fault recorded as one blocker on the item, never a failed account.

/** A coordinator checkout with one assignment worktree, and a fixture HOME beside it. */
function fixture(base: string) {
  const root = join(base, 'coordinator'), home = join(base, 'home');
  mkdirSync(root, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  const worktree = join(root, '.graphyard', 'worktrees', 'GY-1-1');
  mkdirSync(dirname(worktree), { recursive: true });
  git('worktree', 'add', '-q', '-b', 'graphyard/gy-1-1', worktree);
  prepareConfinedGitPaths(root);
  const secret = (path: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'secret\n', { mode: 0o600 }); return path; };
  return { root, home, worktree, git, secret };
}
/** A probe that answers as the sandbox would if it could still read `leaked`, recording what it was asked. */
const probeReading = (leaked: string[], asked: string[][] = []): MaskProbe & { asked: string[][] } => Object.assign(((_command, args) => {
  const paths = args.slice(args.lastIndexOf('sh') + 1);
  asked.push(paths);
  return paths.filter(path => leaked.includes(path)).map(path => `readable\t${path}\n`).join('');
}) as MaskProbe, { asked });

test('unit:tests/credential-mask-probe.test.ts — a sandbox that can still read a masked path that exists refuses the launch naming it; one that reads none launches', async () => {
  const base = await temporaryDirectory('credential mask probe');
  const savedHome = process.env.HOME;
  try {
    const f = fixture(base);
    process.env.HOME = f.home;
    f.secret(join(f.home, '.ssh', 'id_ed25519'));
    const netrc = f.secret(join(f.home, '.netrc'));
    const own = f.secret(join(f.home, '.config', 'graphyard', 'install', 'workers', 'own.token'));
    const otherAccount = join(f.home, '.coding_agents', 'claude-b'), ownAccount = join(f.home, '.coding_agents', 'claude-a');
    f.secret(join(otherAccount, '.credentials.json')); f.secret(join(ownAccount, '.credentials.json'));
    const extra = f.secret(join(base, 'extra', 'secrets.env'));
    const mask = credentialMaskFor({ confinement: { maskPaths: [extra] }, environments: [{ home: ownAccount }, { home: otherAccount }] }, { credentialFile: own, runtimeHomes: [ownAccount] }, join(f.home, '.config', 'graphyard'));
    const session = { coordinatorRoot: f.root, sessionDirectory: f.worktree, credentialMask: mask };

    // The words: a masked directory becomes an empty unreadable one, a masked file an unreadable empty file.
    const words = readOnlyMountWrapper({ ...session, bwrap: 'bwrap', secretsBus: null }), blank = join(f.worktree, '.graphyard', 'masked');
    const after = (flag: string, path: string) => words.some((word, index) => word === path && words[index - 1] === flag);
    assert.ok(words.some((word, index) => word === join(f.home, '.ssh') && words[index - 1] === '--tmpfs' && words[index - 2] === '0111' && words[index - 3] === '--perms'), 'the SSH directory is an unreadable empty directory');
    assert.ok(after('--tmpfs', otherAccount) && !after('--tmpfs', ownAccount), 'another account\'s home is masked, the session\'s own is not');
    assert.ok(words.some((word, index) => word === netrc && words[index - 1] === blank && words[index - 2] === '--ro-bind'), 'a credential file is replaced by the unreadable empty file');
    assert.equal(statSync(blank).mode & 0o777, 0, 'that file is unreadable');
    assert.ok(!words.includes(join(f.home, '.aws')), 'a default location that does not exist is not masked');

    // A sandbox that reads none of them launches; the probe is asked about every masked path that exists, and never the session's own.
    const clean = probeReading([]);
    await assertCredentialsMasked(words, { ...session, maskProbe: clean });
    assert.equal(clean.asked.length, 1, 'one probe per launch');
    for (const path of [join(f.home, '.ssh'), netrc, otherAccount, extra]) assert.ok(clean.asked[0].includes(path), `${path} is probed`);
    for (const path of [own, ownAccount, join(f.home, '.aws')]) assert.ok(!clean.asked[0].includes(path), `${path} is not probed`);

    // One that still reads a masked path is refused, naming it.
    await assert.rejects(assertCredentialsMasked(words, { ...session, maskProbe: probeReading([netrc]) }), (error: unknown) => error instanceof CredentialMaskError && error instanceof WorkerSandboxError && error.path === netrc && error.message.includes(netrc) && /Host, not the item/.test(error.message));

    // The master's mask keeps its own install directory and hides another install's.
    const masterToken = f.secret(join(f.home, '.config', 'graphyard', 'install', 'tokens', 'master.token'));
    const otherInstall = join(f.home, '.config', 'graphyard', 'other-install');
    f.secret(join(otherInstall, 'tokens', 'other.token'));
    const sharedCli = join(otherInstall, 'deploy', 'build', 'bin', 'graphyard.mjs');
    const master = masterCredentialMask({ credentialFile: masterToken, cliPath: sharedCli, environments: [{ home: ownAccount }, { home: otherAccount }] }, [ownAccount], join(f.home, '.config', 'graphyard'));
    assert.ok(master.hostPaths!.includes(otherInstall) && master.hostPaths!.includes(otherAccount) && master.hostPaths!.includes(join(f.home, '.ssh')), 'another install, another account and the personal credentials are masked');
    assert.ok(!master.hostPaths!.includes(dirname(dirname(masterToken))) && !master.hostPaths!.includes(ownAccount), 'its own install directory and account are kept');
    assert.deepEqual(master.cli, [join(otherInstall, 'deploy', 'build')], 'a CLI run from another install keeps only its checkout');
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    rmSync(base, { recursive: true, force: true });
  }
});

test('unit:tests/credential-mask-probe.test.ts — a worker dispatch whose sandbox still reads a masked path records one blocker naming the path and marks no account failed', async () => {
  const base = await temporaryDirectory('credential mask dispatch');
  const savedPath = process.env.PATH;
  try {
    const f = fixture(base);
    // The sandbox is the injected probe's: a stand-in bubblewrap answers the launch's namespace check on any host.
    mkdirSync(join(base, 'bin'));
    writeFileSync(join(base, 'bin', 'bwrap'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.PATH = `${join(base, 'bin')}:${savedPath}`;
    const leaked = f.secret(join(base, 'collector', 'collector.env'));
    const credentials = join(base, 'credentials');
    mkdirSync(credentials);
    writeFileSync(join(base, 'graphyard.mjs'), 'console.log("{}");\n');
    await setupMaster(f.root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: join(base, 'graphyard.mjs'), credentialDirectory: credentials },
      (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main' }))) as typeof fetch);
    const config = await loadMasterConfig(f.root), credentialFile = join(credentials, 'worker.token');
    writeFileSync(credentialFile, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const profile = { name: 'worker', principal: 'worker', agentName: 'worker', mode: 'launch' as const, kind: 'claude' as const, credentialFile, agentArgs: [], approvals: 'auto' as const, environment: {} };
    config.workers = [profile];
    config.confinement = { maskPaths: [leaked] };
    writeFileSync(join(f.root, '.graphyard/master.json'), JSON.stringify(config));
    const now = new Date().toISOString();
    await cycleBaseTip(f.root, config.baseBranch, now, async () => f.git('rev-parse', 'HEAD'));
    const item = { id: 'work-1', key: 'GY-1', title: 'Bootstrap', type: 'bug', description: '', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Specified work', proofs: ['e2e:fixture'] }],
      policy: { checks: [], review: true }, stage: 'ready', epoch: 0, ready: true, lease: null, blocker: null, workspaces: [], gates: [{ name: 'ready', passed: true, reasons: [] }] } as unknown as Work;
    const registry = registryFixture(config.hostId!, ['claude']);
    const released: (string | undefined)[] = [];
    await assert.rejects(dispatchWork(f.root, item, profile, [], async () => { throw new Error('No runtime should start'); }, [item],
      async () => ({ epoch: 1, path: f.worktree, base: f.git('rev-parse', 'HEAD'), branch: 'graphyard/gy-1-1' }),
      async (_root, _key, _epoch, _profile, blocker) => { released.push(blocker); }, 1, now,
      { probe: registry.probe, maskProbe: probeReading([leaked]), coordinatorRoot: f.root }),
    (error: unknown) => error instanceof CredentialMaskError && error.path === leaked);
    assert.equal(released.length, 1, 'the claim is released once');
    assert.ok(released[0]?.includes(leaked) && released[0].startsWith('Host, not the item:'), `one blocker names the path: ${released[0]}`);
    assert.deepEqual(await readAccountStartFailures(config), {}, 'no account is marked failed');
  } finally {
    process.env.PATH = savedPath;
    rmSync(base, { recursive: true, force: true });
  }
});
