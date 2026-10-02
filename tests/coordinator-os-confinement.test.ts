import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/** Whether `path` is a directory; mirrors the launcher's own check for re-exposed paths. */
const isDirectory = (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } };
import { bwrapOnPath, coordinatorConfinement, coordinatorConfinementRefusal, hostProcessLaunchTargets, processLaunchMaskWords, readOnlyMountWrapper, secretsBusEndpointProblem, secretsBusMigration, secretsBusPath, secretsBusUnjudged, sessionMountNamespaceWorks, workerConfinementRefusal } from '../src/master/profiles.js';
import { createServer } from 'node:net';
import { headlessConfinementWrapper, keyringEndpointWarning, launcherCoordinatorRoot, launcherRootUndetermined, prepareConfinedGitPaths, sessionConfinement, startAgentSession } from '../src/master/launch.js';
import { confiningSpawn } from '../src/runner/roles.js';
import { expandTypedCommand, startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-888: every session the launcher starts — worker, reviewer, producer and approver, in a Herdr
// pane or headless — is launched so that the coordinator checkout is unwritable at the OS level,
// shell commands included. A runtime with a workspace-write sandbox is confined by its sandbox
// only while the checkout lies outside every path the sandbox grants; every other runtime runs
// inside a bubblewrap mount namespace that mounts the checkout read-only, unshares PIDs and mounts
// a fresh /proc (another process's /proc/<pid>/root is not a route back), and re-exposes only the
// session's own worktree, its own Git admin directory and the shared Git areas it writes. A launch
// that can carry no confinement is refused with the reason named, never started unconfined.

/** A coordinator checkout with a linked assignment worktree under it, exactly as the launcher prepares them. */
function coordinatorFixture(base: string) {
  const root = join(base, 'coordinator');
  const run = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 1;\n');
  run('init', '-b', 'main');
  run('config', 'user.email', 'graphyard@localhost');
  run('config', 'user.name', 'Graphyard');
  run('add', '.');
  run('commit', '-m', 'coordinator');
  const worktree = join(root, '.graphyard', 'worktrees', 'session');
  mkdirSync(dirname(worktree), { recursive: true });
  run('worktree', 'add', '-b', 'graphyard/gy-888-1', worktree, 'main');
  prepareConfinedGitPaths(root);
  return { root, worktree };
}

test('unit:coordinator-write-blocked-for-shell — every runtime kind launches confined, and a confined shell cannot write, commit in or switch the coordinator checkout by any means', async () => {
  const base = await temporaryDirectory('confinement');
  try {
    const { root, worktree } = coordinatorFixture(base);
    // Every runtime kind builds a launch whose confinement is present, by the mechanism its runtime
    // supports. `bwrap` is named explicitly so these words do not depend on the host's PATH.
    const build = (kind: string, args: string[], sessionDirectory: string = worktree) =>
      coordinatorConfinement({ kind, args, coordinatorRoot: root, sessionDirectory, platform: 'linux', mountNamespaceWorks: true, bwrap: 'bwrap' });
    for (const [kind, args] of [['claude', []], ['cursor', []], ['opencode', []], ['pi', []], ['codex', ['--sandbox', 'workspace-write']]] as [string, string[]][]) {
      const confinement = await build(kind, args);
      assert.ok(confinement, `${kind} launches confined`);
      if (kind === 'codex') {
        assert.equal(confinement.mechanism, 'runtime-sandbox', 'the codex workspace-write sandbox is the confinement');
        assert.deepEqual(confinement.wrapper, [], 'the runtime sandbox needs no wrapper words');
      } else {
        assert.equal(confinement.mechanism, 'read-only-mount', `${kind} uses read-only-mount mechanism`);
        const rootIdx = confinement.wrapper.indexOf(root);
        assert.ok(rootIdx > 0 && confinement.wrapper[rootIdx - 1] === '--ro-bind' && confinement.wrapper[rootIdx + 1] === root, `${kind} binds ${root} read-only with correct arguments`);
        const worktreeIdx = confinement.wrapper.indexOf(worktree);
        assert.ok(worktreeIdx > 0 && confinement.wrapper[worktreeIdx - 1] === '--bind', `${kind} re-exposes ${worktree} with --bind`);
        assert.equal(confinement.wrapper.at(-1), '--', `${kind}'s wrapper ends with --`);
        // The namespace is pid-isolated with a fresh /proc: another process's root view is not reachable.
        assert.ok(confinement.wrapper.includes('--unshare-pid') && confinement.wrapper.includes('--proc') && confinement.wrapper.includes('/proc'), `${kind}'s namespace isolates /proc`);
        // Only the session's own Git admin directory is re-exposed, never every assignment's.
        const gitDir = join(root, '.git');
        assert.ok(confinement.wrapper.includes(join(gitDir, 'worktrees', 'session')), `${kind} binds its own worktree admin directory`);
        assert.ok(!confinement.wrapper.includes(join(gitDir, 'worktrees')), `${kind} does not unprotect every assignment's admin directory`);
        assert.ok(confinement.wrapper.includes(join(gitDir, 'logs', 'refs', 'remotes')), `${kind} keeps remote-tracking reflogs writable, so git fetch can record a new remote branch`);
      }
    }
    // A codex runtime without its workspace-write sandbox carries the mount namespace instead: it is never launched unconfined.
    const unconfinedCodex = await build('codex', ['--sandbox', 'danger-full-access']);
    assert.equal(unconfinedCodex?.mechanism, 'read-only-mount', 'a codex sandbox turned off falls back to the read-only mount');
    // A codex workspace-write sandbox is NOT the confinement when a path it grants would hold the
    // checkout: a terminal reviewer or producer runs from the coordinator root, and a --add-dir
    // may name it — those launches carry the mount wrapper like any other runtime.
    const workspaceRoot = await build('codex', ['--sandbox', 'workspace-write'], root);
    assert.equal(workspaceRoot?.mechanism, 'read-only-mount', 'codex running from the coordinator root is mount-confined, not sandbox-confined');
    const addDirRoot = await build('codex', ['--sandbox', 'workspace-write', '--add-dir', root]);
    assert.equal(addDirRoot?.mechanism, 'read-only-mount', 'a codex --add-dir naming the checkout gives up the sandbox claim');
    const addDirOutside = await build('codex', ['--sandbox', 'workspace-write', '--add-dir', worktree]);
    assert.equal(addDirOutside?.mechanism, 'runtime-sandbox', 'a codex --add-dir outside the checkout keeps the sandbox claim');
    // A worker launch grants the coordinator's common Git directory so its runtime can commit —
    // that grant covers the coordinator's own refs, index and reflogs, so it gives up the sandbox
    // claim and carries the mount wrapper, which re-exposes only the session's own Git paths.
    const addDirGitAdmin = await build('codex', ['--sandbox', 'workspace-write', '--add-dir', join(root, '.git')]);
    assert.equal(addDirGitAdmin?.mechanism, 'read-only-mount', 'a codex --add-dir of the coordinator Git admin gives up the sandbox claim');
    const addDirForeignAdmin = await build('codex', ['--sandbox', 'workspace-write', '--add-dir', join(root, '.git', 'worktrees')]);
    assert.equal(addDirForeignAdmin?.mechanism, 'read-only-mount', 'a codex --add-dir covering every assignment\'s admin directory gives up the sandbox claim');
    assert.ok(await coordinatorConfinementRefusal({ kind: 'codex', args: ['--sandbox', 'workspace-write'], coordinatorRoot: root, sessionDirectory: root, platform: 'darwin', bwrap: 'bwrap' }), 'a codex workspace holding the checkout is refused where no mount namespace can be built');
    // A session directory that is not itself a linked worktree (a headless producer's checkout)
    // keeps the whole worktrees area writable, because it creates worktrees of its own.
    const producerDirectory = join(root, '.graphyard', 'producer-checkout');
    mkdirSync(producerDirectory, { recursive: true });
    const producer = await build('pi', [], producerDirectory);
    assert.ok(producer, 'the producer checkout launches confined');
    assert.ok(producer.wrapper.includes(join(root, '.git', 'worktrees')), 'a session that creates worktrees keeps the worktrees area writable');
    assert.ok(producer.wrapper.includes(producerDirectory), 'the producer checkout is re-exposed writable');
    // On Linux with the namespaces available, run a shell command inside the confinement itself.
    if (process.platform !== 'linux') return;
    assert.ok(await sessionMountNamespaceWorks(), 'mount namespaces work on this Linux host');
    const confinement = await coordinatorConfinement({ kind: 'claude', args: [], coordinatorRoot: root, sessionDirectory: worktree });
    assert.equal(confinement?.mechanism, 'read-only-mount');
    // The host's process-launch channels are hidden where they exist, so no command inside the
    // namespace can ask a host manager to start the write outside it. Each channel is masked at
    // its canonical real path: bubblewrap (up to 0.11) cannot build a mount point whose path
    // traverses an absolute symlink — /var/run → /run on Debian-family hosts resolves against
    // bubblewrap's own staging root, where the target does not exist — and one mask at the real
    // directory covers every symlink alias of it.
    const launchTargets = hostProcessLaunchTargets();
    for (const directory of launchTargets.directories.filter(path => isDirectory(path))) {
      const maskIdx = confinement.wrapper.indexOf(realpathSync(directory));
      assert.ok(maskIdx > 0 && confinement.wrapper[maskIdx - 1] === '--tmpfs', `the namespace hides the process-launch directory ${directory}`);
    }
    for (const socket of launchTargets.busSockets.filter(path => existsSync(path) && !isDirectory(path))) {
      const socketIdx = confinement.wrapper.indexOf(realpathSync(socket));
      const replacement = confinement.wrapper[socketIdx - 1];
      assert.ok(socketIdx > 0 && confinement.wrapper[socketIdx - 2] === '--ro-bind' && (replacement === '/dev/null' || (!!launchTargets.secretsBus && replacement === realpathSync(launchTargets.secretsBus))),
        `the namespace replaces the bus socket ${socket} with an unconnectable device or the keyring-only proxy`);
    }
    assert.ok(processLaunchMaskWords({ directories: ['/run/user/4242/systemd', '/run/dbus', '/run/dbus'], busSockets: ['/run/user/4242/bus', '/run/user/4242/nested'] }, [root]).length > 0, 'the mask words are built for channels that exist');
    if (isDirectory('/run/dbus')) {
      const candidates = ['/run/dbus', '/var/run/dbus'];
      const canonicalDirectories = [...new Set(candidates.filter(isDirectory).map(path => realpathSync(path)))];
      assert.deepEqual(processLaunchMaskWords({ directories: candidates }, [root]), canonicalDirectories.flatMap(path => ['--tmpfs', path]),
        'aliased launch-channel directories collapse into one mask named by the canonical real path');
    }
    assert.ok(processLaunchMaskWords({ directories: [root, base] }, [root]).length === 0, 'a candidate that would hide a protected path is dropped');
    assert.ok(processLaunchMaskWords({ directories: [worktree] }, [worktree]).length === 0, 'the session\'s own directory is never hidden either');
    const probe = [
      'if touch "$1/coordinator-write-probe" 2>/tmp/.gy-probe-1; then echo WRITE-ALLOWED; else echo WRITE-BLOCKED; tail -1 /tmp/.gy-probe-1; fi',
      'if git -C "$1" -c user.email=g@l -c user.name=g commit --allow-empty -m probe 2>/tmp/.gy-probe-2; then echo COMMIT-ALLOWED; else echo COMMIT-BLOCKED; tail -1 /tmp/.gy-probe-2; fi',
      'if git -C "$1" checkout -b gy-888-escape 2>/tmp/.gy-probe-3; then echo CHECKOUT-ALLOWED; else echo CHECKOUT-BLOCKED; tail -1 /tmp/.gy-probe-3; fi',
      'git -C "$1" reset --hard >/dev/null 2>/tmp/.gy-probe-4 && echo RESET-ALLOWED || { echo RESET-BLOCKED; tail -1 /tmp/.gy-probe-4; }',
      'escaped=0; for d in /proc/[0-9]*; do if test -w "$d/root$1/src"; then escaped=1; fi; done; test "$escaped" = 0 && echo PROC-ISOLATED || echo PROC-ESCAPE',
      'if systemd-run --user --quiet true 2>/tmp/.gy-probe-5; then echo SYSTEMD-ALLOWED; else echo SYSTEMD-BLOCKED; fi',
      'touch "$2/session-write-probe" && git -C "$2" -c user.email=g@l -c user.name=g commit --allow-empty -m probe && echo SESSION-WROTE',
    ].join('\n');
    const run = spawnSync(confinement.wrapper[0], [...confinement.wrapper.slice(1, -1), '/bin/sh', '-c', probe, 'sh', root, worktree],
      { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' });
    assert.equal(run.status, 0, `the confined shell ran successfully: ${run.stderr}`);
    const output = run.stdout + '\n' + run.stderr;
    assert.ok(run.stdout.includes('WRITE-BLOCKED'), 'write to coordinator checkout is blocked');
    assert.ok(run.stdout.includes('COMMIT-BLOCKED'), 'git commit in coordinator checkout is blocked');
    assert.ok(run.stdout.includes('CHECKOUT-BLOCKED'), 'git checkout in coordinator checkout is blocked');
    assert.ok(run.stdout.includes('RESET-BLOCKED'), 'git reset in coordinator checkout is blocked');
    assert.ok(run.stdout.includes('PROC-ISOLATED'), 'no process in the namespace exposes a writable coordinator view through /proc');
    assert.ok(run.stdout.includes('SYSTEMD-BLOCKED'), 'a host manager cannot be asked to start the write outside the namespace');
    assert.ok(run.stdout.includes('SESSION-WROTE'), 'session worktree is writable');
    assert.ok(!run.stdout.includes('WRITE-ALLOWED'), 'write to coordinator is never allowed');
    assert.ok(!run.stdout.includes('COMMIT-ALLOWED'), 'commit in coordinator is never allowed');
    assert.ok(!run.stdout.includes('CHECKOUT-ALLOWED'), 'checkout in coordinator is never allowed');
    assert.ok(!run.stdout.includes('RESET-ALLOWED'), 'reset in coordinator is never allowed');
    assert.ok(!run.stdout.includes('PROC-ESCAPE'), 'the /proc route back to the checkout is closed');
    assert.ok(!run.stdout.includes('SYSTEMD-ALLOWED'), 'the systemd-run route outside the namespace is never open');
    assert.match(output, /Read-only file system/, 'operations fail with read-only filesystem error');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('unit:sandbox-keyring-proxy — the session bus is replaced by the keyring-only proxy when its socket is live, and by an unconnectable device otherwise', async () => {
  const base = await temporaryDirectory('confinement-secrets-bus');
  const server = createServer();
  try {
    const bus = join(base, 'bus'), proxy = join(base, 'graphyard-secrets-bus'), stale = join(base, 'stale-file');
    writeFileSync(bus, ''); writeFileSync(stale, '');
    await new Promise<void>(done => server.listen(proxy, done));
    const canonicalBus = realpathSync(bus);
    assert.deepEqual(processLaunchMaskWords({ busSockets: [bus], secretsBus: proxy }, []), ['--ro-bind', realpathSync(proxy), canonicalBus], 'a live proxy socket stands in for the session bus');
    assert.deepEqual(processLaunchMaskWords({ busSockets: [bus], secretsBus: join(base, 'missing') }, []), ['--ro-bind', '/dev/null', canonicalBus], 'no proxy socket keeps the bus unconnectable');
    assert.deepEqual(processLaunchMaskWords({ busSockets: [bus], secretsBus: stale }, []), ['--ro-bind', '/dev/null', canonicalBus], 'a regular file is never taken for the proxy');
    assert.deepEqual(processLaunchMaskWords({ busSockets: [bus], secretsBus: 'relative/socket' }, []), ['--ro-bind', '/dev/null', canonicalBus], 'a relative proxy path is ignored');
    assert.equal(secretsBusPath(1000, { GRAPHYARD_SECRETS_BUS: proxy }), proxy, 'the environment names the proxy socket');
    assert.equal(secretsBusPath(1000, { XDG_RUNTIME_DIR: '/run/user/1000' }), '/run/user/1000/graphyard-secrets-bus', 'the default lives in the runtime directory');
    assert.equal(secretsBusPath(4242, {}), '/run/user/4242/graphyard-secrets-bus', 'without XDG_RUNTIME_DIR the default is the uid runtime directory');
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    rmSync(base, { recursive: true, force: true });
  }
});

test('unit:own-credential-no-keyring — a session that carries its own GitHub credential never gets the keyring-only proxy, even when it is live (GY-1039)', async () => {
  const base = await temporaryDirectory('confinement-own-credential');
  const server = createServer();
  const saved = { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, GRAPHYARD_SECRETS_BUS: process.env.GRAPHYARD_SECRETS_BUS };
  try {
    // A worker pushes with the credential minted for its attempt (GY-999) and a reviewer posts with
    // its own; the keyring behind the proxy holds the operator's login, which neither may read.
    const runtime = join(base, 'run'), root = join(base, 'checkout'), session = join(root, '.graphyard', 'worktrees', 'GY-1-1');
    mkdirSync(runtime, { recursive: true }); mkdirSync(session, { recursive: true });
    const bus = join(runtime, 'bus'), proxy = join(runtime, 'graphyard-secrets-bus');
    writeFileSync(bus, '');
    await new Promise<void>(done => server.listen(proxy, done));
    process.env.XDG_RUNTIME_DIR = runtime; delete process.env.GRAPHYARD_SECRETS_BUS;
    const replacement = (wrapper: readonly string[]) => wrapper[wrapper.indexOf(realpathSync(bus)) - 1];
    assert.equal(replacement(readOnlyMountWrapper({ coordinatorRoot: root, sessionDirectory: session })), realpathSync(proxy), 'a session without a credential of its own reaches the keyring through the proxy');
    assert.equal(replacement(readOnlyMountWrapper({ coordinatorRoot: root, sessionDirectory: session, ownGitHubCredential: true })), '/dev/null', 'a session with its own credential keeps the bus unconnectable');
    const confinement = await coordinatorConfinement({ kind: 'claude', args: [], coordinatorRoot: root, sessionDirectory: session, bwrap: '/usr/bin/bwrap', platform: 'linux', mountNamespaceWorks: true, ownGitHubCredential: true });
    assert.equal(replacement(confinement!.wrapper), '/dev/null', 'the launch confinement passes the flag through');
  } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await new Promise<void>(done => server.close(() => done()));
    rmSync(base, { recursive: true, force: true });
  }
});

test('unit:keyring-proxy-units — the shipped units keep the proxy read-only and its endpoint stable across restarts (GY-1039)', () => {
  const unit = (name: string) => readFileSync(fileURLToPath(new URL(`../deploy/systemd/${name}`, import.meta.url)), 'utf8');
  const filter = unit('graphyard-secrets-bus-filter.service');
  assert.doesNotMatch(filter, /--talk=|--own=/, 'no bus name is opened wholesale');
  const calls = [...filter.matchAll(/--call=org\.freedesktop\.secrets=([\w.]+)@/g)].map(match => match[1]);
  assert.ok(calls.includes('org.freedesktop.Secret.Item.GetSecret') && calls.includes('org.freedesktop.Secret.Collection.SearchItems'), 'the reads `gh auth git-credential` makes stay allowed');
  for (const call of calls) assert.doesNotMatch(call, /\.(Delete|CreateItem|CreateCollection|SetSecret|SetAlias|Lock|ChangeLock|GetSecrets|Set)$/, `${call} reads, never writes or bulk-reads`);
  // systemd holds the endpoint sessions bind-mount, so a restarted proxy never replaces its inode.
  assert.match(unit('graphyard-secrets-bus.socket'), /^ListenStream=%t\/graphyard-secrets-bus$/m);
  const forwarder = unit('graphyard-secrets-bus.service');
  assert.match(forwarder, /systemd-socket-proxyd %t\/graphyard-secrets-bus-filter$/m);
  assert.doesNotMatch(forwarder + filter, /rm -f %t\/graphyard-secrets-bus\s/, 'no unit unlinks the endpoint');
  assert.equal(secretsBusPath(1000, { XDG_RUNTIME_DIR: '/run/user/1000' }), '/run/user/1000/graphyard-secrets-bus', 'the launcher binds the socket unit\'s endpoint');
});

test('unit:keyring-endpoint-unheld-reported — a launch that binds an endpoint graphyard-secrets-bus.socket does not hold names it with its migration, and nothing is guessed (GY-1039)', async () => {
  const base = await temporaryDirectory('confinement-endpoint-held');
  const server = createServer();
  try {
    const endpoint = join(base, 'graphyard-secrets-bus'), plain = join(base, 'plain-file');
    writeFileSync(plain, '');
    await new Promise<void>(done => server.listen(endpoint, done));
    const asked: string[][] = [];
    const show = (output: string) => (command: string, args: string[]) => { asked.push([command, ...args]); return output; };
    assert.equal(await secretsBusEndpointProblem(show(`ActiveState=active\nListen=${endpoint} (Stream)\n`), endpoint), null, 'the socket unit listening at the endpoint holds it');
    assert.deepEqual(asked[0], ['systemctl', '--user', 'show', '--property=ActiveState', '--property=Listen', 'graphyard-secrets-bus.socket']);
    // An earlier install enabled the service itself: xdg-dbus-proxy listens at the path and the socket unit is not loaded.
    const unheld = await secretsBusEndpointProblem(show('ActiveState=inactive\n'), endpoint);
    assert.ok(unheld && unheld !== secretsBusUnjudged && unheld.text.includes(endpoint) && unheld.text.includes('is inactive'), 'an endpoint the socket unit does not hold is named');
    assert.equal(unheld.next, secretsBusMigration);
    assert.match(secretsBusMigration, /disable --now graphyard-secrets-bus\.service && systemctl --user enable --now graphyard-secrets-bus\.socket/);
    const elsewhere = await secretsBusEndpointProblem(show('ActiveState=active\nListen=/run/user/1/graphyard-secrets-bus (Stream)\n'), endpoint);
    assert.ok(elsewhere && elsewhere !== secretsBusUnjudged && elsewhere.text.includes('listens at /run/user/1/graphyard-secrets-bus instead'), 'a socket unit listening elsewhere does not hold this endpoint');
    assert.equal(await secretsBusEndpointProblem(() => { throw new Error('Failed to connect to bus'); }, endpoint), secretsBusUnjudged, 'no answering user manager judges nothing');
    assert.equal(await secretsBusEndpointProblem(show(''), endpoint), secretsBusUnjudged, 'unreadable output judges nothing');
    assert.equal(await secretsBusEndpointProblem(show('ActiveState=inactive\n'), plain), null, 'a path that is no socket is not an endpoint');
    assert.equal(await secretsBusEndpointProblem(show('ActiveState=inactive\n'), join(base, 'missing')), null, 'no endpoint, nothing to migrate');
    assert.equal(await secretsBusEndpointProblem(show('ActiveState=inactive\n'), null), null);
    // The launcher logs it for a session whose wrapper binds the endpoint, and for no other.
    const bound = { mechanism: 'read-only-mount' as const, wrapper: ['bwrap', '--ro-bind', realpathSync(endpoint), '/run/user/1/bus', '--'], detail: '' };
    const warning = await keyringEndpointWarning('gy-approver', bound, show('ActiveState=inactive\n'), endpoint, new Map());
    assert.ok(warning && warning.startsWith('graphyard: gy-approver: ') && warning.endsWith(`migrate: ${secretsBusMigration}`), 'a session given the unheld endpoint is logged with the migration');
    assert.equal(await keyringEndpointWarning('gy-approver', bound, show(`ActiveState=active\nListen=${endpoint} (Stream)\n`), endpoint, new Map()), null, 'a held endpoint logs nothing');
    assert.equal(await keyringEndpointWarning('gy-worker', { ...bound, wrapper: ['bwrap', '--ro-bind', '/dev/null', '/run/user/1/bus', '--'] }, show('ActiveState=inactive\n'), endpoint, new Map()), null, 'a session with its own credential is never given the endpoint');
    assert.equal(await keyringEndpointWarning('gy-codex', { mechanism: 'runtime-sandbox', wrapper: [], detail: '' }, show('ActiveState=inactive\n'), endpoint, new Map()), null, 'a runtime sandbox binds no endpoint');
    assert.equal(await keyringEndpointWarning('gy-master', null, show('ActiveState=inactive\n'), endpoint, new Map()), null, 'an unconfined session binds no endpoint');
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    rmSync(base, { recursive: true, force: true });
  }
});

test('unit:keyring-endpoint-judged-once — an unmigrated endpoint socket is probed and reported once per launcher process, and a socket replaced at the path is judged afresh (GY-1039)', async () => {
  const base = await temporaryDirectory('confinement-endpoint-once');
  let server = createServer();
  try {
    const endpoint = join(base, 'graphyard-secrets-bus');
    await new Promise<void>(done => server.listen(endpoint, done));
    let probes = 0;
    const unheld = () => { probes++; return 'ActiveState=inactive\n'; };
    const bound = () => ({ mechanism: 'read-only-mount' as const, wrapper: ['bwrap', '--ro-bind', realpathSync(endpoint), '/run/user/1/bus', '--'], detail: '' });
    const verdicts = new Map<string, Promise<string | null | undefined>>();
    // Launches racing on the same socket share one probe, and only the first logs.
    const first = await Promise.all([keyringEndpointWarning('gy-a', bound(), unheld, endpoint, verdicts), keyringEndpointWarning('gy-b', bound(), unheld, endpoint, verdicts)]);
    assert.equal(first.filter(Boolean).length, 1, 'concurrent launches on one socket log the line once');
    assert.equal(probes, 1, 'and ask the user manager once');
    assert.equal(await keyringEndpointWarning('gy-c', bound(), unheld, endpoint, verdicts), null, 'a later launch on the same socket repeats nothing');
    assert.equal(probes, 1, 'and probes nothing');
    // The socket at the path is replaced — a restarted proxy, or the socket unit after a migration.
    await new Promise<void>(done => server.close(() => done()));
    server = createServer();
    await new Promise<void>(done => server.listen(endpoint, done));
    const fresh = await keyringEndpointWarning('gy-d', bound(), unheld, endpoint, verdicts);
    assert.ok(fresh && fresh.startsWith('graphyard: gy-d: '), 'a new socket at the path is judged and reported again');
    assert.equal(probes, 2);
    let held = 0;
    await new Promise<void>(done => server.close(() => done()));
    server = createServer();
    await new Promise<void>(done => server.listen(endpoint, done));
    assert.equal(await keyringEndpointWarning('gy-e', bound(), () => { held++; return `ActiveState=active\nListen=${endpoint} (Stream)\n`; }, endpoint, verdicts), null, 'a socket the unit holds logs nothing');
    assert.equal(await keyringEndpointWarning('gy-f', bound(), () => { held++; return ''; }, endpoint, verdicts), null);
    assert.equal(held, 1, 'and its verdict is kept too');
    // A probe that cannot judge the socket is not kept as its verdict (GY-1039 follow-up 8): once
    // the user manager answers, a later launch in the same process still reports the endpoint.
    await new Promise<void>(done => server.close(() => done()));
    server = createServer();
    await new Promise<void>(done => server.listen(endpoint, done));
    let asked = 0;
    assert.equal(await keyringEndpointWarning('gy-g', bound(), () => { asked++; throw new Error('Failed to connect to bus'); }, endpoint, verdicts), null, 'no answering user manager logs nothing');
    assert.equal(await keyringEndpointWarning('gy-h', bound(), () => { asked++; return ''; }, endpoint, verdicts), null, 'nor does an unreadable answer');
    assert.equal(asked, 2, 'and neither is remembered, so each launch asks again');
    const later = await keyringEndpointWarning('gy-i', bound(), unheld, endpoint, verdicts);
    assert.ok(later && later.startsWith('graphyard: gy-i: ') && later.endsWith(`migrate: ${secretsBusMigration}`), 'the user manager answering later reports the unmigrated endpoint');
    assert.equal(probes, 3);
    assert.equal(await keyringEndpointWarning('gy-j', bound(), unheld, endpoint, verdicts), null, 'and that judged verdict is kept');
    assert.equal(probes, 3);
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    rmSync(base, { recursive: true, force: true });
  }
});

test('unit:allocated-checkout-re-exposed — a reviewer or producer launched from the coordinator root gets its allocated checkout writable, never the checkout itself', async () => {
  const base = await temporaryDirectory('confinement-session');
  try {
    const { root } = coordinatorFixture(base);
    // The terminal reviewer and producer launch shape (reviewer.ts, producer.ts): the pane starts
    // from the coordinator root — where its request and the shared Git paths live — while the
    // launch allocates a checkout of its own beside it. The sandbox-claim check keeps the
    // runtime's working directory as its workspace root, and the read-only mount re-exposes the
    // allocated checkout separately (GY-888, review finding).
    const allocated = join(root, '.graphyard', 'review-checkout');
    mkdirSync(allocated, { recursive: true });
    const options = { directory: allocated, cwd: root };
    const bwrap = bwrapOnPath();
    const namespacesWork = process.platform === 'linux' && !!bwrap && await sessionMountNamespaceWorks(bwrap);
    if (!namespacesWork) {
      await assert.rejects(() => sessionConfinement('claude', [], options, root), /never starts a session unconfined/, 'a host that cannot confine refuses the launch');
      return;
    }
    const claudeConfinement = await sessionConfinement('claude', [], options, root);
    assert.ok(claudeConfinement, 'the launch carries a confinement');
    assert.equal(claudeConfinement.mechanism, 'read-only-mount');
    const rootIdx = claudeConfinement.wrapper.indexOf(root);
    assert.ok(rootIdx > 0 && claudeConfinement.wrapper[rootIdx - 1] === '--ro-bind' && claudeConfinement.wrapper[rootIdx + 1] === root, 'the checkout the session starts in is bound read-only');
    const allocatedIdx = claudeConfinement.wrapper.indexOf(allocated);
    assert.ok(allocatedIdx > 0 && claudeConfinement.wrapper[allocatedIdx - 1] === '--bind' && claudeConfinement.wrapper[allocatedIdx + 1] === allocated, 'the allocated checkout is re-exposed writable');
    // The sandbox never claims a session whose workspace root is the checkout itself: a codex
    // reviewer or producer would grant the checkout writable through its own working directory,
    // so it carries the mount wrapper like every other runtime.
    const codexConfinement = await sessionConfinement('codex', ['--sandbox', 'workspace-write'], options, root);
    assert.ok(codexConfinement, 'the codex launch carries a confinement');
    assert.equal(codexConfinement.mechanism, 'read-only-mount', 'a codex session started from the checkout is mount-confined, not sandbox-confined');
    assert.ok(codexConfinement.wrapper.includes(allocated), 'the codex mount also re-exposes the allocated checkout');
    // Prove it with a real shell: a command typed at the coordinator root cannot write the
    // checkout, while the allocated checkout takes the session's writes.
    const probe = [
      'if touch "$1/coordinator-write-probe" 2>/dev/null; then echo WRITE-ALLOWED; else echo WRITE-BLOCKED; fi',
      'touch "$2/session-write-probe" && echo SESSION-WROTE',
    ].join('\n');
    const run = spawnSync(codexConfinement.wrapper[0], [...codexConfinement.wrapper.slice(1, -1), '/bin/sh', '-c', probe, 'sh', root, allocated],
      { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' });
    assert.equal(run.status, 0, `the confined shell ran successfully: ${run.stderr}`);
    assert.ok(run.stdout.includes('WRITE-BLOCKED'), 'a shell command from the coordinator root cannot write the checkout');
    assert.ok(run.stdout.includes('SESSION-WROTE'), 'the allocated checkout takes the session\'s writes');
    assert.ok(!run.stdout.includes('WRITE-ALLOWED'), 'the checkout is never writable');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('unit:unconfined-launch-refused — a launch that cannot apply the confinement is refused with the reason named, never started unconfined', async () => {
  const confined = { kind: 'claude', args: [] as string[], coordinatorRoot: '/coordinator', sessionDirectory: '/coordinator/wt' };
  // No mount namespace without Linux, without bubblewrap, or on a host that refuses the namespaces.
  const darwin = await coordinatorConfinementRefusal({ ...confined, platform: 'darwin' });
  assert.ok(darwin !== null, 'darwin platform must be refused');
  assert.match(darwin!, /never starts a session unconfined/, 'refusal message includes confinement requirement');
  assert.match(darwin!, /darwin/, 'refusal message identifies platform');

  const noBwrap = await coordinatorConfinementRefusal({ ...confined, platform: 'linux', bwrap: null });
  assert.ok(noBwrap !== null, 'missing bubblewrap must be refused');
  assert.match(noBwrap!, /bubblewrap/, 'refusal message mentions bubblewrap');
  assert.match(noBwrap!, /not installed/, 'refusal message says bubblewrap is not installed');

  // With bubblewrap present but the namespaces refused, the refusal names the namespaces: the
  // bwrap-missing reason above is only reached when bubblewrap itself is absent.
  const refusedNamespaces = await coordinatorConfinementRefusal({ ...confined, platform: 'linux', bwrap: '/usr/bin/bwrap', mountNamespaceWorks: false });
  assert.ok(refusedNamespaces !== null, 'refused mount namespaces must be refused');
  assert.match(refusedNamespaces!, /namespaces/, 'refusal message mentions namespaces');
  assert.match(refusedNamespaces!, /refuses/, 'refusal message indicates the host refuses namespaces');

  // The builder carries the same refusal: it never returns an unconfined launch.
  await assert.rejects(() => coordinatorConfinement({ ...confined, platform: 'darwin', mountNamespaceWorks: true }), /never starts a session unconfined/);

  // A runtime with a workspace-write sandbox of its own needs neither Linux nor bubblewrap.
  const sandboxedCodex = await coordinatorConfinementRefusal({ kind: 'codex', args: ['--sandbox', 'workspace-write'], coordinatorRoot: '/coordinator', sessionDirectory: '/coordinator/wt', platform: 'darwin' });
  assert.equal(sandboxedCodex, null, 'codex with workspace-write sandbox is not refused on darwin');

  // A worker profile that would turn its runtime's own confinement off is still refused at the launch (GY-857).
  const claudeBypass = workerConfinementRefusal({ kind: 'claude', agentArgs: ['--dangerously-skip-permissions'] });
  assert.ok(claudeBypass !== null, 'claude with --dangerously-skip-permissions must be refused');
  assert.match(claudeBypass!, /--dangerously-skip-permissions/, 'refusal message names the flag');
  assert.match(claudeBypass!, /confinement/, 'refusal message explains it disables confinement');

  const codexUnsandboxed = workerConfinementRefusal({ kind: 'codex', agentArgs: ['--sandbox', 'danger-full-access'] });
  assert.ok(codexUnsandboxed !== null, 'codex without workspace-write sandbox must be refused');
  assert.match(codexUnsandboxed!, /workspace-write/, 'refusal message identifies correct sandbox mode');
  assert.match(codexUnsandboxed!, /danger-full-access/, 'refusal message names the incorrect setting');

  const opencodeUndanied = workerConfinementRefusal({ kind: 'opencode', environment: { OPENCODE_PERMISSION: '{"edit":"allow","external_directory":"allow"}' } });
  assert.ok(opencodeUndanied !== null, 'opencode with external_directory allow must be refused');
  assert.match(opencodeUndanied!, /external_directory/, 'refusal message identifies the permission');
  assert.match(opencodeUndanied!, /"deny"/, 'refusal message specifies correct setting');

  const claudeSafe = workerConfinementRefusal({ kind: 'claude', agentArgs: [] });
  assert.equal(claudeSafe, null, 'claude with no flags is allowed');

  const codexSafe = workerConfinementRefusal({ kind: 'codex', agentArgs: ['--sandbox', 'workspace-write'] });
  assert.equal(codexSafe, null, 'codex with workspace-write is allowed');
});

test('unit:launcher-knows-its-checkout — the launcher derives its coordinator checkout from either of its entries, and refuses a launch it cannot confine', () => {
  // Both CLI entries count: bin/graphyard.mjs, which operators invoke, and the src/cli.ts child it
  // spawns, which is what process.argv[1] holds inside the loop. The old basename check matched
  // only the first, so every launcher-started session ran unconfined in production (review finding).
  assert.equal(launcherCoordinatorRoot('/srv/graphyard/bin/graphyard.mjs', false), '/srv/graphyard');
  assert.equal(launcherCoordinatorRoot('/srv/graphyard/src/cli.ts', false), '/srv/graphyard');
  assert.equal(launcherCoordinatorRoot('/srv/graphyard/scripts/graphyard-executor.mjs', false), '/srv/graphyard', 'an executor slot launches workers in-process, so it confines them too');
  assert.equal(launcherRootUndetermined('/graphyard-executor.mjs', false) !== null, true, 'an executor that cannot name its checkout refuses instead of launching unconfined');
  assert.equal(launcherCoordinatorRoot('/srv/graphyard/src/cli.ts', true), null, 'nothing is confined under the test runner');
  assert.equal(launcherCoordinatorRoot('/usr/bin/node', false), null, 'a foreign entry is not a launcher');
  assert.equal(launcherCoordinatorRoot(undefined, false), null);
  assert.equal(launcherCoordinatorRoot('/cli.ts', false), null, 'a checkout of / is no checkout');
  // A launcher that cannot name its checkout refuses the launch instead of starting it unconfined.
  assert.match(launcherRootUndetermined('/cli.ts', false)!, /coordinator checkout could not be derived/);
  assert.equal(launcherRootUndetermined('/srv/graphyard/src/cli.ts', false), null);
  assert.equal(launcherRootUndetermined('/usr/bin/node', false), null, 'a non-CLI process has no refusal to carry');
});

test('integration:launch-carries-confinement — a session launch types the confinement into the pane and a headless run is wrapped at its spawn', async () => {
  const base = await temporaryDirectory('confinement-launch');
  try {
    const { root, worktree } = coordinatorFixture(base);
    const bwrap = bwrapOnPath();
    const namespacesWork = process.platform === 'linux' && !!bwrap && await sessionMountNamespaceWorks(bwrap);
    // sessionConfinement, the exact call startAgentSession makes, builds the wrapper and keeps the
    // launch record's detail — or refuses the launch where the host cannot confine it.
    if (!namespacesWork) {
      await assert.rejects(() => sessionConfinement('claude', [], { directory: worktree }, root), /never starts a session unconfined/, 'a host that cannot confine refuses the launch');
    } else {
      const confinement = await sessionConfinement('claude', [], { directory: worktree }, root);
      assert.ok(confinement, 'the session launch carries a confinement');
      assert.equal(confinement.mechanism, 'read-only-mount');
      assert.ok(confinement.detail.includes(root), 'the launch record names the checkout it confined');
      // The launch itself: the typed command line the pane's shell receives starts with the
      // confinement words, then the runtime and its request (expanded from the launch files).
      let typed: string | null = null;
      const run = (command: string, args: string[]) => {
        if (command === 'herdr' && args[0] === 'pane' && args[1] === 'run') typed = args[3];
        return startedAtOnce(args) ?? '';
      };
      await startAgentSession('session', 'pi', 'pane-1', [], 'Judge the candidate', run, { directory: worktree, coordinatorRoot: root });
      assert.ok(typed, 'the launch typed a command line');
      const words = expandTypedCommand(typed!).words;
      assert.ok(words[0]?.endsWith('/bwrap') || words[0] === 'bwrap', `the typed line wraps the runtime in bubblewrap (${words[0]})`);
      for (const expected of ['--unshare-pid', '--proc', '/proc', '--ro-bind', root, worktree, '--']) {
        assert.ok(words.includes(expected), `the typed line carries ${expected}`);
      }
      assert.equal(expandTypedCommand(typed!).kind, 'pi', 'the runtime still follows the wrapper as the first command');
    }
    // A headless run (the launcher's pi approver and producer) is wrapped at its spawn: the
    // runtime command and its arguments follow the wrapper, its own options unchanged.
    type SpawnFn = typeof import('node:child_process').spawn;
    const captured: { command: string; args: readonly string[]; options: unknown }[] = [];
    const base_spawn = ((command: string, args: readonly string[], options: unknown) => { captured.push({ command, args, options }); return { pid: 4242 }; }) as unknown as SpawnFn;
    confiningSpawn(base_spawn, { coordinatorRoot: root, bwrap: 'bwrap' })('pi', ['--mode', 'json', '--no-session'], { cwd: worktree, env: { GRAPHYARD_URL: 'u' }, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].command, 'bwrap', 'the spawn starts bubblewrap');
    assert.deepEqual([...captured[0].args].slice(-5), ['--', 'pi', '--mode', 'json', '--no-session'], 'the runtime command and arguments follow the wrapper');
    assert.ok(captured[0].args.includes('--unshare-pid') && captured[0].args.includes(worktree), 'the headless wrapper isolates /proc and re-exposes the run directory');
    assert.deepEqual(captured[0].options, { cwd: worktree, env: { GRAPHYARD_URL: 'u' }, stdio: ['ignore', 'pipe', 'pipe'] }, 'the run keeps its own options');
    // Without a checkout to confine the spawner is the plain spawn.
    const plain: string[] = [];
    const plainSpawn = ((command: string, args: readonly string[]) => { plain.push(command, ...args); return { pid: 1 }; }) as unknown as SpawnFn;
    confiningSpawn(plainSpawn)('pi', ['--mode', 'json'], { cwd: worktree });
    assert.deepEqual(plain, ['pi', '--mode', 'json'], 'no coordinator checkout, no wrapper');
    // A headless run that cannot be confined fails at its spawn instead of starting unconfined.
    assert.throws(() => headlessConfinementWrapper(root, worktree, null), /bubblewrap \(bwrap\) is not installed/, 'a host without bubblewrap refuses the headless run');
    assert.throws(() => headlessConfinementWrapper(root, undefined, 'bwrap'), /no working directory/, 'a run without a working directory is refused');
    await sessionMountNamespaceWorks('/nonexistent/graphyard-bwrap-probe');
    assert.throws(() => headlessConfinementWrapper(root, worktree, '/nonexistent/graphyard-bwrap-probe'), /refuses the unprivileged namespaces/, 'a host whose namespaces are known-refused refuses the headless run');
    const wrapped = confiningSpawn(base_spawn, { coordinatorRoot: root, bwrap: null });
    assert.throws(() => wrapped('pi', [], { cwd: worktree }), /bubblewrap \(bwrap\) is not installed/, 'the wrapped spawn refuses instead of starting unconfined');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
