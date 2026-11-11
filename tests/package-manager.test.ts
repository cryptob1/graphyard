import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { affectedPackages, buildArgv, installArgv, packageManager, testArgv } from '../src/package-manager.js';
import { containedInstall, npmCiArgs } from '../src/cli/test-isolation.js';
import { ensureWorktreeDependencies } from '../src/repository-setup.js';
import { managedServePorts } from '../src/cli/upgrade.js';
import { serveCheckoutPath } from '../src/serve-app.js';
import { runTrial, trialMerge } from '../src/merge-writer/trial.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { writePnpmWorkspace } from './helpers/pnpm-workspace-fixture.js';

// GY-3200: one helper reads the lockfile; npm checkouts keep today's commands, pnpm ones run
// through `npm exec --yes -- pnpm@<version>` in the trial, worktree setup and the serve pass.

const pnpm10 = ['npm', 'exec', '--yes', '--', 'pnpm@10.34.9'];
const write = (root: string, files: Record<string, string>) => { for (const [path, content] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); } };
const turboWorkspace = async () => {
  const root = await temporaryDirectory('package-manager', tmpdir());
  writePnpmWorkspace(root, { 'turbo.json': '{}', 'package.json': JSON.stringify({ name: 'w', packageManager: 'pnpm@10.34.9+sha512.abc', devDependencies: { turbo: '^2' } }) });
  return root;
};

test('unit:tests/package-manager.test.ts — npm checkout unchanged: a package-lock.json checkout keeps npm ci, npm run build and npm test, and containedInstall runs the command it is given', async () => {
  const root = await temporaryDirectory('package-manager', tmpdir());
  write(root, { 'package.json': '{"name":"x"}', 'package-lock.json': '{}' });
  const manager = packageManager(root);
  assert.deepEqual(manager, { name: 'npm' });
  assert.deepEqual(installArgv(manager), ['npm', ...npmCiArgs]);
  assert.deepEqual(buildArgv(manager, null), ['npm', 'run', 'build']);
  assert.deepEqual(testArgv(manager, ['a']), ['npm', 'test']);
  const contained = containedInstall(root, installArgv(manager), { PATH: process.env.PATH, HOME: root }, { bwrap: '/usr/bin/bwrap' });
  assert.deepEqual(contained.args.slice(contained.args.indexOf('--') + 1), ['npm', ...npmCiArgs]);
});

test('unit:tests/package-manager.test.ts — pnpm install paths: a pnpm checkout installs with pnpm install --frozen-lockfile in worktree setup, the serve pass and the trial (never through a node_modules link)', async () => {
  const root = await temporaryDirectory('package-manager', tmpdir());
  writePnpmWorkspace(root);
  assert.deepEqual(installArgv(packageManager(root)), [...pnpm10, 'install', '--frozen-lockfile']);
  // No packageManager field: pnpm 10.
  assert.deepEqual(installArgv(packageManager((write(join(root, 'bare'), { 'pnpm-lock.yaml': '', 'package.json': '{}' }), join(root, 'bare')))), ['npm', 'exec', '--yes', '--', 'pnpm@10', 'install', '--frozen-lockfile']);

  // Worktree setup: always installs, contained, with npm exec's _npx folder writable, and reports installed or failed.
  const contained = containedInstall(root, installArgv(packageManager(root)), { PATH: process.env.PATH, HOME: root, npm_config_cache: join(root, 'cache') }, { bwrap: '/usr/bin/bwrap' });
  assert.deepEqual(contained.args.slice(contained.args.indexOf('--') + 1), [...pnpm10, 'install', '--frozen-lockfile']);
  assert.ok(contained.args.join(' ').includes(`--bind ${join(root, 'cache', '_npx')}`));
  const installs: string[] = [];
  assert.equal((await ensureWorktreeDependencies(root, async cwd => { installs.push(cwd); })).state, 'installed');
  assert.equal((await ensureWorktreeDependencies(root, async () => { throw new Error('lockfile out of date'); })).state, 'failed');
  assert.deepEqual(installs, [root]);

  // The serve pass.
  const served: string[][] = [];
  writePnpmWorkspace(serveCheckoutPath(root));
  await managedServePorts({ root, baseBranch: 'main', run: (command, args) => { served.push([command, ...args]); return ''; } }).install();
  assert.deepEqual(served, [[...pnpm10, 'install', '--frozen-lockfile']]);

  // The trial: installs afresh even though the root holds a node_modules, then builds and tests through pnpm.
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@a' } }).trim();
  git('init', '-q', '-b', 'main'); write(root, { '.gitignore': 'node_modules\n.graphyard\n' }); git('add', '-A'); git('commit', '-q', '-m', 'base');
  mkdirSync(join(root, 'node_modules'));
  const base = git('rev-parse', 'HEAD');
  write(root, { 'apps/one/build.mjs': '// changed\n' }); git('commit', '-q', '-am', 'change');
  const merged = await trialMerge(async args => git(...args), { head: git('rev-parse', 'HEAD'), baseTip: base });
  assert.ok('mergeSha' in merged);
  const ran: string[][] = [];
  const run: ChildRun = (command, args, options) => { if (command !== 'npm') return defaultChildRun(command, args, options); ran.push([command, ...args]); return ''; };
  const trial = await runTrial({ root, base: await temporaryDirectory('package-manager-root', tmpdir()), mergeSha: merged.mergeSha, baseTip: base, changedFiles: ['apps/one/build.mjs'], timeoutMs: 60_000, environment: { PATH: process.env.PATH! }, run, retries: 0 });
  assert.equal(trial.build, 'pass', trial.logTail);
  assert.deepEqual(ran, [
    [...pnpm10, 'install', '--frozen-lockfile'],
    [...pnpm10, '--recursive', '--if-present', '--filter=one...', 'run', 'build'],
    [...pnpm10, 'test'],
  ]);
});

test('unit:tests/package-manager.test.ts — turbo build and test: with turbo.json and a turbo devDependency the build and tests run through turbo on the affected packages (changed ones and their dependents), and a root-trigger change selects everything', async () => {
  const root = await turboWorkspace();
  const manager = packageManager(root);
  assert.deepEqual(manager, { name: 'pnpm', version: '10.34.9', workspace: true, turbo: true });
  assert.deepEqual(affectedPackages(root, ['apps/one/page.tsx', 'README.md']), { packages: ['one'], summary: 'one (changed)' });
  assert.deepEqual(affectedPackages(root, ['packages/shared/a.ts']), { packages: ['shared', 'one', 'two'], summary: 'shared (changed), one (depends on shared), two (depends on shared)' });
  assert.deepEqual(affectedPackages(root, ['README.md']), { packages: [], summary: 'none (no workspace package changed)' });
  assert.deepEqual(buildArgv(manager, ['one']), [...pnpm10, 'exec', 'turbo', 'run', 'build', '--filter=one']);
  assert.deepEqual(testArgv(manager, ['one']), [...pnpm10, 'exec', 'turbo', 'run', 'test', '--filter=one']);
  assert.deepEqual(buildArgv(manager, []), [...pnpm10, 'exec', 'turbo', 'run', 'build', '--filter=//']);
  for (const trigger of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'turbo.json', '.npmrc', 'tsconfig.base.json']) {
    assert.deepEqual(affectedPackages(root, ['apps/one/page.tsx', trigger]), { packages: null, summary: `all (root trigger ${trigger})` }, trigger);
  }
  assert.deepEqual(buildArgv(manager, null), [...pnpm10, 'exec', 'turbo', 'run', 'build']);
  assert.deepEqual(testArgv(manager, null), [...pnpm10, 'exec', 'turbo', 'run', 'test']);
  // A nested package.json or tsconfig is no root trigger.
  assert.deepEqual(affectedPackages(root, ['apps/one/package.json', 'apps/one/tsconfig.json']).packages, ['one']);
  // A workspace manifest the merge broke is the merge's failed install, never the host's trial:
  // selection reads it as empty instead of throwing (it names by directory, as a nameless one does).
  write(root, { 'apps/two/package.json': '' });
  assert.deepEqual(affectedPackages(root, ['apps/one/page.tsx']), { packages: ['one'], summary: 'one (changed)' });
  assert.deepEqual(affectedPackages(root, ['apps/two/page.tsx']), { packages: ['apps/two'], summary: 'apps/two (changed)' });
  // A packages list that yields no patterns (flow style, comments) selects all, never silently none.
  write(root, { 'pnpm-workspace.yaml': 'packages: [apps/*, packages/*]\n' });
  assert.deepEqual(affectedPackages(root, ['apps/one/page.tsx']), { packages: null, summary: 'all (packages list not parsed)' });
  // Without turbo, pnpm builds the affected packages with their dependencies, everything on a root trigger, and nothing when none changed.
  const plain = { ...manager, turbo: false };
  assert.deepEqual(buildArgv(plain, ['one']), [...pnpm10, '--recursive', '--if-present', '--filter=one...', 'run', 'build']);
  assert.deepEqual(buildArgv(plain, null), [...pnpm10, '--recursive', '--if-present', 'run', 'build']);
  assert.equal(buildArgv(plain, []), null);
  assert.deepEqual(testArgv(plain, ['one']), [...pnpm10, 'test']);
});
