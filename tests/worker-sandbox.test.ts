import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { chmod, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { nonInteractiveLaunch } from '../src/harness.js';
import { accountLaunch, dispatchWork, launchCommandLimit, setupMaster, workAttentionOwner, type WorkerProfile } from '../src/master.js';
import { environmentBlocked, environmentBlocker, environmentFailure, grantWorkerPaths, runtimeSandboxes, verifyWorkerSandbox, WorkerSandboxError, workerPaths, writablePaths, type SandboxExec } from '../src/worker-sandbox.js';
import type { Work } from '../src/model.js';
import { expandTypedCommand, startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-134: a Codex worker could not write its worktree's own Git admin directory, so the mandatory
// `graphyard sync` failed at `git fetch` and the item presented as a ready-gate refusal.

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const workerToken = 'worker-token-'.padEnd(40, 'x');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const codexInstalled = spawnSync('codex', ['--version'], { stdio: 'ignore' }).status === 0;

/** A repository laid out like a Graphyard checkout: an origin, the main clone, and a managed linked worktree. */
async function linkedWorktree(name = 'GY-1-1') {
  const root = await realpath(await temporaryDirectory('sandbox'));
  const origin = join(root, 'origin.git'), main = join(root, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, main], { stdio: 'ignore' });
  git(main, 'config', 'user.email', 't@example.com'); git(main, 'config', 'user.name', 'T');
  await writeFile(join(main, 'README.md'), '# Fixture\n'); git(main, 'add', '.'); git(main, 'commit', '-q', '-m', 'base'); git(main, 'push', '-q', 'origin', 'main');
  const worktree = join(main, '.graphyard/worktrees', name);
  git(main, 'worktree', 'add', '-q', '-b', `graphyard/${name.toLowerCase()}`, worktree);
  git(worktree, 'config', 'user.email', 't@example.com'); git(worktree, 'config', 'user.name', 'T');
  return { root, main, worktree, gitDir: join(main, '.git/worktrees', name), commonDir: join(main, '.git') };
}
const addedDirectories = (args: string[], cwd: string) => args.flatMap((arg, index) => arg === '--add-dir' ? [resolve(cwd, args[index + 1])] : []);

test('unit:worker-sandbox-grants-git-admin-dir — every runtime that takes a sandbox argument grants the worktree and its resolved .git/worktrees/<name> admin directory', async () => {
  const fixture = await linkedWorktree();
  try {
    const paths = workerPaths(fixture.worktree);
    assert.deepEqual(paths, { worktree: fixture.worktree, gitDir: fixture.gitDir, commonDir: fixture.commonDir }, 'the admin directory is read from Git, not guessed');
    // Every runtime whose launch contract selects a sandbox has a grant; none is left to assume one.
    const sandboxed = Object.entries(nonInteractiveLaunch).filter(([, recipe]) => recipe.args.includes('--sandbox')).map(([kind]) => kind);
    assert.deepEqual(sandboxed, ['codex']);
    for (const kind of Object.keys(nonInteractiveLaunch)) {
      const launch = accountLaunch({ kind, approvals: 'auto', agentArgs: [], environment: {} }, null);
      const args = grantWorkerPaths(kind, launch.args, writablePaths(paths), fixture.worktree);
      if (!sandboxed.includes(kind)) { assert.deepEqual(args, launch.args, `${kind} takes no sandbox argument, so nothing is added`); continue; }
      assert.ok(runtimeSandboxes[kind], `${kind} has a sandbox grant`);
      const granted = addedDirectories(args, fixture.worktree);
      assert.ok(granted.includes(fixture.gitDir), `${kind} grants ${fixture.gitDir}: ${args.join(' ')}`);
      assert.ok(granted.includes(join(fixture.commonDir, 'objects')), `${kind} grants the shared object store`);
      // The session starts in the worktree, which the workspace-write sandbox makes writable as its root.
      assert.equal(runtimeSandboxes[kind].mode(args), 'workspace-write');
      assert.equal(new Set(granted).size, granted.length, 'each path is granted once');
      // Already-granted paths are not repeated, and the relative form stays short for the bounded launch line.
      assert.deepEqual(grantWorkerPaths(kind, args, writablePaths(paths), fixture.worktree), args);
      assert.ok(args.includes('../../../.git/worktrees/GY-1-1'), 'the admin directory is written relative to the worktree');
    }
    // A profile that turns the sandbox off, or that is not Codex, is left exactly as configured.
    assert.deepEqual(grantWorkerPaths('codex', ['--sandbox', 'danger-full-access'], writablePaths(paths), fixture.worktree), ['--sandbox', 'danger-full-access']);
    // Real Codex, when this host has it: the old grant (shared directory only) is refused on the
    // admin directory, and the built grant writes every path.
    if (codexInstalled) {
      const base = accountLaunch({ kind: 'codex', approvals: 'auto', agentArgs: [], environment: {} }, null, { writable: [fixture.commonDir] }).args;
      assert.throws(() => verifyWorkerSandbox({ kind: 'codex', args: base }, fixture.worktree, writablePaths(paths)), (error: any) => error instanceof WorkerSandboxError && error.path === fixture.gitDir);
      assert.deepEqual(verifyWorkerSandbox({ kind: 'codex', args: grantWorkerPaths('codex', base, writablePaths(paths), fixture.worktree) }, fixture.worktree, writablePaths(paths)).verified, writablePaths(paths));
    }
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

/**
 * A stand-in for `codex sandbox` that applies Codex's own rule: under workspace-write the session
 * root and each granted path are writable, except the `.git` admin directory a root's `gitdir:`
 * pointer names, which stays read-only unless it is granted itself. The probe script runs for real
 * against every path the sandbox allows.
 */
function codexLikeSandbox(calls: string[][]): SandboxExec {
  return (command, args, options) => {
    calls.push([command, ...args]);
    assert.equal(command, 'codex'); assert.deepEqual(args.slice(0, 4), ['sandbox', '-P', 'graphyard-launch-probe', '-C']);
    const policy = /filesystem=\{(.*)\}$/.exec(args[args.indexOf('-c') + 1])![1];
    const writable = [...policy.matchAll(/"([^"]+)"="write"/g)].map(match => match[1] === ':workspace_roots' ? options.cwd : match[1]);
    // Only a root holding a `.git` of its own is protected; a granted path inside the Git directory holds none.
    const protectedDirs = writable.flatMap(root => { if (!existsSync(join(root, '.git'))) return []; try { return [git(root, 'rev-parse', '--absolute-git-dir')]; } catch { return []; } }).filter(dir => !writable.includes(dir));
    const script = args.slice(args.indexOf('--') + 1), paths = script.slice(4);
    for (const path of paths) {
      const allowed = writable.some(root => path === root || path.startsWith(`${root}/`)) && !protectedDirs.some(dir => path === dir || path.startsWith(`${dir}/`));
      if (!allowed) throw Object.assign(new Error('Command failed: codex sandbox'), { status: 3, stdout: `unwritable\t${path}\tsh: 1: cannot create ${path}/.graphyard-sandbox-probe-1: Read-only file system\n`, stderr: '' });
    }
    return execFileSync(script[0], script.slice(1), { cwd: options.cwd, encoding: 'utf8' });
  };
}

async function dispatchFixture() {
  const fixture = await linkedWorktree('GY-7-1');
  const credentialDirectory = await temporaryDirectory('sandbox-credentials');
  const credential = join(credentialDirectory, 'worker.token'); await writeFile(credential, workerToken, { mode: 0o600 });
  git(fixture.main, 'remote', 'set-url', 'origin', 'https://github.com/owner/project.git');
  await setupMaster(fixture.main, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory }, (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
  const profile: WorkerProfile = { name: 'launch', principal: 'worker-a', agentName: 'eng-a', mode: 'launch', kind: 'codex', credentialFile: credential, agentArgs: [], approvals: 'auto', environment: {} };
  const item = { id: 'id-GY-7', key: 'GY-7', title: 'GY-7', description: '', type: 'feature', priority: 2, dependencies: [], criteria: [], policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'ready', revision: 1, policyRevision: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stageEnteredAt: new Date().toISOString(), ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [] } as unknown as Work;
  return { ...fixture, profile, item, cleanup: async () => { await rm(fixture.root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); } };
}

test('integration:unwritable-workspace-fails-launch — a sandbox that denies the git admin directory fails the launch naming that path, before any session starts, and releases the claim', async () => {
  const fixture = await dispatchFixture();
  try {
    const herdrCalls: string[][] = [], sandboxCalls: string[][] = [], released: number[] = [];
    const herdr = (_command: string, args: string[]) => { herdrCalls.push(args); return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'p1', tab_id: 't1' }, tab: { tab_id: 't1' } } : {} }); };
    const prepare = async () => ({ epoch: 3, path: fixture.worktree, base: 'c'.repeat(40) });
    const release = async (_root: string, _key: string, epoch: number) => { released.push(epoch); };
    // The sandbox denies the admin directory even though the launch grants it.
    const denying: SandboxExec = (command, args, options) => (sandboxCalls.push([command, ...args]), codexLikeSandbox([])(command, args.map(arg => arg.replace(`"${fixture.gitDir}"="write"`, `"${fixture.gitDir}"="read"`)), options));
    await assert.rejects(dispatchWork(fixture.main, fixture.item, fixture.profile, [], herdr, [fixture.item], prepare, release, 1, new Date().toISOString(), { sandbox: denying }),
      (error: any) => { assert.ok(error instanceof WorkerSandboxError, error.message); assert.equal(error.path, fixture.gitDir); assert.match(error.message, new RegExp(`codex sandbox cannot write ${fixture.gitDir.replaceAll('/', '\\/')} .*Read-only file system`)); return true; });
    assert.equal(herdrCalls.length, 0, 'no tab and no session: the worker is never reported started');
    assert.deepEqual(released, [3], 'the claim is released like any failed launch');
    // The probe ran in the sandbox the launch built: every grant of the launch is in its policy.
    const policy = sandboxCalls[0][sandboxCalls[0].indexOf('-c') + 1];
    for (const path of [fixture.gitDir, join(fixture.commonDir, 'objects')]) assert.ok(policy.includes(`"${path}"="write"`), `the probe's policy grants ${path}`);
    assert.ok(!policy.includes(`"${fixture.commonDir}"=`), 'never the common Git directory itself');
    assert.equal(sandboxCalls[0][sandboxCalls[0].indexOf('-C') + 1], fixture.worktree, 'the probe runs in the worktree the session starts in');

    // The same launch in a sandbox that honours the grant starts, and the typed line carries it.
    sandboxCalls.length = 0;
    const started = await dispatchWork(fixture.main, fixture.item, fixture.profile, [], herdr, [fixture.item], prepare, release, 1, new Date().toISOString(), { sandbox: codexLikeSandbox(sandboxCalls) });
    assert.deepEqual(started.sandbox?.verified, writablePaths(workerPaths(fixture.worktree)));
    const typed = herdrCalls.find(args => args[0] === 'pane' && args[1] === 'run')![3];
    assert.ok(Buffer.byteLength(typed) <= launchCommandLimit);
    const launched = expandTypedCommand(typed);
    assert.equal(launched.kind, 'codex');
    assert.ok(addedDirectories(launched.args, fixture.worktree).includes(fixture.gitDir), `the session is started with the admin directory granted: ${launched.args.join(' ')}`);

    // Without the grant (the launcher before GY-134), the same Codex rule refuses the admin directory.
    assert.throws(() => verifyWorkerSandbox({ kind: 'codex', args: ['--sandbox', 'workspace-write', '--add-dir', fixture.commonDir] }, fixture.worktree, writablePaths(workerPaths(fixture.worktree)), codexLikeSandbox([])),
      (error: any) => error.path === fixture.gitDir);
    // A runtime with no sandbox argument is probed from the launcher itself, and a read-only path still fails the launch.
    if (process.getuid?.() !== 0) {
      await chmod(fixture.gitDir, 0o555);
      try { assert.throws(() => verifyWorkerSandbox({ kind: 'claude', args: [] }, fixture.worktree, writablePaths(workerPaths(fixture.worktree))), (error: any) => error instanceof WorkerSandboxError && error.path === fixture.gitDir); }
      finally { await chmod(fixture.gitDir, 0o755); }
    }
  } finally { await fixture.cleanup(); }
});

test('unit:codex-grant-excludes-common-git-dir — a linked worktree\'s codex launch grants the paths the confinement re-exposes writable, never the common Git directory', async () => {
  const fixture = await linkedWorktree('GY-1321-2');
  try {
    // GY-1321: codex 0.160's bwrap creates <root>/.git under every granted root, and the coordinator
    // confinement binds the common Git directory read-only, so granting it killed every command.
    const launch = accountLaunch({ kind: 'codex', approvals: 'auto', agentArgs: [], environment: {} }, null);
    const args = grantWorkerPaths('codex', launch.args, writablePaths(workerPaths(fixture.worktree)), fixture.worktree);
    const granted = addedDirectories(args, fixture.worktree);
    assert.ok(!granted.includes(fixture.commonDir), `no --add-dir names ${fixture.commonDir}: ${args.join(' ')}`);
    assert.ok(!args.includes('../../../.git'), 'nor its relative form');
    const shared = ['objects', 'refs/remotes', 'logs/refs/remotes', 'refs/heads/graphyard', 'logs/refs/heads/graphyard'].map(path => join(fixture.commonDir, path));
    assert.deepEqual(granted, [fixture.gitDir, ...shared], 'the admin directory (FETCH_HEAD, index, HEAD) and the shared paths the confinement re-exposes, each once');
    // A shared path that does not exist is not granted: the confinement re-exposes only existing ones.
    await rm(join(fixture.commonDir, 'logs/refs/remotes'), { recursive: true, force: true });
    assert.ok(!writablePaths(workerPaths(fixture.worktree)).includes(join(fixture.commonDir, 'logs/refs/remotes')));
    // A checkout that is not a linked worktree writes through its own Git directory, which stays granted.
    assert.deepEqual(writablePaths({ worktree: fixture.main, gitDir: fixture.commonDir, commonDir: fixture.commonDir }), [fixture.main, fixture.commonDir]);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('integration:sandbox-probe-inside-confinement-fails-launch — the sandbox probe runs under the launch\'s coordinator-confinement words, and a sandbox that cannot start there fails the launch naming the path and the runtime', async () => {
  const fixture = await dispatchFixture();
  // A bubblewrap on PATH whose namespace probe succeeds, so the launch builds its read-only mount wrapper.
  const bin = join(fixture.root, 'bin'); await mkdir(bin);
  const bwrap = join(bin, 'bwrap'); await writeFile(bwrap, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path}`;
  try {
    const herdrCalls: string[][] = [], probes: string[][] = [], released: number[] = [];
    const herdr = (_command: string, args: string[]) => { herdrCalls.push(args); return startedAtOnce(args) ?? JSON.stringify({ result: {} }); };
    const prepare = async () => ({ epoch: 3, path: fixture.worktree, base: 'c'.repeat(40) });
    const release = async (_root: string, _key: string, epoch: number) => { released.push(epoch); };
    // The confinement refuses the mount point codex's sandbox creates, exactly as on vishrog.
    const refused = `${fixture.commonDir}/.git`;
    const refusing: SandboxExec = (command, args) => {
      probes.push([command, ...args]);
      throw Object.assign(new Error(`Command failed: ${command}`), { status: 1, stdout: '', stderr: `bwrap: Can't create file ${refused}: Read-only file system\n` });
    };
    await assert.rejects(dispatchWork(fixture.main, fixture.item, fixture.profile, [], herdr, [fixture.item], prepare, release, 1, new Date().toISOString(), { sandbox: refusing, coordinatorRoot: fixture.main }),
      (error: any) => {
        assert.ok(error instanceof WorkerSandboxError, error.message);
        assert.equal(error.path, refused, 'the launch names the path the sandbox could not start on');
        assert.equal(error.runtime, 'codex');
        assert.match(error.message, /the codex sandbox cannot write .*inside the coordinator confinement .*Read-only file system/);
        return true;
      });
    assert.equal(herdrCalls.length, 0, 'no tab and no session: the worker is never reported started');
    assert.deepEqual(released, [3], 'the claim is released like any failed launch');
    // The probe ran behind the coordinator confinement: bubblewrap, the checkout read-only, then the codex sandbox.
    const [command, ...args] = probes[0];
    assert.equal(command, 'bwrap', 'the wrapper words the session itself is launched behind');
    const ro = args.indexOf('--ro-bind', args.indexOf('/proc'));
    assert.deepEqual(args.slice(ro, ro + 3), ['--ro-bind', fixture.main, fixture.main]);
    assert.ok(args.includes(fixture.gitDir) && args.includes(join(fixture.commonDir, 'objects')), 'the worker\'s own Git paths are re-exposed writable');
    assert.deepEqual(args.slice(args.indexOf('--') + 1, args.indexOf('--') + 3), ['codex', 'sandbox']);
    assert.ok(!args.some(arg => arg.includes(`"${fixture.commonDir}"="write"`)), 'the probe\'s sandbox never grants the common Git directory');

    // A confinement that lets the sandbox start passes the same probe through to it.
    const wrapper = [bwrap, '--ro-bind', fixture.main, fixture.main, '--'];
    const through: SandboxExec = (cmd, words, options) => { assert.equal(cmd, bwrap); assert.deepEqual(words.slice(0, 4), wrapper.slice(1)); return codexLikeSandbox([])(words[4], words.slice(5), options); };
    const granted = grantWorkerPaths('codex', ['--sandbox', 'workspace-write'], writablePaths(workerPaths(fixture.worktree)), fixture.worktree);
    assert.deepEqual(verifyWorkerSandbox({ kind: 'codex', args: granted, confinement: wrapper }, fixture.worktree, writablePaths(workerPaths(fixture.worktree)), through).verified, writablePaths(workerPaths(fixture.worktree)));
    // A runtime with no sandbox of its own is probed inside the confinement too, not from the launcher.
    const shell: SandboxExec = (cmd, words) => { assert.equal(cmd, bwrap); assert.equal(words[4], '/bin/sh'); throw Object.assign(new Error('failed'), { stdout: `unwritable\t${fixture.gitDir}\tsh: Read-only file system\n`, stderr: '' }); };
    assert.throws(() => verifyWorkerSandbox({ kind: 'claude', args: [], confinement: wrapper }, fixture.worktree, writablePaths(workerPaths(fixture.worktree)), shell), (error: any) => error instanceof WorkerSandboxError && error.path === fixture.gitDir);
  } finally { process.env.PATH = path; await fixture.cleanup(); }
});

async function fakeServer(item: () => any, blocked: any[]) {
  const http = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/status') return res.end(JSON.stringify({ actor: { id: 'worker-a', role: 'worker' }, baseBranch: 'main' }));
      if (req.url === '/api/work') return res.end(JSON.stringify([item()]));
      if (req.url === `/api/work/${item().id}/blocked`) { blocked.push(JSON.parse(body)); return res.end(JSON.stringify({ ...item(), blocker: JSON.parse(body).reason })); }
      res.end(JSON.stringify(item()));
    });
  });
  await new Promise<void>(done => http.listen(0, '127.0.0.1', done));
  const env: NodeJS.ProcessEnv = { ...process.env, GRAPHYARD_URL: `http://127.0.0.1:${(http.address() as any).port}`, GRAPHYARD_TOKEN: 'test-only', GRAPHYARD_HERDR_AGENT_KIND: 'codex' };
  for (const name of ['GRAPHYARD_TOKEN_FILE', 'GRAPHYARD_REQUEST_ID', 'HERDR_ENV', 'GRAPHYARD_GENERATED_FILES']) delete env[name];
  return { env, close: () => new Promise<void>(done => http.close(() => done())) };
}

test('integration:environment-failure-attributed — a sync that fails on a read-only path records a blocker naming the sandbox and the path, and the item presents as the environment', async () => {
  const fixture = await linkedWorktree('GY-1-1');
  const item = { id: 'w1', key: 'GY-1', stage: 'build', ready: true, plannedFiles: ['README.md'], dependencies: [], lease: { owner: 'worker-a', epoch: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    workspaces: [{ epoch: 1, host: 'h', path: fixture.worktree, branch: 'graphyard/gy-1-1' }], observation: null, submission: null, blocker: null };
  const blocked: any[] = [];
  const server = await fakeServer(() => item, blocked);
  // `git fetch` refused exactly as the Codex sandbox refused it on GY-80 and GY-100.
  const shim = join(fixture.root, 'bin'); await mkdir(shim);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  await writeFile(join(shim, 'git'), `#!/bin/sh\nfor a do if [ "$a" = fetch ]; then echo "error: cannot open '${fixture.gitDir}/FETCH_HEAD': Read-only file system" >&2; exit 255; fi; done\nexec ${realGit} "$@"\n`, { mode: 0o755 });
  const sync = (env: NodeJS.ProcessEnv) => exec(process.execPath, [launcher, 'sync', 'GY-1'], { cwd: fixture.worktree, env }).then(result => ({ code: 0, stderr: result.stderr }), (error: any) => ({ code: error.code as number, stderr: `${error.stderr}` }));
  try {
    const result = await sync({ ...server.env, PATH: `${shim}${delimiter}${server.env.PATH}` });
    assert.notEqual(result.code, 0);
    assert.equal(blocked.length, 1, result.stderr);
    assert.equal(blocked[0].epoch, 1);
    assert.match(blocked[0].reason, /^Environment, not the item: the codex sandbox cannot write /);
    assert.ok(blocked[0].reason.includes(`${fixture.gitDir}/FETCH_HEAD`), blocked[0].reason);
    assert.match(blocked[0].reason, /required command 'sync GY-1' failed: .*Read-only file system/);
    assert.match(result.stderr, /Recorded as the blocker on GY-1/);
    // The item presents as the environment, with the launcher's fix, not as a bare gate refusal.
    const owner = workAttentionOwner({ ...item, blocker: blocked[0].reason, gates: [{ name: 'ready', passed: false, reasons: ['Work is blocked'] }] } as unknown as Work, 'gate');
    assert.ok(environmentBlocked(blocked[0].reason));
    // The loop re-checks the path (GY-1008), and while its probe fails the fix is the launcher's grant.
    assert.equal(owner.role, 'control plane');
    assert.match(owner.next, new RegExp(`grant ${fixture.gitDir.replaceAll('/', '\\/')}\\/FETCH_HEAD to the worker's sandbox`));
    assert.doesNotMatch(owner.next, /^Clear the cause/);

    // A real permission refusal on the admin directory, without the shim, is attributed the same way.
    if (process.getuid?.() !== 0) {
      await chmod(fixture.gitDir, 0o555);
      try { const denied = await sync(server.env); assert.notEqual(denied.code, 0); } finally { await chmod(fixture.gitDir, 0o755); }
      assert.equal(blocked.length, 2);
      assert.ok(blocked[1].reason.startsWith(`Environment, not the item: the codex sandbox cannot write ${fixture.gitDir}/`), blocked[1].reason);
      assert.match(blocked[1].reason, /Permission denied/);
    }
    // Any other failure is the item's own and records nothing.
    assert.equal(environmentFailure(new Error('git merge failed without a conflict to resolve: not something we can merge')), null);
    assert.deepEqual(environmentFailure(Object.assign(new Error('EROFS: read-only file system, open'), { code: 'EROFS', path: '.git/index.lock' }), '/w'), { path: '/w/.git/index.lock', detail: 'EROFS: read-only file system, open' });
    assert.equal(environmentFailure(new Error("fatal: Unable to create '/r/.git/worktrees/x/index.lock': Read-only file system."))?.path, '/r/.git/worktrees/x/index.lock');
    assert.match(environmentBlocker('sync GY-9', undefined, { path: '/p', detail: 'd' }), /the worker sandbox cannot write \/p/);
  } finally { await server.close(); await rm(fixture.root, { recursive: true, force: true }); }
});
