import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { runTrial, trialMerge } from '../src/merge-writer/trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { pnpmWorkspaceFiles, writePnpmWorkspace } from './helpers/pnpm-workspace-fixture.js';

// GY-3207: the merge trial installs and builds a checkout under the Node major it declares. The
// fixture is the pnpm workspace (workspace:* links only) with engine-strict=true and engines.node
// pinned to a major the running node is not, so its install refuses any other node. The case
// fetches pnpm and that node through npm exec once (registry access); the trial's children share
// the host's npm cache, so later runs reuse both.

const pin = process.versions.node.startsWith('22.') ? 24 : 22;
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
const records = "console.log('node ' + process.version);\n";

test(`integration:node-pin-trial — a pnpm workspace with engine-strict=true and engines.node ${pin} installs and builds in the merge trial under node ${pin}, not the running node ${process.version}`, async () => {
  const root = await temporaryDirectory('node-pin-trial', tmpdir());
  git(root, 'init', '-q', '-b', 'main');
  writePnpmWorkspace(root, {
    'package.json': JSON.stringify({ ...JSON.parse(pnpmWorkspaceFiles['package.json']!), engines: { node: String(pin) } }, null, 2),
    '.npmrc': 'engine-strict=true\n',
  });
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  writePnpmWorkspace(root, { 'packages/shared/build.mjs': pnpmWorkspaceFiles['packages/shared/build.mjs']! + records });
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'change');
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', '--detach', base);
  const merged = await trialMerge(async args => git(root, ...args), { head, baseTip: base });
  assert.ok('mergeSha' in merged);
  const trial = await runTrial({
    root, base: await temporaryDirectory('node-pin-trial-root', tmpdir()), mergeSha: merged.mergeSha, baseTip: base,
    changedFiles: git(root, 'diff', '--name-only', base, head).split('\n').filter(Boolean),
    timeoutMs: 300_000, environment: { PATH: process.env.PATH! }, run, retries: 0,
  });
  assert.equal(trial.build, 'pass', trial.logTail);
  assert.match(trial.logTail, new RegExp(`--package=node@${pin} -- node -p process\\.execPath`));
  const built = /^packages\/shared build: node (v\d+)\./m.exec(trial.logTail)?.[1];
  assert.equal(built, `v${pin}`, trial.logTail);
  assert.deepEqual(trial.tests.failed, [], trial.logTail);
});
