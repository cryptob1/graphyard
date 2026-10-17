import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import type { CliContext } from '../src/cli/context.js';

// GY-1925: `complete GY-N EPOCH --head SHA` submits while the control plane is the merge writer and
// the shared object store already holds the commit, so it attempts no git push — a worker sandbox
// that cannot push (OpenSSH refuses its user namespace's /etc/ssh) still completes. The
// pull-request form keeps its push of the graphyard/ (or adopted) branch first and its refusal when
// that push fails. A pre-push hook that records every attempt and then fails makes "a push would
// fail" deterministic and "no push was attempted" observable.

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

/** A worktree on `branch` whose origin holds the branch's first commit and whose every later push is failed by a pre-push hook recording the attempt. */
async function repository(branch: string) {
  const root = await temporaryDirectory('complete-head');
  const origin = join(root, 'origin.git'), work = join(root, 'work'), attempts = join(root, 'push-attempts');
  assert.equal(spawnSync('git', ['init', '--bare', '--quiet', '-b', 'main', origin]).status, 0);
  assert.equal(spawnSync('git', ['init', '--quiet', work]).status, 0);
  git(work, 'checkout', '-q', '-b', branch);
  git(work, 'commit', '-q', '--allow-empty', '-m', 'one');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', '-u', 'origin', branch);
  const hook = join(work, '.git', 'hooks', 'pre-push');
  await writeFile(hook, `#!/bin/sh\nprintf 'attempt\\n' >> ${JSON.stringify(attempts)}\nexit 1\n`);
  await chmod(hook, 0o755);
  git(work, 'commit', '-q', '--allow-empty', '-m', 'two');
  return { attempts, head: git(work, 'rev-parse', 'HEAD'), work };
}

test('unit:complete-head-no-push — complete GY-N EPOCH --head SHA attempts no git push and submits the head even though every push would fail', async () => {
  const { completeCommand } = await import('../src/cli/complete.js');
  const { attempts, head, work } = await repository('graphyard/gy-1-1');
  const calls: { path: string; body: unknown }[] = [], printed: any[] = [];
  const context = { args: ['1', '--head', head], api: async (path: string, body: unknown) => { calls.push({ path, body }); return { key: 'GY-1', submission: { epoch: 1, pr: 7 } }; }, print: (value: unknown) => printed.push(value), repositoryRoot: () => work } as unknown as CliContext;
  await completeCommand.run(context, { id: 'id-1', key: 'GY-1' } as never);
  // The submission went out with the named head ...
  assert.deepEqual(calls, [{ path: 'work/id-1/submit', body: { epoch: 1, head } }]);
  assert.equal(printed[0].submission.pr, 7);
  // ... and no push was attempted: the recording hook never ran, so the failing remote was never touched.
  assert.equal(existsSync(attempts), false, 'complete --head attempted a git push');
  // The bare `--head` form reads the worktree's HEAD and submits it under the same no-push rule.
  calls.length = 0;
  await completeCommand.run({ ...context, args: ['1', '--head'] } as CliContext, { id: 'id-1', key: 'GY-1' } as never);
  assert.deepEqual(calls, [{ path: 'work/id-1/submit', body: { epoch: 1, head } }]);
  assert.equal(existsSync(attempts), false, 'complete --head attempted a git push');
});

test('unit:complete-pr-push-refusal — the pull-request form still pushes the graphyard/ (or adopted) branch first and is refused, submitting nothing, when that push fails', async () => {
  const { completeCommand } = await import('../src/cli/complete.js');
  const { attempts, work } = await repository('graphyard/gy-2-1');
  const calls: string[] = [];
  const context = { args: ['1', '77'], api: async (path: string) => { calls.push(path); return {}; }, print: () => undefined, repositoryRoot: () => work } as never;
  await assert.rejects(completeCommand.run(context, { id: 'x', key: 'GY-2' } as never), /pushing the graphyard\/ branch failed/);
  assert.deepEqual(calls, [], 'the refused complete submitted anyway');
  assert.equal((await readFile(attempts, 'utf8')).split('\n').filter(Boolean).length, 1, 'the push was not attempted exactly once before the refusal');
  // GY-1849: an adopted item's attempt works the adopted pull request's own branch, which is
  // pushed the same way; its failure refuses the submission too.
  const adopted = await repository('feature/huck-migration');
  const adoptedContext = { args: ['1', '77'], api: async () => { throw new Error('the refused complete submitted anyway'); }, print: () => undefined, repositoryRoot: () => adopted.work } as never;
  await assert.rejects(completeCommand.run(adoptedContext, { id: 'x', key: 'GY-2', prAdoption: { branch: 'feature/huck-migration' } } as never), /pushing the graphyard\/ branch failed/);
  assert.equal(existsSync(adopted.attempts), true, 'the adopted branch was not pushed');
});
