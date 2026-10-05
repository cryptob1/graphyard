import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { runChild } from '../src/child-runner.js';
import { releaseHeldBranch, releaseUnderFailure, reserveReleasingHold } from '../src/master/worktrees.js';
import { workspaceDispatchFailure } from '../src/master/dispatch.js';
import { workspaceCommands } from '../src/cli/workspace.js';
import type { CliContext } from '../src/cli/context.js';

// GY-1059: the follow-ups of GY-860's review. A revert or squash merge a stale attempt worktree
// is stopped inside is ended without moving the branch; the record keeps untracked contents and a
// bounded diff; only Graphyard's own session worktrees are released; a refused failure release is
// never reported as one; and the `worktree` command is driven end to end against a held branch.

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const attached = (cwd: string) => spawnSync('git', ['-C', cwd, 'symbolic-ref', '-q', 'HEAD'], { stdio: 'ignore' }).status === 0;

async function host() {
  const root = await temporaryDirectory('hold-followups');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  for (const [key, value] of [['user.email', 'hold@example.com'], ['user.name', 'Hold Test'], ['commit.gpgsign', 'false']]) git(root, 'config', key, value);
  await writeFile(join(root, 'source.ts'), 'export const value = 1;\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'base');
  return root;
}
function attemptWorktree(root: string, key: string, epoch: number) {
  const path = join(root, '.graphyard', 'worktrees', `${key}-${epoch}`), branch = `graphyard/${key.toLowerCase()}-${epoch}`;
  git(root, 'worktree', 'add', '-q', '-b', branch, path, 'main');
  return { path, branch };
}
const sessionPath = (root: string, key: string, epoch: number) => join(root, '.graphyard', 'worktrees', `${key}-${epoch}`);
/** The attempt commits a change to source.ts, and main commits a conflicting one. */
async function diverge(root: string, path: string, value: number) {
  await writeFile(join(path, 'source.ts'), 'export const value = 2;\n'); git(path, 'commit', '-qam', 'attempt work');
  await writeFile(join(root, 'source.ts'), `export const value = ${value};\n`); git(root, 'commit', '-qam', `base ${value}`);
}

test('unit:worktree-hold-followups — a holder stopped inside a revert or a squash merge is ended where the branch stands and detached', async () => {
  const root = await host();
  try {
    const stops: [string, string[]][] = [['revert', ['revert', '--no-edit', 'HEAD~1']], ['merge --squash', ['merge', '--squash', 'main']]];
    for (const [index, [name, command]] of stops.entries()) {
      const key = `GY-87${index}`, old = attemptWorktree(root, key, 1);
      await diverge(root, old.path, 20 + index);
      if (name === 'revert') { await writeFile(join(old.path, 'source.ts'), 'export const value = 3;\n'); git(old.path, 'commit', '-qam', 'attempt again'); }
      const stopped = spawnSync('git', ['-C', old.path, ...command], { stdio: 'ignore' });
      assert.notEqual(stopped.status, 0, `${name} must stop mid-way for this test to mean anything`);
      const tip = git(root, 'rev-parse', old.branch);
      const released = await releaseHeldBranch(root, old.branch, sessionPath(root, key, 2), runChild);
      assert.ok(released, `the ${name} holder is found`);
      assert.equal(released.preserved.op, null, 'the ledger schema names only rebase, merge and cherry-pick');
      assert.ok(released.preserved.diff.startsWith(`-- stopped inside git ${name} --\n`), `the record says the holder was inside git ${name}`);
      assert.equal(git(root, 'rev-parse', old.branch), tip, `ending the ${name} never moves the branch`);
      assert.equal(attached(old.path), false, 'the holder is detached');
      assert.equal(git(old.path, 'status', '--porcelain'), '', `the ${name} is over`);
      git(root, 'worktree', 'add', '-q', sessionPath(root, key, 2), old.branch);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:worktree-hold-followups — the record carries untracked contents and bounds the tracked diff before buffering it; a reused path is cleaned', async () => {
  const root = await host();
  try {
    const old = attemptWorktree(root, 'GY-880', 1);
    await writeFile(join(old.path, 'source.ts'), `${'export const line = 1;\n'.repeat(120_000)}`); // ~2.6 MB of tracked change
    await writeFile(join(old.path, 'scratch.txt'), 'untracked but kept\n');
    const released = await releaseHeldBranch(root, old.branch, sessionPath(root, 'GY-880', 2), runChild);
    assert.ok(released);
    assert.match(released.preserved.diff, /^-- the full diff could not be captured \(.*\); its stat follows --\n source\.ts \| /, 'an oversized diff is recorded as its stat, not lost to the runner buffer');
    assert.match(released.preserved.diff, /-- untracked files --\n-- untracked file scratch\.txt --\nuntracked but kept\n/, 'an untracked file is recorded with its content');
    assert.ok(released.preserved.diff.length <= 100_000);

    // The same epoch's own path, left dirty by a failed preparation, is reused clean.
    const own = attemptWorktree(root, 'GY-881', 1);
    await writeFile(join(own.path, 'source.ts'), 'export const value = 9;\n');
    await writeFile(join(own.path, 'leftover.txt'), 'from a failed hook\n');
    const reused = await releaseHeldBranch(root, own.branch, own.path, runChild);
    assert.equal(reused?.reused, true);
    assert.match(reused!.preserved.diff, /leftover\.txt --\nfrom a failed hook/);
    assert.equal(git(own.path, 'status', '--porcelain'), '', 'the reused checkout starts clean');
    assert.equal(git(own.path, 'symbolic-ref', '--short', 'HEAD'), own.branch);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:worktree-hold-followups — a locked record whose directory is gone is pruned, and a checkout outside the session worktrees is never detached', async () => {
  const root = await host();
  try {
    const old = attemptWorktree(root, 'GY-882', 1);
    git(root, 'worktree', 'lock', old.path);
    await rm(old.path, { recursive: true, force: true });
    assert.equal(await releaseHeldBranch(root, old.branch, sessionPath(root, 'GY-882', 2), runChild), null);
    git(root, 'worktree', 'add', '-q', sessionPath(root, 'GY-882', 2), old.branch);

    // The coordinator's own checkout on the item's branch.
    const branch = 'graphyard/gy-883-1';
    git(root, 'checkout', '-q', '-b', branch);
    assert.equal(await releaseHeldBranch(root, branch, sessionPath(root, 'GY-883', 2), runChild), null);
    assert.equal(git(root, 'symbolic-ref', '--short', 'HEAD'), branch, 'the primary checkout is left on its branch');
    const calls: string[] = [];
    const mutate = async (name: string) => { calls.push(name); return {}; };
    const work = { key: 'GY-883', lease: { epoch: 2, owner: 'worker', expiresAt: new Date(Date.now() + 60_000).toISOString() }, submission: null };
    await assert.rejects(reserveReleasingHold(root, branch, sessionPath(root, 'GY-883', 2), runChild, mutate, 2, 'host', work, Date.now()), /outside the session worktrees.*attempt costs nothing/);
    assert.deepEqual(calls, ['release'], 'nothing is reserved; the claim is released as a workspace failure');
    assert.equal(git(root, 'symbolic-ref', '--short', 'HEAD'), branch);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:worktree-hold-followups — a refused failure release is reported as a spent epoch, and an overlapping run leaves the first run\'s reservation alone', async () => {
  const refused = async () => { throw new Error('Lease missing, expired, or superseded; claim the task again'); };
  const failure = await releaseUnderFailure(refused, 3, 'fatal: hook failed').then(() => null, (error: unknown) => error);
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /^Git worktree creation failed: fatal: hook failed\. The claim could not be released as a workspace failure \(Lease missing.*\), so epoch 3 is spent rather than handed back\.$/);
  assert.equal(workspaceDispatchFailure(failure.message), true, 'the failure still names the workspace, not the profile');

  const root = await host();
  try {
    const calls: string[] = [];
    const mutate = async (name: string) => { calls.push(name); if (name === 'workspace') throw new Error('This assignment already has a workspace'); return {}; };
    const work = { key: 'GY-884', lease: null, submission: null };
    await assert.rejects(reserveReleasingHold(root, 'graphyard/gy-884-1', sessionPath(root, 'GY-884', 1), runChild, mutate, 1, 'host', work, Date.now()), /reserved it first/);
    assert.deepEqual(calls, ['workspace'], 'no release undoes the first run\'s claim');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:worktree-hold-followups — the worktree command end to end: a held branch is preserved with the reservation and the worktree is built; a failure releases under its own key', async () => {
  const root = await host();
  const previous = { cwd: process.cwd(), request: process.env.GRAPHYARD_REQUEST_ID };
  try {
    git(root, 'remote', 'add', 'origin', 'https://github.com/owner/project.git');
    const old = attemptWorktree(root, 'GY-885', 1);
    await diverge(root, old.path, 30);
    assert.notEqual(spawnSync('git', ['-C', old.path, 'rebase', 'main'], { stdio: 'ignore' }).status, 0, 'the rebase must stop mid-way');
    const tip = git(root, 'rev-parse', old.branch);
    const command = workspaceCommands.find(entry => entry.name === 'worktree');
    assert.ok(command);
    const run = async (key: string, epoch: number) => {
      const calls: { path: string; data: any; requestId?: string }[] = [], printed: any[] = [];
      const context = { command: 'worktree', id: key, args: [String(epoch), 'main'], base: 'http://127.0.0.1:1', connection: null,
        repositoryRoot: () => root, individualHostId: () => 'host-a',
        api: async (path: string, data?: unknown, requestId?: string) => {
          if (path === 'status') return { repository: 'owner/project', now: new Date().toISOString() };
          calls.push({ path, data, requestId }); return {};
        },
        print: (value: unknown) => printed.push(value) } as unknown as CliContext;
      const work = { id: `id-${key}`, key, submission: null, workspaces: [], lease: { epoch, owner: 'worker', expiresAt: new Date(Date.now() + 60_000).toISOString() } };
      const outcome = await command.run(context, work).then(() => null, (error: unknown) => error);
      return { calls, printed, outcome };
    };
    process.chdir(root);
    process.env.GRAPHYARD_REQUEST_ID = 'retry-1';
    // The held branch is the item's own: epoch 1's worktree holds it mid-rebase, and epoch 1 is allocated again under a new path.
    git(root, 'worktree', 'move', old.path, sessionPath(root, 'GY-885', 9));
    const moved = sessionPath(root, 'GY-885', 9);
    const done = await run('GY-885', 1);
    assert.equal(done.outcome, null, String(done.outcome));
    const reservation = done.calls.find(call => call.path === 'work/id-GY-885/workspace');
    assert.ok(reservation, 'the reservation is registered');
    assert.equal(reservation.data.preserved.op, 'rebase', 'the held state rides on the reservation');
    assert.equal(reservation.data.preserved.path, moved);
    assert.equal(reservation.requestId, 'retry-1:worktree-workspace');
    assert.equal(git(root, 'rev-parse', old.branch), tip, 'the branch never moves');
    assert.equal(done.printed[0].path, sessionPath(root, 'GY-885', 1));
    assert.equal(git(sessionPath(root, 'GY-885', 1), 'rev-parse', 'HEAD'), tip, 'the new worktree is on the held branch');
    assert.equal(attached(moved), false, 'the earlier holder is detached');

    // A worktree git cannot build releases the claim under a key of its own, not the reservation's.
    await mkdir(sessionPath(root, 'GY-886', 1), { recursive: true });
    await writeFile(join(sessionPath(root, 'GY-886', 1), 'occupied'), 'x');
    const failed = await run('GY-886', 1);
    assert.ok(failed.outcome instanceof Error && /Git worktree creation failed/.test(failed.outcome.message), String(failed.outcome));
    assert.deepEqual(failed.calls.map(call => [call.path.split('/').at(-1), call.requestId]), [['workspace', 'retry-1:worktree-workspace'], ['release', 'retry-1:worktree-release']]);
    assert.ok(existsSync(resolve(sessionPath(root, 'GY-886', 1), 'occupied')));
  } finally {
    process.chdir(previous.cwd);
    if (previous.request === undefined) delete process.env.GRAPHYARD_REQUEST_ID; else process.env.GRAPHYARD_REQUEST_ID = previous.request;
    await rm(root, { recursive: true, force: true });
  }
});
