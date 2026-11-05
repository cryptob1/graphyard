import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import type { WorkerVerificationResult } from '../src/cli/worker-verification.js';
import type { CliContext } from '../src/cli/context.js';

// GY-1925: explicit --head submission attempts no git push, so a worker sandbox that cannot
// push still completes. A pre-push hook records and fails every attempt, making the no-push
// assertion observable. GY-2999 default-head and PR-refusal regressions live in complete-default-head.

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
  await writeFile(join(work, '.gitignore'), '.graphyard/\n');
  git(work, 'add', '.gitignore');
  git(work, 'commit', '-q', '-m', 'two');
  return { attempts, head: git(work, 'rev-parse', 'HEAD'), work };
}

test('unit:complete-explicit-head-no-push — complete GY-N EPOCH --head SHA attempts no git push and submits the head even though every push would fail', async () => {
  const { completeCommand } = await import('../src/cli/complete.js');
  const { attempts, head, work } = await repository('graphyard/gy-1-1');
  const calls: { path: string; body: unknown }[] = [], printed: any[] = [];
  const requests: unknown[] = [];
  let rerun: WorkerVerificationResult['rerun'] = { flaked: [], baseFailures: [] };
  const context = {
    args: ['1', '--head', head],
    api: async (path: string, body: unknown) => {
      if (path.endsWith('/worker-verification')) {
        requests.push({ path, body });
        return { record: { key: 'GY-1', head, clean: true, at: new Date().toISOString(), ran: [], outstanding: [] }, rerun };
      }
      calls.push({ path, body }); return { key: 'GY-1', submission: { epoch: 1, pr: 7 } };
    },
    print: (value: unknown) => printed.push(value), repositoryRoot: () => work,
  } as unknown as CliContext;
  await completeCommand.run(context, { id: 'id-1', key: 'GY-1' } as never);
  assert.deepEqual(requests, [{ path: 'work/id-1/worker-verification', body: { mode: 'complete', head, epoch: 1 } }]);
  // The submission went out with the named head ...
  assert.deepEqual(calls, [{ path: 'work/id-1/submit', body: { epoch: 1, head } }]);
  assert.equal(printed[0].submission.pr, 7);
  // ... and no push was attempted: the recording hook never ran, so the failing remote was never touched.
  assert.equal(existsSync(attempts), false, 'complete --head attempted a git push');
  // The bare `--head` form reads the worktree's HEAD and submits it under the same no-push rule.
  calls.length = 0;
  rerun = { flaked: [{ case: 'unit:flaked', file: 'tests/flaked.test.ts', line: 1, durationMs: 5 }],
    baseFailures: [{ case: 'unit:base', file: 'tests/base.test.ts', line: 2, durationMs: 5 }],
    note: { note: 'base comparison unavailable', output: 'runner unavailable' } };
  await completeCommand.run({ ...context, args: ['1', '--head'] } as CliContext, { id: 'id-1', key: 'GY-1' } as never);
  assert.deepEqual(calls, [{ path: 'work/id-1/submit', body: { epoch: 1, head, flaked: rerun.flaked, baseFailures: rerun.baseFailures, rerunUnjudged: rerun.note } }]);
  assert.equal(existsSync(attempts), false, 'complete --head attempted a git push');
});
