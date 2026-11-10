import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coordinatorConfinement, credentialMaskFor, sessionMountNamespaceWorks, type MaskProbe } from '../src/master/confinement.js';
import { prepareConfinedGitPaths } from '../src/master/launch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3248: the GY-3228 mask left the host user's package-manager credentials readable, so a
// confined worker could print the owner's npm publish token from ~/.npmrc. Under real bubblewrap,
// with a fixture HOME holding ~/.npmrc and its siblings, the worker reads none of them and
// `npm install` of a public package in its worktree still succeeds.

const secret = 'npm-publish-secret-'.padEnd(48, 'x');
const hostProbe: MaskProbe = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('e2e:host-npmrc-masked — under real bwrap a confined worker cannot read ~/.npmrc or its siblings and npm install of a public package in its worktree still succeeds', async () => {
  // The fixture HOME lives in this checkout: the sandbox replaces /tmp with its own scratch.
  const checkout = dirname(dirname(fileURLToPath(import.meta.url)));
  mkdirSync(join(checkout, '.graphyard'), { recursive: true });
  const home = await temporaryDirectory('host-npmrc-home', join(checkout, '.graphyard'));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const root = join(home, 'code', 'project'), worktree = join(root, '.graphyard', 'worktrees', 'gy-1-1');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '.gitignore'), '.graphyard/\nnode_modules/\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', private: true }));
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'seed');
    mkdirSync(dirname(worktree), { recursive: true });
    git(root, 'worktree', 'add', '-q', '-b', 'graphyard/gy-1-1', worktree, 'main');
    prepareConfinedGitPaths(root);

    const credentials = ['.npmrc', '.yarnrc.yml', '.pypirc', '.gem/credentials', '.cargo/credentials.toml'].map(path => join(home, path));
    for (const file of credentials) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `//registry.npmjs.org/:_authToken=${secret}\n`, { mode: 0o600 });
    }
    const configHome = join(home, '.config', 'graphyard'), workerToken = join(configHome, 'own-install', 'workers', 'worker.token');
    mkdirSync(dirname(workerToken), { recursive: true });
    writeFileSync(workerToken, 'worker-own-token\n', { mode: 0o600 });
    assert.ok(await sessionMountNamespaceWorks(), 'mount namespaces work on this host');

    const worker = await coordinatorConfinement({ kind: 'pi', args: [], coordinatorRoot: root, sessionDirectory: worktree, platform: 'linux', mountNamespaceWorks: true, bwrap: 'bwrap', secretsBus: null, maskProbe: hostProbe,
      credentialMask: credentialMaskFor({}, { credentialFile: workerToken }, configHome) });
    assert.ok(worker);
    const flow = [
      'for p in "$@"; do if test -r "$p"; then echo "READABLE $p"; else echo "DENIED $p"; fi; cat "$p" 2>/dev/null; done',
      `cd ${JSON.stringify(worktree)} && npm install is-number --no-audit --no-fund --no-save && echo NPM-INSTALL-OK`,
    ].join('\n');
    const ran = spawnSync(worker.wrapper[0], [...worker.wrapper.slice(1), '/bin/sh', '-c', flow, 'sh', ...credentials],
      { encoding: 'utf8', timeout: 300_000, killSignal: 'SIGKILL', env: { ...process.env, HOME: home, npm_config_cache: join(worktree, '.npm-cache') } });
    const output = ran.stdout + '\n' + ran.stderr;
    assert.equal(ran.status, 0, `the confined worker ran: ${output.slice(-800)}`);
    assert.ok(!output.includes(secret), `no package-manager token is reachable: ${output.slice(-800)}`);
    for (const path of credentials) assert.ok(ran.stdout.includes(`DENIED ${path}\n`), `the worker cannot read ${path}: ${output.slice(-800)}`);
    assert.ok(ran.stdout.includes('NPM-INSTALL-OK') && existsSync(join(worktree, 'node_modules', 'is-number', 'package.json')), `npm install still succeeds: ${output.slice(-800)}`);
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});
