import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { completeCommand } from '../src/cli/complete.js';
import type { CliContext } from '../src/cli/context.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// The explicit --head path predates GY-2999. These cases reproduce the broken default and
// positional PR form independently of that existing no-push regression guard.
test('unit:complete-head-no-push — omitted --head submits the worktree HEAD without pushing', async () => {
  const root = await temporaryDirectory('complete-default-head');
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet');
  git('commit', '--quiet', '--allow-empty', '-m', 'implementation');
  const head = git('rev-parse', 'HEAD');
  const calls: { path: string; body: unknown }[] = [];
  const context = {
    args: ['10'], repositoryRoot: () => root, print: () => {},
    api: async (path: string, body: unknown) => { calls.push({ path, body }); return {}; },
  } as unknown as CliContext;
  // No remote exists: a push would fail before this submission could succeed.
  await completeCommand.run(context, { id: 'item', key: 'GY-2999' } as never);
  assert.deepEqual(calls, [{ path: 'work/item/submit', body: { epoch: 10, head } }]);
});

test('unit:complete-head-no-push — a positional PR number is refused with --head guidance before submission', async () => {
  const context = {
    args: ['10', '12'],
    api: async () => { assert.fail('a PR number must never be submitted'); },
    repositoryRoot: () => { assert.fail('a refused PR must not read a worktree'); },
    print: () => {},
  } as unknown as CliContext;
  await assert.rejects(completeCommand.run(context, { id: 'item', key: 'GY-2999' } as never), /--head/);
});
