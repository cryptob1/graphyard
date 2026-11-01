import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { coordinatorConfinement, readOnlyMountWrapper } from '../src/master/confinement.js';
import { headlessConfinementWrapper, masterSessionConfinement, prepareConfinedGitPaths } from '../src/master/launch.js';
import { trialConfinement } from '../src/merge-writer/trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
async function fixture() {
  // Outside /tmp: these protected files remain visible through the read-only host mount.
  // Every destructive probe below names only this disposable fixture, never the real HOME.
  const base = await temporaryDirectory('fs', process.cwd());
  const root = join(base, 'repo'), home = join(base, 'home'), unrelated = join(base, 'other');
  const config = join(base, 'config'), runtime = join(config, 'own');
  for (const path of [root, home, unrelated, runtime]) mkdirSync(path, { recursive: true });
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
  const wrapper = readOnlyMountWrapper({ coordinatorRoot: root, sessionDirectory: worktree, credentialMask: mask, secretsBus: null });
  return { base, root, worktree, home, unrelated, config, runtime, mask, wrapper };
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
const deny = fn => assert.throws(fn, error => ['EROFS', 'EACCES', 'EPERM', 'EBUSY', 'EXDEV'].includes(error.code));
for (const directory of [home, unrelated, root]) {
  const file = path.join(directory, directory === root ? 'package.json' : 'sentinel');
  assert.ok(fs.readFileSync(file).length, 'protected host files are visible');
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
    echo edit > edit; git add edit; git commit -qm edit
    /usr/bin/npm run build; /usr/bin/npm test
    test "$HOME" != "$3"
    mkdir -p "$HOME/.cache"; echo cache > "$HOME/.cache/runtime"
    scratch=$(mktemp -d); echo scratch > "$scratch/owned"; rm -rf "$scratch"; test ! -e "$scratch"
    test ! -e /dev/disk; test ! -e /dev/mem
  `, 'allowed', f.config, f.runtime, process.env.HOME ?? '']);
  assert.notEqual(git(f.worktree, 'rev-parse', 'HEAD'), before);
  assert.equal(readFileSync(join(f.worktree, 'built'), 'utf8'), 'built');
  assert.equal(readFileSync(join(f.runtime, 'state'), 'utf8'), 'state\n');
});

test('integration:worker-control-socket-isolation — host Docker, systemd and custom launch sockets cannot receive sandbox commands', async () => {
  const f = await fixture();
  const sockets = await temporaryDirectory('s', f.base);
  const socket = join(f.base, 'docker.sock');
  const runtimeSocket = join(sockets, 'launch.sock');
  let reached = 0;
  const server = createServer(connection => { reached++; connection.end('host command executor'); });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  const runtimeServer = createServer(connection => { reached++; connection.end('host runtime executor'); });
  await new Promise<void>(resolve => runtimeServer.listen(runtimeSocket, resolve));
  const oldRuntime = process.env.XDG_RUNTIME_DIR, oldDocker = process.env.DOCKER_HOST;
  try {
    process.env.XDG_RUNTIME_DIR = sockets;
    process.env.DOCKER_HOST = `unix://${socket}`;
    // Construct wrappers after publishing a nonstandard host command endpoint.
    const wrappers = [readOnlyMountWrapper({ coordinatorRoot: f.root, sessionDirectory: f.worktree, secretsBus: null }),
      headlessConfinementWrapper(f.root, f.worktree), (await masterSessionConfinement('claude', f.root)).wrapper,
      trialConfinement([f.config], [f.worktree])];
    for (const wrapper of wrappers) {
      run(wrapper, f.worktree, process.execPath, ['-e', `
        const net = require('node:net'), fs = require('node:fs'), assert = require('node:assert/strict');
        const endpoints = [${JSON.stringify(socket)}, ${JSON.stringify(runtimeSocket)}, '/run/docker.sock', '/var/run/docker.sock', '/run/dbus/system_bus_socket',
          ${JSON.stringify(join(sockets, 'bus'))}, ${JSON.stringify(join(sockets, 'systemd', 'private'))}];
        Promise.all(endpoints.map(path => new Promise((resolve, reject) => {
          const socket = net.connect(path); socket.on('connect', () => { socket.destroy(); reject(new Error('host socket reached: ' + path)); });
          socket.on('error', () => resolve());
        }))).catch(error => { console.error(error); process.exitCode = 1; });
        assert.ok(!fs.existsSync('/dev/disk'));
      `]);
    }
    assert.equal(reached, 0, 'no host command executor received a connection');
    assert.ok(existsSync(socket), 'the host socket itself survives');
  } finally {
    if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = oldRuntime;
    if (oldDocker === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = oldDocker;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => runtimeServer.close(() => resolve()));
  }
});
