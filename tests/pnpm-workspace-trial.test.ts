import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { runTrial, trialMerge } from '../src/merge-writer/trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { writePnpmWorkspace } from './helpers/pnpm-workspace-fixture.js';

// GY-3200: the merge trial installs a pnpm workspace with its frozen lockfile and builds only what
// the change affects: the changed packages, their dependents and those packages' dependencies.
// The case fetches pnpm through npm exec once (registry access); the trial's children share the
// host's npm cache, so later runs reuse it.

const identity = {
  GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com',
  GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
const sharedCache = process.env.npm_config_cache || join(homedir(), '.npm');
// The trial's children run here directly, not in the trial container, with the host's npm cache.
const run: ChildRun = (command, args, { wrapper: _wrapper, ...options } = {}) =>
  defaultChildRun(command, args, { ...options, ...(options.env ? { env: { ...options.env, npm_config_cache: sharedCache } } : {}) });

async function trialOf(change: Record<string, string>) {
  const root = await temporaryDirectory('pnpm-workspace-trial', tmpdir());
  git(root, 'init', '-q', '-b', 'main');
  writePnpmWorkspace(root);
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  writePnpmWorkspace(root, change);
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'change');
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', '--detach', base);
  const merged = await trialMerge(async args => git(root, ...args), { head, baseTip: base });
  assert.ok('mergeSha' in merged);
  return runTrial({
    root, base: await temporaryDirectory('pnpm-workspace-trial-root', tmpdir()), mergeSha: merged.mergeSha, baseTip: base,
    changedFiles: git(root, 'diff', '--name-only', base, head).split('\n').filter(Boolean),
    timeoutMs: 300_000, environment: { PATH: process.env.PATH! }, run, retries: 0,
  });
}
const built = (log: string) => ['packages/shared', 'apps/one', 'apps/two'].filter(dir => new RegExp(`^${dir} build: Done`, 'm').test(log));

test('integration:pnpm-workspace-trial — a change to one app builds that app (after its shared dependency) and not the other; a change to the shared package builds it and both apps; a broken build in the affected app fails the trial', async () => {
  const one = await trialOf({ 'apps/one/build.mjs': `${'// changed\n'}import { readFileSync, writeFileSync } from 'node:fs';\nwriteFileSync('built.txt', readFileSync('node_modules/shared/dist/index.txt', 'utf8'));\n` });
  assert.equal(one.build, 'pass', one.logTail);
  assert.match(one.logTail, /npm exec --yes -- pnpm@10\.34\.9 install --frozen-lockfile/);
  assert.deepEqual(built(one.logTail), ['packages/shared', 'apps/one'], one.logTail);
  assert.deepEqual(one.tests.failed, [], one.logTail);

  const shared = await trialOf({ 'packages/shared/build.mjs': `import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('dist', { recursive: true });\nwriteFileSync('dist/index.txt', 'shared v2');\n` });
  assert.equal(shared.build, 'pass', shared.logTail);
  assert.deepEqual(built(shared.logTail), ['packages/shared', 'apps/one', 'apps/two'], shared.logTail);

  const broken = await trialOf({ 'apps/two/build.mjs': 'process.exit(1);\n' });
  assert.equal(broken.build, 'fail', broken.logTail);
  assert.match(broken.logTail, /apps\/two build/);
});
