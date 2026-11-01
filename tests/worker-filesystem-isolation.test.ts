import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { coordinatorConfinement, readOnlyMountWrapper } from '../src/master/confinement.js';
import { headlessConfinementWrapper, masterSessionConfinement, prepareConfinedGitPaths, startAgentSession } from '../src/master/launch.js';
import { runTrialAttempt, trialConfinement } from '../src/merge-writer/trial.js';
import { herdrSocketPath, herdrTarget, targetHerdr } from '../src/master/herdr.js';
import { piRunner } from '../src/runner/pi.js';
import { runConfinement } from '../src/runner/roles.js';
import { graphyardTools } from '../src/runner/payloads.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { setupMaster } from '../src/master/config.js';
import { startMaster } from '../src/master/harness.js';
import { runtimeLoginHomes } from '../src/master/profiles.js';
import { startedAtOnce } from './helpers/launch-shell.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
async function fixture(maskedCoordinator = false) {
  // Outside /tmp: these protected files remain visible through the read-only host mount.
  // Every destructive probe below names only this disposable fixture, never the real HOME.
  const base = await temporaryDirectory('fs', process.cwd());
  const config = join(base, 'config'), runtime = join(config, 'own');
  const root = maskedCoordinator ? join(config, 'deploy') : join(base, 'repo');
  const home = join(base, 'home'), unrelated = join(base, 'other'), slots = join(base, '.verification-slots');
  for (const path of [root, home, unrelated, runtime, slots]) mkdirSync(path, { recursive: true });
  for (const directory of [home, unrelated]) writeFileSync(join(directory, 'sentinel'), 'protected\n');
  writeFileSync(join(config, 'operator.token'), 'operator-secret');
  writeFileSync(join(runtime, 'login'), 'own-login');
  writeFileSync(join(config, 'worker.token'), 'own-token');
  writeFileSync(join(root, '.gitignore'), '.graphyard/\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {
    build: `node -e "require('fs').writeFileSync('built', 'built')"`,
    test: `node -e "if(require('fs').readFileSync('built','utf8') !== 'built') process.exit(1)"`,
  } }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'fixture@example.invalid'); git(root, 'config', 'user.name', 'Fixture');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'base');
  const worktree = join(root, '.graphyard', 'worktrees', 'worker');
  git(root, 'worktree', 'add', '-qb', 'graphyard/gy-3045-1', worktree);
  prepareConfinedGitPaths(root);
  const mask = { configHome: config, extraPaths: [], own: [join(config, 'worker.token'), runtime], cli: [] };
  const wrapper = readOnlyMountWrapper({ coordinatorRoot: root, sessionDirectory: worktree, credentialMask: mask, secretsBus: null, writable: [slots] });
  return { base, root, worktree, home, unrelated, config, runtime, slots, mask, wrapper };
}
function run(wrapper: readonly string[], cwd: string, program: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(wrapper[0], [...wrapper.slice(1), program, ...args], {
    cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(result.status, 0, `${program} failed: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const deniedOperations = `
const fs = require('node:fs'), assert = require('node:assert/strict'), path = require('node:path');
const [home, unrelated, root, worktree] = process.argv.slice(1);
const protectedVisible = true;
const deny = fn => assert.throws(fn, error => ['EROFS', 'EACCES', 'EPERM', 'EBUSY', 'EXDEV', ...(!protectedVisible ? ['ENOENT'] : [])].includes(error.code));
for (const directory of [home, unrelated, root]) {
  const file = path.join(directory, directory === root ? 'package.json' : 'sentinel');
  if (protectedVisible) assert.ok(fs.readFileSync(file).length, 'protected host files are visible');
  else assert.equal(fs.existsSync(file), false, 'host files are excluded from the private root');
  deny(() => fs.writeFileSync(path.join(directory, 'created'), 'bad'));
  deny(() => fs.writeFileSync(file, 'bad'));
  deny(() => fs.renameSync(file, file + '.moved'));
  deny(() => fs.renameSync(file, path.join(worktree, 'stolen')));
  deny(() => fs.unlinkSync(file));
  const source = path.join(worktree, 'source'); fs.writeFileSync(source, 'own');
  deny(() => fs.renameSync(source, file)); fs.unlinkSync(source);
}
console.log('host writes denied');
`;

test('integration:worker-host-filesystem-isolation — all runtimes, terminal roles, headless roles, master and merge trials deny host creation, overwrite, rename and deletion', async () => {
  const f = await fixture();
  for (const role of ['worker', 'reviewer', 'producer', 'approver', 'spec-checker']) {
    for (const kind of ['claude', 'cursor', 'codex', 'opencode', 'pi', 'registered']) {
      const confined = await coordinatorConfinement({ kind, args: kind === 'codex' ? ['--sandbox', 'workspace-write'] : [],
        coordinatorRoot: f.root, sessionDirectory: role === 'worker' ? f.worktree : f.root,
        allocatedDirectory: f.worktree, credentialMask: f.mask, secretsBus: null });
      assert.ok(confined?.wrapper.length, `${role}/${kind} has an outer namespace`);
      run(confined.wrapper, f.worktree, process.execPath, ['-e', deniedOperations, f.home, f.unrelated, f.root, f.worktree]);
    }
  }
  for (const wrapper of [
    headlessConfinementWrapper(f.root, f.worktree, undefined, f.mask),
    (await masterSessionConfinement('claude', f.root)).wrapper,
    trialConfinement([f.config], [f.worktree]),
  ]) run(wrapper, f.worktree, process.execPath, ['-e', deniedOperations, f.home, f.unrelated, f.root, f.worktree]);
  assert.equal(readFileSync(join(f.home, 'sentinel'), 'utf8'), 'protected\n');
  assert.equal(readFileSync(join(f.unrelated, 'sentinel'), 'utf8'), 'protected\n');
});

test('integration:worker-home-deletion-regression — the real regression remains executable inside the merge-trial boundary', async () => {
  const f = await fixture();
  // The merge writer runs this file under its own socket policy. A direct host
  // run must exercise that composition too, rather than report a false pass
  // while the bound E2E case cannot establish its inner sandbox in production.
  // The bound E2E runner supplies the real outer container. Within that private
  // root, this extra mount namespace must still permit the session's mounts.
  // Socket Landlock belongs to the inner session, after its mounts.
  const outer = ['bwrap', '--unshare-user', '--unshare-pid', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--bind', f.base, f.base, '--'];
  run(outer, f.worktree, f.wrapper[0], [...f.wrapper.slice(1), process.execPath,
    '-e', deniedOperations, f.home, f.unrelated, f.root, f.worktree]);
  run(outer, f.worktree, f.wrapper[0], [...f.wrapper.slice(1), '/bin/sh', '-ec',
    'echo nested > nested; git add nested; git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm nested']);
  assert.equal(readFileSync(join(f.home, 'sentinel'), 'utf8'), 'protected\n');
  assert.equal(readFileSync(join(f.worktree, 'nested'), 'utf8'), 'nested\n');
});

test('integration:worker-home-deletion-regression — the GY-3044 command scope mistake leaves fake HOME intact while editing, commits, builds, checks and allocated scratch cleanup work unattended', async () => {
  const f = await fixture();
  const before = git(f.worktree, 'rev-parse', 'HEAD');
  const script = `set -u
# Replay the command-scope mistake with a disposable fake home as the parent HOME.
export HOME="$1"
HOME=$(mktemp -d) /bin/bash -lc 'true'; rm -rf "$HOME" 2>/dev/null; true
`;
  // rm is expected to fail at the OS boundary, without a runtime approval or an input stream.
  run(f.wrapper, f.worktree, '/bin/bash', ['-c', script, 'regression', f.home]);
  assert.equal(readFileSync(join(f.home, 'sentinel'), 'utf8'), 'protected\n');
  run(f.wrapper, f.worktree, '/bin/bash', ['-ec', `
    test "$(cat "$1/worker.token")" = own-token
    test ! -r "$1/operator.token"
    test "$(cat "$2/login")" = own-login
    echo state > "$2/state"
    mkdir "$4/slot-0"; echo lease > "$4/slot-0/owner"; rm "$4/slot-0/owner"; rmdir "$4/slot-0"
    echo edit > edit; git add edit; git commit -qm edit
    /usr/bin/npm run build; /usr/bin/npm test
    test "$HOME" != "$3"
    mkdir -p "$HOME/.cache"; echo cache > "$HOME/.cache/runtime"
    scratch=$(mktemp -d); echo scratch > "$scratch/owned"; rm -rf "$scratch"; test ! -e "$scratch"
    test ! -e /dev/disk; test ! -e /dev/mem
  `, 'allowed', f.config, f.runtime, process.env.HOME ?? '', f.slots]);
  assert.notEqual(git(f.worktree, 'rev-parse', 'HEAD'), before);
  assert.equal(readFileSync(join(f.worktree, 'built'), 'utf8'), 'built');
  assert.equal(readFileSync(join(f.runtime, 'state'), 'utf8'), 'state\n');
});

test('integration:worker-control-socket-isolation — host Docker, systemd and custom launch sockets cannot receive sandbox commands', async () => {
  const f = await fixture();
  const sockets = await temporaryDirectory('s', f.base);
  const socket = join(f.base, 'docker.sock');
  const runtimeSocket = join(sockets, 'launch.sock');
  const herdrHome = await temporaryDirectory('h');
  const herdr = { configHome: herdrHome, session: 'x' }, oldHerdr = herdrTarget();
  const herdrSocket = herdrSocketPath(herdr);
  mkdirSync(join(herdrHome, 'herdr', 'sessions', 'x'), { recursive: true });
  let reached = 0;
  const server = createServer(connection => { reached++; connection.end('host command executor'); });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  const runtimeServer = createServer(connection => { reached++; connection.end('host runtime executor'); });
  await new Promise<void>(resolve => runtimeServer.listen(runtimeSocket, resolve));
  const herdrServer = createServer(connection => { reached++; connection.end('host pane executor'); });
  await new Promise<void>(resolve => herdrServer.listen(herdrSocket, resolve));
  const oldRuntime = process.env.XDG_RUNTIME_DIR, oldDocker = process.env.DOCKER_HOST;
  try {
    process.env.XDG_RUNTIME_DIR = sockets;
    targetHerdr(herdr);
    process.env.DOCKER_HOST = `unix://${socket}`;
    // Construct wrappers after publishing a nonstandard host command endpoint.
    const wrappers = [readOnlyMountWrapper({ coordinatorRoot: f.root, sessionDirectory: f.worktree, secretsBus: null }),
      headlessConfinementWrapper(f.root, f.worktree), (await masterSessionConfinement('claude', f.root, {}, [herdrHome])).wrapper,
      trialConfinement([f.config], [f.worktree])];
    // A tab-specific endpoint must be masked even when the launcher did not inherit it.
    delete process.env.DOCKER_HOST;
    const tab = await coordinatorConfinement({ kind: 'registered', args: [], coordinatorRoot: f.root,
      sessionDirectory: f.worktree, environment: { DOCKER_HOST: `unix://${socket}` }, secretsBus: null });
    assert.ok(tab);
    wrappers.push([...tab.wrapper]);
    // Neither path is advertised in the environment or the known-directory masks.
    // Publish one after constructing every wrapper, to rule out a socket inventory.
    const undeclared = join(f.home, 'executor.sock');
    const alias = join(f.worktree, 'executor-alias');
    const abstract = '\0graphyard-fixture-' + process.pid;
    const undeclaredServer = createServer(connection => { reached++; connection.end('undeclared host executor'); });
    const abstractServer = createServer(connection => { reached++; connection.end('abstract host executor'); });
    await new Promise<void>(resolve => undeclaredServer.listen(undeclared, resolve));
    await new Promise<void>(resolve => abstractServer.listen(abstract, resolve));
    symlinkSync(undeclared, alias);
    try {
    for (const wrapper of wrappers) {
      run(wrapper, f.worktree, process.execPath, ['-e', `
        const net = require('node:net'), fs = require('node:fs'), assert = require('node:assert/strict');
        const endpoints = [${JSON.stringify(socket)}, ${JSON.stringify(runtimeSocket)}, ${JSON.stringify(herdrSocket)}, '/run/docker.sock', '/var/run/docker.sock', '/run/dbus/system_bus_socket',
          ${JSON.stringify(join(sockets, 'bus'))}, ${JSON.stringify(join(sockets, 'systemd', 'private'))},
          ${JSON.stringify(undeclared)}, ${JSON.stringify(alias)}, ${JSON.stringify(abstract)}];
        Promise.all(endpoints.map(path => new Promise((resolve, reject) => {
          const socket = net.connect(path); socket.on('connect', () => { socket.destroy(); reject(new Error('host socket reached: ' + path)); });
          socket.on('error', () => resolve());
        }))).catch(error => { console.error(error); process.exitCode = 1; });
        assert.ok(!fs.existsSync('/dev/disk'));
        // Local IPC remains usable for tools and checks within the allocated scratch.
        const own = '/tmp/own-' + process.pid + '.sock';
        const server = net.createServer(connection => connection.end('local IPC'));
        server.listen(own, () => {
          const connection = net.connect(own);
          let data = '';
          connection.on('data', chunk => data += chunk);
          connection.on('end', () => { assert.equal(data, 'local IPC'); server.close(); });
        });
      `]);
    }
    } finally {
      await new Promise<void>(resolve => undeclaredServer.close(() => resolve()));
      await new Promise<void>(resolve => abstractServer.close(() => resolve()));
    }
    assert.equal(reached, 0, 'no host command executor received a connection');
    assert.ok(existsSync(socket), 'the host socket itself survives');
  } finally {
    if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = oldRuntime;
    if (oldDocker === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = oldDocker;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => runtimeServer.close(() => resolve()));
    await new Promise<void>(resolve => herdrServer.close(() => resolve()));
    targetHerdr(oldHerdr);
  }
});


test('integration:worker-host-filesystem-isolation — runTrialAttempt excludes the coordinator and exposes only required Git and dependency state read-only', async () => {
  const f = await fixture(true);
  const dependency = join(f.root, 'node_modules', 'fixture-dependency');
  mkdirSync(dependency, { recursive: true });
  writeFileSync(join(dependency, 'index.js'), 'module.exports = "shared dependency";');
  writeFileSync(join(f.root, 'package-lock.json'), '{}');
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({ scripts: {
    build: '/usr/bin/node build.cjs', test: '/usr/bin/node test.cjs',
  } }));
  writeFileSync(join(f.root, 'build.cjs'), `const assert = require('node:assert/strict'), fs = require('node:fs');
    assert.equal(require('fixture-dependency'), 'shared dependency');
    fs.writeFileSync('built', 'built');`);
  writeFileSync(join(f.root, 'test.cjs'), `
    const assert = require('node:assert/strict'), fs = require('node:fs');
    assert.equal(fs.readFileSync('built', 'utf8'), 'built');
    assert.throws(() => fs.readFileSync(${JSON.stringify(join(f.config, 'operator.token'))}), { code: 'ENOENT' });
    { ${deniedOperations.replace('const protectedVisible = true', 'const protectedVisible = false').replace('process.argv.slice(1)', JSON.stringify([f.home, f.unrelated, f.root, '.']))} }
  `);
  git(f.root, 'add', 'package.json', 'package-lock.json', 'build.cjs', 'test.cjs');
  git(f.root, 'commit', '-qm', 'trial checks');
  const base = await temporaryDirectory('trial', f.base);
  const temporary = await temporaryDirectory('tmp', f.base);
  const verdict = await runTrialAttempt({ root: f.root, base, mergeSha: git(f.root, 'rev-parse', 'HEAD'),
    changedFiles: [], hidden: [f.config], temporaryRoots: [temporary], checkoutRoots: [],
    environment: { ...process.env, PATH: '/usr/bin:/bin' }, timeoutMs: 60_000, secretScan: false });
  assert.equal(verdict.build, 'pass', verdict.logTail);
  assert.deepEqual(verdict.tests.failed, [], verdict.logTail);
  assert.equal(verdict.tests.passed, 1, verdict.logTail);
  assert.equal(readFileSync(join(f.home, 'sentinel'), 'utf8'), 'protected\n');
  assert.equal(readFileSync(join(f.unrelated, 'sentinel'), 'utf8'), 'protected\n');
});

test('integration:worker-home-deletion-regression — cold-cache dashboard trials install and run browser checks inside allocated state', async () => {
  const f = await fixture(true);
  // Exercise the real npm/npx commands and namespace without a network download. The fixture
  // installer performs the cache writes required by Playwright, and the browser check uses them.
  const modules = join(f.root, 'node_modules');
  mkdirSync(join(modules, '.bin'), { recursive: true });
  mkdirSync(join(modules, 'playwright'));
  writeFileSync(join(modules, 'playwright', 'package.json'), JSON.stringify({ name: 'playwright', version: '1.0.0', bin: { playwright: 'cli.cjs' } }));
  writeFileSync(join(modules, 'playwright', 'cli.cjs'), `#!/usr/bin/node
    const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
    assert.deepEqual(process.argv.slice(2), ['install', 'chromium']);
    assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(process.env.HOME, '.cache', 'ms-playwright'));
    assert.equal(process.env.npm_config_cache, path.join(process.env.HOME, '.npm'));
    assert.equal(fs.existsSync(process.env.PLAYWRIGHT_BROWSERS_PATH), false, 'cold browser cache');
    fs.mkdirSync(process.env.PLAYWRIGHT_BROWSERS_PATH, { recursive: true });
    fs.writeFileSync(path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium'), 'installed');
    fs.mkdirSync(process.env.npm_config_cache, { recursive: true });
    fs.writeFileSync(path.join(process.env.npm_config_cache, 'installer-cache'), 'cached');
  `);
  chmodSync(join(modules, 'playwright', 'cli.cjs'), 0o755);
  symlinkSync('../playwright/cli.cjs', join(modules, '.bin', 'playwright'));
  writeFileSync(join(f.root, 'package-lock.json'), '{}');
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({ scripts: {
    build: 'node -e "require(\'fs\').writeFileSync(\'built\', \'built\')"',
    'test:browser': 'node browser.cjs',
  } }));
  writeFileSync(join(f.root, 'browser.cjs'), `
    const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
    assert.equal(fs.readFileSync('built', 'utf8'), 'built');
    assert.equal(fs.readFileSync(path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium'), 'utf8'), 'installed');
    assert.equal(fs.readFileSync(path.join(process.env.npm_config_cache, 'installer-cache'), 'utf8'), 'cached');
    { ${deniedOperations.replace('const protectedVisible = true', 'const protectedVisible = false').replace('process.argv.slice(1)', JSON.stringify([f.home, f.unrelated, f.root, '.']))} }
    console.log('browser cache consumed');
  `);
  git(f.root, 'add', 'package.json', 'package-lock.json', 'browser.cjs');
  git(f.root, 'commit', '-qm', 'cold-cache browser checks');
  const base = await temporaryDirectory('browser-trial', f.base);
  const temporary = await temporaryDirectory('browser-tmp', f.base);
  for (let attempt = 0; attempt < 2; attempt++) {
    const verdict = await runTrialAttempt({ root: f.root, base, mergeSha: git(f.root, 'rev-parse', 'HEAD'),
      changedFiles: ['web/app.tsx'], hidden: [f.config], temporaryRoots: [temporary], checkoutRoots: [],
      environment: { ...process.env, PATH: '/usr/bin:/bin', HOME: f.home,
        PLAYWRIGHT_BROWSERS_PATH: join(f.home, 'browser-cache'), npm_config_cache: join(f.home, 'npm-cache') },
      timeoutMs: 60_000, secretScan: false });
    assert.equal(verdict.build, 'pass', verdict.logTail);
    assert.deepEqual(verdict.tests.failed, [], verdict.logTail);
    assert.match(verdict.logTail, /browser cache consumed/);
    assert.equal(existsSync(join(f.home, 'browser-cache')), false);
    assert.equal(existsSync(join(f.home, 'npm-cache')), false);
    assert.equal(readFileSync(join(f.home, 'sentinel'), 'utf8'), 'protected\n');
    assert.deepEqual(readdirSync(temporary), [], 'trial scratch is cleaned after browser checks');
  }
});


test('integration:worker-control-socket-isolation — declared TCP host executors refuse every sandbox launch before a command can connect', async () => {
  const f = await fixture();
  let reached = 0, launched = 0;
  const server = createServer(connection => { reached++; connection.end('host executor'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `tcp://127.0.0.1:${address.port}`;
  try {
    for (const variable of ['DOCKER_HOST', 'CONTAINER_HOST', 'BUILDKIT_HOST']) {
      const previous = process.env[variable];
      try {
        process.env[variable] = endpoint;
        const refusal = /host command endpoint that filesystem mounts cannot isolate/;
        assert.throws(() => readOnlyMountWrapper({ coordinatorRoot: f.root, sessionDirectory: f.worktree }), refusal);
        assert.throws(() => headlessConfinementWrapper(f.root, f.worktree), refusal);
        assert.throws(() => trialConfinement([f.config], [f.worktree]), refusal);
        await assert.rejects(masterSessionConfinement('registered', f.root), refusal);
      } finally {
        if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous;
      }
      assert.throws(() => trialConfinement([f.config], [f.worktree], undefined, [], { [variable]: endpoint }),
        /host command endpoint that filesystem mounts cannot isolate/);
      for (const extra of [{ environment: { [variable]: endpoint } }, { env: { [variable]: endpoint } }]) {
        const result = await piRunner({ command: process.execPath, ...('environment' in extra ? extra : {}),
          confine: runConfinement({ coordinatorRoot: f.root }),
          spawn: (() => { launched++; throw new Error('must refuse before spawn'); }) as typeof import('node:child_process').spawn,
        }).start('Run', { cwd: f.worktree, runs: join(f.worktree, 'runs'), tool: graphyardTools.evidence,
          validate: value => value, timeoutMs: 1000, ...('env' in extra ? extra : {}) }).result();
        assert.equal(result.ok, false);
        assert.match(JSON.stringify(result), /host command endpoint that filesystem mounts cannot isolate/);
      }
      for (const remote of [endpoint, 'ssh://host', 'https://host']) {
        await assert.rejects(startAgentSession('fixture-worker', 'registered', 'w1:p1', ['{request}'], 'Run',
          () => { launched++; return '{}'; }, { directory: f.worktree, coordinatorRoot: f.root,
            environment: { [variable]: remote }, contract: { args: ['--auto', '{request}'] } }),
          /host command endpoint that filesystem mounts cannot isolate/);
      }
    }
    assert.equal(launched, 0, 'no command reached a pane');
    assert.equal(reached, 0, 'the disposable TCP host executor received no connection');
    assert.equal(readFileSync(join(f.home, 'sentinel'), 'utf8'), 'protected\n');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

for (const kind of ['codex', 'claude'] as const) for (const inherited of [false, true]) test(`integration:worker-home-deletion-regression — master start ${kind} preserves its ${inherited ? 'inherited' : 'default'} login without granting operator HOME`, async () => {
  const f = await fixture();
  const variable = kind === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
  const login = inherited ? f.runtime : join(f.home, `.${kind}`);
  mkdirSync(login, { recursive: true }); writeFileSync(join(login, 'login'), 'existing-login');
  const bin = join(f.base, 'bin'); mkdirSync(bin);
  const executable = join(bin, kind);
  writeFileSync(executable, `#!${process.execPath}
    import fs from 'node:fs'; import assert from 'node:assert/strict';
    assert.equal(process.env.${variable}, ${JSON.stringify(login)});
    assert.equal(fs.readFileSync(process.env.${variable} + '/login', 'utf8'), 'existing-login');
    fs.writeFileSync(process.env.${variable} + '/state', 'updated');
    assert.notEqual(process.env.HOME, ${JSON.stringify(f.home)});
    fs.writeFileSync(process.env.HOME + '/scratch', 'own');
    for (const file of ${JSON.stringify([join(f.home, 'sentinel'), join(f.unrelated, 'sentinel')])})
      assert.throws(() => fs.writeFileSync(file, 'bad'), error => error.code === 'EROFS');
  `);
  chmodSync(executable, 0o700);
  git(f.root, 'remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await setupMaster(f.root, { url: 'https://graphyard.example', token: 'fixture-token-'.padEnd(40, 'x'),
    cliPath: join(process.cwd(), 'bin/graphyard.mjs'), credentialDirectory: f.config },
    async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 })));
  const previous = { HOME: process.env.HOME, [variable]: process.env[variable] };
  let launched = 0;
  const environment: Record<string, string> = { PATH: `${bin}:${process.env.PATH}` };
  try {
    process.env.HOME = f.home;
    if (inherited) process.env[variable] = login; else delete process.env[variable];
    await startMaster(f.root, kind, [], [], async (_program, args) => {
      if (args[0] === 'tab' && args[1] === 'create') {
        args.forEach((word, index) => {
          if (word === '--env') {
            const entry = args[index + 1], at = entry.indexOf('=');
            environment[entry.slice(0, at)] = entry.slice(at + 1);
          }
        });
        return JSON.stringify({ result: { pane_id: 'fixture-master' } });
      }
      if (args[0] === 'pane' && args[1] === 'run') {
        launched++;
        // Use exactly the account-null launch environment with the production master boundary.
        const confined = await masterSessionConfinement(kind, f.root, {}, runtimeLoginHomes(environment), environment);
        run(confined.wrapper, f.root, '/bin/bash', ['-ec', args[3]], environment);
      }
      return startedAtOnce(args) ?? '{}';
    });
    assert.equal(launched, 1);
    assert.equal(readFileSync(join(login, 'state'), 'utf8'), 'updated');
    assert.equal(readFileSync(join(f.home, 'sentinel'), 'utf8'), 'protected\n');
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

for (const homeVariable of ['CUSTOM_AGENT_HOME', 'HOME', 'XDG_CACHE_HOME']) test(`integration:worker-home-deletion-regression — a registered master runtime preserves assigned ${homeVariable} while sibling accounts stay read-only`, async () => {
  const f = await fixture();
  const sibling = join(f.config, 'sibling');
  mkdirSync(sibling); writeFileSync(join(sibling, 'login'), 'other-login');
  const environment = { [homeVariable]: f.runtime };
  const code = `const fs = require('node:fs'), assert = require('node:assert/strict');
    assert.equal(fs.readFileSync(process.env[${JSON.stringify(homeVariable)}] + '/login', 'utf8'), 'own-login');
    fs.writeFileSync(process.env[${JSON.stringify(homeVariable)}] + '/state', 'updated');
    assert.throws(() => fs.writeFileSync(${JSON.stringify(join(sibling, 'login'))}, 'bad'), error => ['EROFS', 'ENOENT'].includes(error.code));
    assert.throws(() => fs.writeFileSync(${JSON.stringify(join(f.home, 'sentinel'))}, 'bad'), error => ['EROFS', 'ENOENT'].includes(error.code));`;
  const worker = await coordinatorConfinement({ kind: 'registered', args: [], coordinatorRoot: f.root,
    sessionDirectory: f.worktree, credentialMask: f.mask, environment });
  assert.ok(worker);
  for (const wrapper of [worker.wrapper, headlessConfinementWrapper(f.root, f.worktree, undefined, f.mask, environment)])
    run(wrapper, f.worktree, process.execPath, ['-e', code], environment);
  let launched = 0;
  const result = await startAgentSession('fixture-master', process.execPath, 'w1:p1', ['-e', code, '{request}'], 'Run master',
    (_program, args) => {
      if (args[0] === 'pane' && args[1] === 'run') {
        launched++;
        execFileSync('/bin/bash', ['-ec', args[3]], { cwd: f.root, env: { ...process.env, ...environment }, timeout: 60_000 });
      }
      return JSON.stringify({ result: { agent: { agent: process.execPath, agent_status: 'working' } } });
    }, { directory: f.root, coordinatorRoot: f.root, confinement: 'master', environment,
      contract: { args: ['--auto', '{request}'], homeVariable },
      keyringWarning: async () => null, log: () => {} });
  assert.equal(result.started.state, 'started');
  assert.equal(launched, 1);
  assert.equal(readFileSync(join(f.runtime, 'state'), 'utf8'), 'updated');
  assert.equal(readFileSync(join(sibling, 'login'), 'utf8'), 'other-login');
});


test('integration:worker-control-socket-isolation — headless effective environments mask launch-local Unix executors', async () => {
  const f = await fixture();
  const socket = join(await temporaryDirectory('headless-socket', process.cwd()), 'executor.sock');
  let reached = 0;
  const server = createServer(connection => { reached++; connection.end(); });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try {
    for (const variable of ['DOCKER_HOST', 'CONTAINER_HOST', 'BUILDKIT_HOST']) {
      const marker = join(f.worktree, variable);
      const code = `const net = require('node:net'), fs = require('node:fs');
        const socket = net.connect(process.env.${variable}.slice(7));
        socket.on('connect', () => { socket.destroy(); process.exitCode = 1; });
        socket.on('error', () => fs.writeFileSync(${JSON.stringify(marker)}, 'denied'));`;
      const result = await piRunner({ command: process.execPath, commandArgs: ['-e', code, '--'],
        environment: { [variable]: `unix://${socket}` },
        confine: runConfinement({ coordinatorRoot: f.root }), containment: 'setsid', pollMs: 10, exitGraceMs: 10,
      }).start('Run', { cwd: f.worktree, runs: join(f.worktree, 'runs'), tool: graphyardTools.evidence,
        validate: value => value, timeoutMs: 10_000 }).result();
      assert.equal(readFileSync(marker, 'utf8'), 'denied', JSON.stringify(result));
    }
    assert.equal(reached, 0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('integration:worker-control-socket-isolation — trial launch refusal cleans every allocation on repeated attempts', async () => {
  const f = await fixture();
  const base = await temporaryDirectory('trial-refusal-sessions', process.cwd());
  const temporary = await temporaryDirectory('trial-refusal-temp', process.cwd());
  const places = await temporaryDirectory('trial-refusal-checkouts', process.cwd());
  const before = git(f.root, 'worktree', 'list', '--porcelain');
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(runTrialAttempt({ root: f.root, base, mergeSha: git(f.root, 'rev-parse', 'HEAD'),
      changedFiles: [], timeoutMs: 1000, temporaryRoots: [temporary], checkoutRoots: [places],
      minFreeBytes: 0, environment: { DOCKER_HOST: 'tcp://127.0.0.1:2375' },
    }), /host command endpoint that filesystem mounts cannot isolate/);
    assert.deepEqual(readdirSync(temporary), []);
    assert.deepEqual(readdirSync(places), []);
    assert.equal(git(f.root, 'worktree', 'list', '--porcelain'), before);
    assert.equal(existsSync(base), false, 'the empty managed session root is removed');
  }
});


test('integration:worker-control-socket-isolation — assigning runtime HOME still masks the operator home launch sockets', async () => {
  const f = await fixture();
  const directory = join(f.home, '.docker', 'run');
  mkdirSync(directory, { recursive: true });
  const socket = join(directory, 'docker.sock');
  let reached = 0;
  const server = createServer(connection => { reached++; connection.end(); });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  const previous = process.env.HOME;
  try {
    process.env.HOME = f.home;
    const environment = { HOME: f.runtime };
    const wrapper = headlessConfinementWrapper(f.root, f.worktree, undefined, f.mask, environment);
    run(wrapper, f.worktree, process.execPath, ['-e', `
      const net = require('node:net'), assert = require('node:assert/strict');
      assert.equal(process.env.HOME, ${JSON.stringify(f.runtime)});
      const socket = net.connect(${JSON.stringify(socket)});
      socket.on('connect', () => { socket.destroy(); process.exitCode = 1; });
      socket.on('error', () => {});
    `], environment);
    assert.equal(reached, 0);
  } finally {
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
