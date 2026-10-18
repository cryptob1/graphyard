import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { submittedBranchMoved } from '../src/model/assignment.js';

// GY-2035: a rework workspace starts from the worker's local branch, which must hold the submitted
// candidate head. The preparation asks the local repository alone: whatever origin holds for the
// branch — an older head, a base merge the writer pushed, nothing at all — no git fetch or push
// runs (the merge writer is the only git network user), and a local head that is not the candidate
// is refused with the existing message. A recording runner proves both: it records every git it is
// asked to run and answers from a real checkout whose origin holds an older head of the branch.

const branch = 'graphyard/gy-9-1';

/** A checkout whose branch was pushed to origin at an older head, then moved on: the stalest origin a rework can meet. */
async function repository() {
  const base = await temporaryDirectory('rework-local-branch');
  const origin = join(base, 'origin.git'), work = join(base, 'work');
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  assert.equal(spawnSync('git', ['init', '--bare', '--quiet', '-b', 'main', origin]).status, 0);
  assert.equal(spawnSync('git', ['init', '--quiet', '-b', 'main', work]).status, 0);
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(work, 'checkout', '-q', '-b', branch);
  git(work, 'commit', '-q', '--allow-empty', '-m', 'older');
  git(work, 'push', '-q', 'origin', branch);
  const pushed = git(work, 'rev-parse', `refs/remotes/origin/${branch}`);
  git(work, 'commit', '-q', '--allow-empty', '-m', 'submitted');
  return { origin, work, pushed, candidate: git(work, 'rev-parse', 'HEAD'), git };
}

/** The recording runner: every git it is asked to run is recorded, then answered from the real repository. */
const recording = (calls: string[][]) => (async (_command: string, args: string[], options?: { cwd?: string }) => {
  calls.push(args);
  const result = spawnSync('git', args, { cwd: options?.cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}) as never;

/** The recorded calls that would reach the remote: the door's own network subcommands. */
const networked = (calls: string[][]) => calls.filter(args => ['clone', 'fetch', 'ls-remote', 'pull', 'push'].includes(String(args[0])));

test('unit:rework-local-branch — the local candidate head starts the workspace with no git fetch or push, whatever origin holds', async () => {
  const { submittedBranchRefusal } = await import('../src/master/worktrees.js');
  const { origin, work, pushed, candidate, git } = await repository();
  const calls: string[][] = [];
  assert.equal(await submittedBranchRefusal(work, branch, candidate, recording(calls)), null, 'the local branch holds the candidate, so the workspace starts');
  assert.deepEqual(calls, [['rev-parse', '--verify', `refs/heads/${branch}`]], 'the check reads the local head alone');
  assert.deepEqual(networked(calls), [], 'no git network subcommand runs, though origin holds an older head');
  assert.equal(git(work, 'rev-parse', `refs/remotes/origin/${branch}`), pushed, 'the stale remote-tracking ref is untouched');
  assert.equal(git(origin, 'rev-parse', branch), pushed, 'origin still holds what it held: nothing was pushed');
});

test('unit:rework-local-branch — a local head that is missing or differs from the candidate refuses with the existing message', async () => {
  const { submittedBranchRefusal } = await import('../src/master/worktrees.js');
  const { work, candidate } = await repository();
  const calls: string[][] = [];
  // A branch that moved after submission no longer starts the workspace at the observed candidate.
  const moved = await submittedBranchRefusal(work, branch, 'b'.repeat(40), recording(calls));
  assert.equal(moved, submittedBranchMoved);
  assert.match(moved!, /^Submitted PR branch changed; wait for Graphyard to observe its current head/);
  // No candidate has been observed yet, and a branch that is gone holds none.
  assert.equal(await submittedBranchRefusal(work, branch, undefined, recording(calls)), submittedBranchMoved);
  assert.equal(await submittedBranchRefusal(work, 'graphyard/gy-404-1', candidate, recording(calls)), submittedBranchMoved);
  assert.deepEqual(networked(calls), [], 'a refusal fetches and pushes nothing, too');
});
