import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// The code under test is imported inside each test, so a base without it fails as test cases.
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
async function repository(branch: string) {
  const base = await temporaryDirectory('operator-wip');
  const origin = join(base, 'origin.git'), work = join(base, 'work');
  assert.equal(spawnSync('git', ['init', '--bare', '--quiet', origin]).status, 0);
  assert.equal(spawnSync('git', ['init', '--quiet', work]).status, 0);
  git(work, 'checkout', '-q', '-b', branch);
  git(work, 'commit', '-q', '--allow-empty', '-m', 'one');
  git(work, 'remote', 'add', 'origin', origin);
  return { origin, work };
}
const remoteHeads = (origin: string) => spawnSync('git', ['-C', origin, 'branch', '--list'], { encoding: 'utf8' }).stdout;

test('unit:complete-pushes-graphyard-branch — a graphyard/ branch is pushed with upstream, any other pushes nothing', async () => {
  const { pushGraphyardBranch } = await import('../src/cli/complete.js');
  const { origin, work } = await repository('graphyard/gy-1-1');
  assert.deepEqual(pushGraphyardBranch(work), { pushed: 'graphyard/gy-1-1' });
  assert.match(remoteHeads(origin), /graphyard\/gy-1-1/);
  assert.equal(git(work, 'rev-parse', '--abbrev-ref', 'graphyard/gy-1-1@{upstream}'), 'origin/graphyard/gy-1-1');
  const other = await repository('feature/x');
  assert.deepEqual(pushGraphyardBranch(other.work), { pushed: null });
  assert.equal(remoteHeads(other.origin).trim(), '');
});

test('unit:complete-pushes-graphyard-branch — a failed push is reported, not thrown', async () => {
  const { pushGraphyardBranch } = await import('../src/cli/complete.js');
  const { work } = await repository('graphyard/gy-2-1');
  git(work, 'remote', 'set-url', 'origin', join(work, 'missing.git'));
  const result = pushGraphyardBranch(work);
  assert.equal(result.pushed, null);
  assert.ok(result.failure);
});

test('unit:worktree-pushes-local-candidate — a local head at the candidate sha is pushed when the fetch fails; another sha refuses', async () => {
  const { submittedBranchRefusal } = await import('../src/master/worktrees.js');
  const { origin, work } = await repository('graphyard/gy-3-1');
  const run = ((command: string, args: string[], options: { cwd: string }) => {
    if (args[0] === 'fetch') throw new Error('fatal: couldn\'t find remote ref');
    const result = spawnSync(command, args, { cwd: options.cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  }) as never;
  const remote = 'refs/remotes/origin/graphyard/gy-3-1';
  git(work, 'update-ref', remote, git(work, 'rev-parse', 'HEAD~0'));
  git(work, 'commit', '--allow-empty', '-m', 'second');
  const second = git(work, 'rev-parse', 'HEAD');
  assert.equal(await submittedBranchRefusal(work, 'graphyard/gy-3-1', remote, second, run), null);
  // The remote-tracking ref the worktree starts from names the pushed candidate, however narrow the fetch refspec.
  assert.equal(git(work, 'rev-parse', remote), second);
  assert.match(remoteHeads(origin), /graphyard\/gy-3-1/);
  const moved = await submittedBranchRefusal(work, 'graphyard/gy-3-1', remote, 'b'.repeat(40), run);
  assert.match(moved!, /^Git worktree creation failed while fetching graphyard\/gy-3-1: /);
});

test('unit:github-pages-environment-detected — a pages-deploy.yml workflow names github-pages when none is configured', async () => {
  const { deploymentEnvironmentName } = await import('../src/daemon/deployment.js');
  const root = await temporaryDirectory('operator-wip-pages');
  const config = (productionEnvironment?: string) => ({ run: { productionEnvironment } }) as never;
  assert.equal(deploymentEnvironmentName(config(), root, {}), 'production');
  await mkdir(join(root, '.github', 'workflows'), { recursive: true });
  await writeFile(join(root, '.github', 'workflows', 'pages-deploy.yml'), 'name: pages\n');
  assert.equal(deploymentEnvironmentName(config(), root, {}), 'github-pages');
  assert.equal(deploymentEnvironmentName(config('graphyard / production'), root, {}), 'graphyard / production');
  assert.equal(deploymentEnvironmentName(config(), root, { GRAPHYARD_PRODUCTION_ENVIRONMENT: 'prod' }), 'prod');
});

test('unit:complete-refuses-failed-push — complete refuses to submit when the graphyard/ branch push fails', async () => {
  const { completeCommand } = await import('../src/cli/complete.js');
  const { work } = await repository('graphyard/gy-4-1');
  git(work, 'remote', 'set-url', 'origin', join(work, 'missing.git'));
  const calls: string[] = [];
  const context = { args: ['1', 'PR'], repositoryRoot: () => work, api: async (path: string) => { calls.push(path); return {}; }, print: () => undefined } as never;
  await assert.rejects(completeCommand.run(context, { id: 'x', key: 'GY-4' } as never), /pushing the graphyard\/ branch failed/);
  assert.deepEqual(calls, []);
});
