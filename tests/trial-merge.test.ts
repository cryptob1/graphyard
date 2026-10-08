import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { defaultChildRun } from '../src/child-runner.js';
import { runTrial, trialAuthor, trialEnvironment, trialMerge, trialRef, withheldTrialVariables } from '../src/merge-writer/trial.js';
import { checkoutKinds } from '../src/install/worktree-root.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1522: the shadow gate's trial merge — the exact merge commit made in the object store, and its
// build and affected tests run in a detached, credential-free checkout that is always removed.

const identity = { GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com', GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
const gitFor = (root: string) => async (args: string[], env: Record<string, string> = {}) => String(await defaultChildRun('git', ['-C', root, ...args], { env: { ...process.env, ...identity, ...env } }));
// The install this checkout resolves, wherever it sits above it.
const installedModules = resolve(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), '..');

async function repository(files: Record<string, string>) {
  const root = await temporaryDirectory('trial-merge-repo');
  gitIn(root, 'init', '-q', '-b', 'main');
  const write = (path: string, content: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  for (const [path, content] of Object.entries(files)) write(path, content);
  gitIn(root, 'add', '-A'); gitIn(root, 'commit', '-q', '-m', 'base');
  const base = gitIn(root, 'rev-parse', 'HEAD');
  /** A branch off base with the given files, left as a commit (no branch ref survives, so refs/heads holds main only). */
  const commitOnBase = (files: Record<string, string>, message: string) => {
    gitIn(root, 'checkout', '-q', '--detach', base);
    for (const [path, content] of Object.entries(files)) write(path, content);
    gitIn(root, 'add', '-A'); gitIn(root, 'commit', '-q', '-m', message);
    const sha = gitIn(root, 'rev-parse', 'HEAD');
    gitIn(root, 'checkout', '-q', 'main');
    return sha;
  };
  return { root, base, commitOnBase, write };
}

test('unit:trial-merge-exact-commit — trialMerge makes the merge commit of head onto the base tip in the object store: parents [baseTip, head], the merged tree, author graphyard-merge-writer, only refs/graphyard/trial/<head> written, and no worktree, branch or remote touched', async () => {
  const repo = await repository({ 'a.txt': 'one\n', 'b.txt': 'two\n' });
  const baseTip = gitIn(repo.root, 'commit-tree', gitIn(repo.root, 'rev-parse', 'HEAD^{tree}'), '-p', repo.base, '-m', 'main moved');
  gitIn(repo.root, 'reset', '-q', '--hard', baseTip);
  // main moved by editing b.txt; the head edits a.txt from the older base.
  writeFileSync(join(repo.root, 'b.txt'), 'two main\n'); gitIn(repo.root, 'commit', '-q', '-am', 'main edit');
  const tip = gitIn(repo.root, 'rev-parse', 'HEAD');
  const head = repo.commitOnBase({ 'a.txt': 'one head\n' }, 'head edit');
  const before = { heads: gitIn(repo.root, 'for-each-ref', 'refs/heads'), status: gitIn(repo.root, 'status', '--porcelain'), worktrees: gitIn(repo.root, 'worktree', 'list'), remotes: gitIn(repo.root, 'remote') };
  const result = await trialMerge(gitFor(repo.root), { head, baseTip: tip });
  assert.ok('mergeSha' in result, JSON.stringify(result));
  assert.equal(gitIn(repo.root, 'rev-list', '--parents', '-n', '1', result.mergeSha), `${result.mergeSha} ${tip} ${head}`, 'the parents are the base tip, then the head');
  assert.equal(gitIn(repo.root, 'rev-parse', `${result.mergeSha}^{tree}`), result.tree);
  assert.equal(gitIn(repo.root, 'show', `${result.mergeSha}:a.txt`), 'one head', 'the head\'s change is in the merge');
  assert.equal(gitIn(repo.root, 'show', `${result.mergeSha}:b.txt`), 'two main', 'and main\'s');
  assert.equal(gitIn(repo.root, 'log', '-1', '--format=%an', result.mergeSha), trialAuthor);
  assert.equal(gitIn(repo.root, 'rev-parse', trialRef(head)), result.mergeSha, 'the one ref written');
  assert.equal(gitIn(repo.root, 'for-each-ref', '--format=%(refname)', 'refs/graphyard'), trialRef(head));
  assert.deepEqual({ heads: gitIn(repo.root, 'for-each-ref', 'refs/heads'), status: gitIn(repo.root, 'status', '--porcelain'), worktrees: gitIn(repo.root, 'worktree', 'list'), remotes: gitIn(repo.root, 'remote') }, before, 'no branch, worktree, index or remote moved');
  await assert.rejects(trialMerge(gitFor(repo.root), { head: 'main', baseTip: tip }), /full 40-hex/);
});

test('unit:trial-merge-conflict-reported — a head that conflicts with the base tip gives the conflicted paths and writes no commit and no ref', async () => {
  const repo = await repository({ 'a.txt': 'one\n', 'c.txt': 'clean\n' });
  writeFileSync(join(repo.root, 'a.txt'), 'main side\n'); gitIn(repo.root, 'commit', '-q', '-am', 'main edit');
  const tip = gitIn(repo.root, 'rev-parse', 'HEAD');
  const head = repo.commitOnBase({ 'a.txt': 'head side\n', 'd.txt': 'new\n' }, 'head edit');
  const result = await trialMerge(gitFor(repo.root), { head, baseTip: tip });
  assert.deepEqual(result, { conflict: ['a.txt'] });
  assert.equal(gitIn(repo.root, 'for-each-ref', 'refs/graphyard'), '', 'a conflict writes no ref');
  assert.equal(gitIn(repo.root, 'status', '--porcelain'), '');
});

const fixtureFiles = {
  '.gitignore': 'node_modules\n',
  'package.json': JSON.stringify({ name: 'fixture', scripts: { build: 'node build.js' } }),
  'package-lock.json': '{"lockfileVersion":3}\n',
  'build.js': "const { existsSync } = require('node:fs'); console.log('ENV:' + JSON.stringify({ keys: Object.keys(process.env), global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM })); if (existsSync('break-build')) { console.error('build broke'); process.exit(1); }\n",
  'scripts/ci-tests.mjs': "const files = process.argv.slice(3); console.log('affected: selected'); for (const file of files) if (file.startsWith('tests/')) console.log(file);\n",
  'tests/helpers/run-tests.ts': "import { readFileSync } from 'node:fs'; const list = process.argv[process.argv.indexOf('--files-from') + 1]; const files = readFileSync(list, 'utf8').split('\\n').filter(Boolean); for (const file of files) console.log((file.includes('bad') ? 'not ok - ' : 'ok - ') + file); if (files.some(file => file.includes('bad'))) process.exit(1);\n",
};
const fixture = async () => {
  const repo = await repository(fixtureFiles);
  symlinkSync(installedModules, join(repo.root, 'node_modules'));
  gitIn(repo.root, 'config', 'user.name', 'x');
  return repo;
};
const trialOf = async (repo: Awaited<ReturnType<typeof fixture>>, head: string, changedFiles: string[], environment: NodeJS.ProcessEnv = { PATH: process.env.PATH! }) => {
  const merged = await trialMerge(gitFor(repo.root), { head, baseTip: repo.base });
  assert.ok('mergeSha' in merged);
  const base = await temporaryDirectory('trial-merge-root');
  const result = await runTrial({ root: repo.root, base, mergeSha: merged.mergeSha, changedFiles, timeoutMs: 120_000, key: 'GY-9', environment });
  return { result, base };
};

test('integration:trial-run-build-and-tests — the merge commit is checked out detached as a trial checkout, npm run build then the affected tests run, the verdict reports build, passed and failed files and the duration, and the checkout is removed pass or fail', async () => {
  assert.ok((checkoutKinds as readonly string[]).includes('trial'));
  const repo = await fixture();
  const good = repo.commitOnBase({ 'src/a.ts': 'export {};\n', 'tests/a.test.ts': 'x\n' }, 'good head');
  const passing = await trialOf(repo, good, ['src/a.ts', 'tests/a.test.ts']);
  assert.equal(passing.result.build, 'pass', passing.result.logTail);
  assert.deepEqual(passing.result.tests, { passed: 1, failed: [], files: 1 }, passing.result.logTail);
  assert.ok(passing.result.durationMs >= 0 && passing.result.logTail.includes('ok - tests/a.test.ts'));
  assert.equal(existsSync(passing.base) ? readdirSync(passing.base).length : 0, 0, 'the trial checkout is removed after a pass');
  assert.equal(gitIn(repo.root, 'worktree', 'list').split('\n').length, 1, 'and its registration with it');

  const failing = repo.commitOnBase({ 'tests/bad.test.ts': 'x\n', 'tests/ok.test.ts': 'x\n' }, 'failing head');
  const failed = await trialOf(repo, failing, ['tests/bad.test.ts', 'tests/ok.test.ts']);
  assert.equal(failed.result.build, 'pass');
  assert.deepEqual(failed.result.tests, { passed: 1, failed: ['tests/bad.test.ts'], files: 2 }, failed.result.logTail);
  assert.equal(existsSync(failed.base) ? readdirSync(failed.base).length : 0, 0, 'and after a test failure');

  const broken = repo.commitOnBase({ 'break-build': '', 'tests/a.test.ts': 'x\n' }, 'breaks the build');
  const noBuild = await trialOf(repo, broken, ['tests/a.test.ts']);
  assert.equal(noBuild.result.build, 'fail');
  assert.deepEqual(noBuild.result.tests, { passed: 0, failed: [], files: 0 }, 'no test runs after a failed build');
  assert.match(noBuild.result.logTail, /build broke/);
  assert.equal(existsSync(noBuild.base) ? readdirSync(noBuild.base).length : 0, 0, 'and after a failed build');
});

test('unit:trial-run-credential-free — the trial child sees none of GH_CONFIG_DIR, GH_TOKEN, GITHUB_TOKEN, SSH_AUTH_SOCK, GIT_SSH_COMMAND or any GRAPHYARD_*/HERDR_* variable, and git\'s global configuration is off', async () => {
  const planted: NodeJS.ProcessEnv = { PATH: process.env.PATH!, GH_CONFIG_DIR: '/home/me/.config/gh', GH_TOKEN: 'gh-secret', GITHUB_TOKEN: 'github-secret', SSH_AUTH_SOCK: '/run/agent.sock', GIT_SSH_COMMAND: 'ssh -i key',
    GRAPHYARD_TOKEN: 'graphyard-secret', GRAPHYARD_URL: 'https://example.test', GRAPHYARD_TIMING_RECORD: '/tmp/record', HERDR_PANE_ID: 'p1', HERDR_SOCKET_PATH: '/run/herdr.sock', GIT_CONFIG_GLOBAL: '/home/me/.gitconfig', KEPT: 'yes' };
  const environment = trialEnvironment(planted);
  for (const name of [...withheldTrialVariables, 'GRAPHYARD_TOKEN', 'GRAPHYARD_URL', 'GRAPHYARD_TIMING_RECORD', 'HERDR_PANE_ID', 'HERDR_SOCKET_PATH']) assert.ok(!(name in environment), `${name} is withheld`);
  assert.equal(environment.KEPT, 'yes');
  assert.equal(environment.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(environment.GIT_CONFIG_GLOBAL, '/dev/null');
  // And the child that runs the build sees exactly that.
  const repo = await fixture();
  const head = repo.commitOnBase({ 'src/a.ts': 'export {};\n' }, 'head');
  const { result } = await trialOf(repo, head, ['src/a.ts'], planted);
  const seen = JSON.parse(/ENV:(.*)/.exec(result.logTail)![1]!) as { keys: string[]; global: string; nosystem: string };
  for (const name of [...withheldTrialVariables, 'GRAPHYARD_TOKEN', 'GRAPHYARD_URL', 'GRAPHYARD_TIMING_RECORD', 'HERDR_PANE_ID', 'HERDR_SOCKET_PATH']) assert.ok(!seen.keys.includes(name), `the child saw ${name}`);
  assert.ok(seen.keys.includes('KEPT'));
  assert.deepEqual([seen.global, seen.nosystem], ['/dev/null', '1']);
});

test('integration:trial-run-build-and-tests — a merge that changes the lockfile installs its own dependencies with npm ci, and one that leaves it alone reuses the coordinator\'s install', async () => {
  const repo = await fixture();
  const same = repo.commitOnBase({ 'src/a.ts': 'export {};\n' }, 'no dependency change');
  const changed = repo.commitOnBase({ 'package-lock.json': '{"lockfileVersion":3,"packages":{"x":{}}}\n' }, 'new lockfile');
  const commands: string[] = [];
  const run = ((command: string, args: string[], options: { cwd?: string }) => {
    commands.push(`${command} ${args[0]}`);
    if (command === 'npm' && args[0] === 'ci') { assert.ok(!existsSync(join(options.cwd!, 'node_modules')), 'npm ci installs into a checkout holding no borrowed install'); return 'installed'; }
    return defaultChildRun(command, args, options as never);
  }) as never;
  for (const head of [same, changed]) {
    const merged = await trialMerge(gitFor(repo.root), { head, baseTip: repo.base });
    assert.ok('mergeSha' in merged);
    const base = await temporaryDirectory('trial-merge-root');
    const result = await runTrial({ root: repo.root, base, mergeSha: merged.mergeSha, changedFiles: [], timeoutMs: 120_000, key: 'GY-9', environment: { PATH: process.env.PATH! }, run });
    assert.equal(result.build, 'pass', result.logTail);
  }
  assert.equal(commands.filter(command => command === 'npm ci').length, 1, 'only the changed lockfile installs');
});
