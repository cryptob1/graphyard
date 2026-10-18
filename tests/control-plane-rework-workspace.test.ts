import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorktree } from '../src/cli/workspace-worktree.js';
import type { CliContext } from '../src/cli/context.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2017: a control-plane rework workspace starts from the head Graphyard registered at the last
// submission, read from the shared object store. It needs no pull-request observation and runs no
// fetch or push of the worker branch — origin may lack the branch or hold a stale one from the
// legacy flow, and only the merge writer pushes. The fake remote here serves the base branch
// alone: a pre-receive hook records and rejects every worker-ref push, and uploadpack hides every
// other ref from fetch, so any worker-ref network operation fails the workspace that ran it.
// Against the base behavior the regression fails: the worktree command fetched the PR branch,
// refused the moved or missing head, or pushed the worker branch to recover it.

const base = 'main';
const branch = 'graphyard/gy-1-1';

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

/** A coordinator checkout whose origin serves the base branch alone: worker refs are hidden from fetch, and their pushes are recorded and rejected. */
async function repository() {
  const root = await temporaryDirectory('rework-workspace');
  const origin = join(root, 'origin.git'), work = join(root, 'work'), pushes = join(root, 'worker-ref-pushes');
  assert.equal(spawnSync('git', ['init', '--bare', '--quiet', '-b', base, origin]).status, 0);
  assert.equal(spawnSync('git', ['init', '--quiet', work]).status, 0);
  git(work, 'checkout', '-q', '-b', base);
  git(work, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', '-u', 'origin', base);
  const hook = join(origin, 'hooks', 'pre-receive');
  await writeFile(hook, `#!/bin/sh\nwhile read -r _old _new ref; do\n  case "$ref" in refs/heads/${base}) ;; *) printf '%s\\n' "$ref" >> ${JSON.stringify(pushes)}; exit 1 ;; esac\ndone\n`);
  await chmod(hook, 0o755);
  spawnSync('git', ['-C', origin, 'config', 'uploadpack.hideRefs', 'refs']);
  spawnSync('git', ['-C', origin, 'config', '--add', 'uploadpack.hideRefs', `!refs/heads/${base}`]);
  // The submitted head: one commit on the registered branch, the submitting attempt's worktree holding it.
  git(work, 'checkout', '-q', '-b', branch);
  await writeFile(join(work, 'feature.txt'), 'the submitted work\n');
  git(work, 'add', 'feature.txt');
  git(work, 'commit', '-q', '-m', 'the submitted head');
  const head = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '-q', base);
  git(work, 'worktree', 'add', '-q', join(work, '.graphyard/worktrees/GY-1-1'), branch);
  return { origin, work, pushes, head, stale: git(work, 'rev-parse', base) };
}

/** The work as a rework dispatch reads it: submitted, the candidate bound (or cleared), both attempts' workspace records. */
const item = (workRoot: string, candidate: { sha: string } | null, head: string) => ({
  id: 'id-1', key: 'GY-1',
  submission: { epoch: 1, pr: 7 },
  candidate: candidate && { pr: 7, baseSha: 'a'.repeat(40), author: 'worker-a', branch, ...candidate },
  lease: { owner: 'worker-a', epoch: 2, expiresAt: new Date(Date.now() + 600_000).toISOString() },
  epoch: 2,
  workspaces: [{ host: 'test-host', path: join(workRoot, '.graphyard/worktrees/GY-1-1'), epoch: 1, owner: 'worker-a', branch }],
});

interface Recorded { path: string; body: any }
/** The CLI context a launch runs: the server this stub stands for enforces the live lease epoch on every lease mutation. */
function context(workRoot: string, subject: ReturnType<typeof item>, state: { calls: Recorded[]; printed: unknown[] }) {
  const live = subject.lease.epoch;
  return {
    args: ['2'],
    api: async (path: string, body?: unknown) => {
      if (path === 'status') return { repository: null, now: new Date().toISOString() };
      const call = { path, body };
      if (path === `work/${subject.id}/workspace`) {
        if ((body as any)?.epoch !== live) throw new Error('Task already has an active owner');
        state.calls.push(call);
        return {};
      }
      if (path === `work/${subject.id}/release`) {
        if ((body as any)?.epoch !== live) throw new Error('Lease missing, expired, or superseded');
        state.calls.push(call);
        return { epoch: subject.epoch - 1, lease: null };
      }
      throw new Error(`unexpected api call ${path}`);
    },
    print: (value: unknown) => state.printed.push(value),
    repositoryRoot: () => workRoot,
    individualHostId: () => 'test-host',
  } as unknown as CliContext;
}

interface Run { calls: Recorded[]; printed: unknown[]; failure?: string }
/** Runs the worktree command the way the launcher does, from the coordinator root, recording every server call and any refusal. The epoch the command asks for comes first. */
async function runWorktree(workRoot: string, subject: ReturnType<typeof item>, epoch = 2): Promise<Run> {
  const state: Run = { calls: [], printed: [] };
  const previous = process.cwd();
  process.chdir(workRoot);
  try {
    const cli = context(workRoot, subject, state);
    (cli as any).args = [String(epoch)];
    await createWorktree(cli, subject);
  }
  catch (error) { state.failure = error instanceof Error ? error.message : String(error); }
  finally { process.chdir(previous); }
  return state;
}

const ran = (state: Run, kind: 'fetch' | 'push') => state.calls.filter(call => call.path === `work/id-1/${kind}`);
const reserved = (state: Run) => state.calls.find(call => call.path === 'work/id-1/workspace');
const released = (state: Run) => state.calls.filter(call => call.path === 'work/id-1/release');
const fetchedWorkerRef = (workRoot: string) => spawnSync('git', ['-C', workRoot, 'rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`]).status === 0;

test('integration:control-plane-rework-workspace — the rework workspace starts from the registered submission head with no worker-ref fetch or push, the remote branch absent or stale', async () => {
  for (const stale of [false, true]) {
    const { origin, work: root, pushes, head, stale: baseTip } = await repository();
    try {
      if (stale) git(origin, 'update-ref', `refs/heads/${branch}`, baseTip); // the legacy flow's leftover: origin still holds the branch at an old commit
      const state = await runWorktree(root, item(root, { sha: head }, head));
      assert.equal(state.failure, undefined, `the workspace was created: ${state.failure}`);
      const printed = state.printed[0] as { path: string; branch: string; epoch: number };
      assert.deepEqual({ branch: printed.branch, epoch: printed.epoch }, { branch, epoch: 2 }, 'the new leased workspace is registered on the submitting branch');
      assert.equal(printed.path, join(root, '.graphyard/worktrees/GY-1-2'), 'the workspace is this assignment\u2019s own epoch path, never another\u2019s');
      assert.equal(git(printed.path, 'rev-parse', 'HEAD'), head, 'the workspace starts from the registered submission head');
      assert.equal(git(printed.path, 'rev-parse', '--abbrev-ref', 'HEAD'), branch, 'the workspace holds the registered branch');
      const reservation = reserved(state)!.body;
      assert.deepEqual({ epoch: reservation.epoch, host: reservation.host, path: reservation.path, branch: reservation.branch }, { epoch: 2, host: 'test-host', path: printed.path, branch });
      assert.equal(reservation.preserved.path, join(root, '.graphyard/worktrees/GY-1-1'), 'the hold of the submitting attempt\u2019s worktree is registered before anything moves');
      assert.deepEqual(ran(state, 'fetch'), [], 'no worker-ref fetch ran');
      assert.deepEqual(ran(state, 'push'), [], 'no worker-ref push ran');
      assert.equal(existsSync(pushes), false, 'no push reached the fake remote');
      assert.equal(fetchedWorkerRef(root), false, 'no worker ref was fetched into the checkout');
      assert.deepEqual(git(origin, 'branch', '--list', 'graphyard/*'), stale ? branch : '', stale ? 'the stale remote branch is left exactly as it stood' : 'the remote holds no worker branch');
      assert.deepEqual(released(state), [], 'no workspace failure: the claim was never released');
      assert.equal(git(root, '-C', join(root, '.graphyard/worktrees/GY-1-1'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'the earlier attempt\u2019s worktree was detached, never deleted');
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('integration:control-plane-rework-workspace — a stale PR branch origin still serves is neither fetched nor observed', async () => {
  const { origin, work: root, head } = await repository();
  try {
    // The worker branch is visible on origin again, at a stale head: the case that refused every rework dispatch before GY-2017.
    git(origin, 'update-ref', `refs/heads/${branch}`, git(root, 'rev-parse', base));
    git(origin, 'config', '--unset-all', 'uploadpack.hideRefs');
    const state = await runWorktree(root, item(root, { sha: head }, head));
    assert.equal(state.failure, undefined, `the workspace was created: ${state.failure}`);
    const printed = state.printed[0] as { path: string };
    assert.equal(git(printed.path, 'rev-parse', 'HEAD'), head, 'the workspace starts from the registered head, not the stale branch');
    assert.equal(fetchedWorkerRef(root), false, 'the PR branch was not fetched: no remote-tracking ref exists');
    assert.deepEqual(released(state), [], 'no observation, no refusal, no release');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('integration:control-plane-rework-workspace — after a requirements revision has cleared the candidate the workspace still starts from the registered head', async () => {
  const { work: root, pushes, head } = await repository();
  try {
    const state = await runWorktree(root, item(root, null, head));
    assert.equal(state.failure, undefined, `the workspace was created: ${state.failure}`);
    const printed = state.printed[0] as { path: string };
    assert.equal(git(printed.path, 'rev-parse', 'HEAD'), head, 'the registered branch holds the head, and the workspace starts from it');
    assert.deepEqual(ran(state, 'fetch'), [], 'no observation of any pull request, no worker-ref fetch');
    assert.deepEqual(ran(state, 'push'), [], 'no worker-ref push');
    assert.equal(existsSync(pushes), false, 'nothing was pushed');
    assert.deepEqual(released(state), [], 'the claim was never released');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('integration:control-plane-rework-ownership — the rework path preserves the partial-work handoff and registers the preserved hold', async () => {
  const { work: root, head } = await repository();
  try {
    await writeFile(join(root, '.graphyard/worktrees/GY-1-1', 'wip.txt'), 'the stopped attempt\u2019s uncommitted work\n');
    const state = await runWorktree(root, item(root, { sha: head }, head));
    assert.equal(state.failure, undefined, `the workspace was created: ${state.failure}`);
    const preserved = reserved(state)!.body.preserved as { path: string; head: string; branchTip: string; diff: string; op: string | null };
    assert.equal(preserved.path, join(root, '.graphyard/worktrees/GY-1-1'), 'the hold is registered on the ledger');
    assert.equal(preserved.head, head, 'the preserved record names where the holder stood');
    assert.match(preserved.diff, /wip\.txt/, 'the uncommitted partial work is kept on the record');
    const printed = state.printed[0] as { path: string };
    assert.equal(git(printed.path, 'rev-parse', 'HEAD'), head, 'the new workspace starts from the registered head, never from the partial work');
    assert.equal(existsSync(join(root, '.graphyard/worktrees/GY-1-1', 'wip.txt')), true, 'the historical worktree is preserved, never removed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('integration:control-plane-rework-ownership — a missing or unregistered start object refuses and costs no attempt, leaving every reservation as it stands', async () => {
  for (const candidate of [{ sha: 'b'.repeat(40) }, null]) {
    const { work: root, head } = await repository();
    try {
      if (candidate === null) { // nothing registered: the branch is gone and no head is bound
        git(root, 'worktree', 'remove', join(root, '.graphyard/worktrees/GY-1-1'));
        git(root, 'branch', '-D', branch);
      }
      const state = await runWorktree(root, item(root, candidate, head));
      assert.match(state.failure ?? '', /registered start head of graphyard\/gy-1-1: /, 'the refusal names the branch');
      assert.match(state.failure ?? '', /released as a workspace failure/, 'the claim was released, so the attempt costs nothing');
      assert.deepEqual(reserved(state), undefined, 'nothing was reserved');
      assert.deepEqual(released(state).length, 1, 'the claim alone was released');
      assert.equal(existsSync(join(root, '.graphyard/worktrees/GY-1-2')), false, 'no workspace was built');
      assert.equal(fetchedWorkerRef(root), false, 'and no worker-ref fetch replaced the missing object');
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  // The productive shape, named where the calls are readable: the earlier attempt's worktree stands untouched.
  const { work: root, head } = await repository();
  try {
    const state = await runWorktree(root, item(root, { sha: 'b'.repeat(40) }, head));
    assert.match(state.failure ?? '', /missing from the shared object store/);
    assert.equal(git(root, '-C', join(root, '.graphyard/worktrees/GY-1-1'), 'rev-parse', '--abbrev-ref', 'HEAD'), branch, 'the earlier attempt\u2019s workspace is untouched');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('integration:control-plane-rework-ownership — the server\u2019s reservation and lease-epoch enforcement is relayed: a refused epoch never builds, a made reservation is left alone', async () => {
  const { work: root, head } = await repository();
  try {
    // An epoch that is not the live lease is refused by the control plane; the CLI builds nothing and names the spent epoch.
    const wrong = await runWorktree(root, item(root, { sha: head }, head), 3);
    assert.match(wrong.failure ?? '', /epoch 3 is spent/);
    assert.equal(existsSync(join(root, '.graphyard/worktrees/GY-1-3')), false, 'no workspace was built for the refused epoch');
    assert.equal(existsSync(join(root, '.graphyard/worktrees/GY-1-2')), false, 'no workspace was built at all');
    // A reservation another worktree run already made leaves that run's reservation and the claim alone (GY-1059).
    const first = await runWorktree(root, item(root, { sha: head }, head));
    assert.equal(first.failure, undefined, `the first workspace was created: ${first.failure}`);
    const built = (first.printed[0] as { path: string }).path;
    git(root, 'worktree', 'remove', built); // the other run's tree is gone; its reservation stands
    const state: Run = { calls: [], printed: [] };
    const previous = process.cwd();
    process.chdir(root);
    try {
      const subject = item(root, { sha: head }, head);
      const refusing = context(root, subject, state);
      (refusing as any).api = async (path: string) => {
        if (path === 'status') return { repository: null, now: new Date().toISOString() };
        if (path === 'work/id-1/workspace') throw new Error('This assignment already has a workspace');
        throw new Error('the claim must be left alone');
      };
      await assert.rejects(createWorktree(refusing, subject), /Another worktree run for GY-1 epoch 2 reserved it first, so this run leaves that reservation and the claim alone/);
    } finally { process.chdir(previous); }
    assert.deepEqual(state.calls, [], 'the claim was never released');
  } finally { await rm(root, { recursive: true, force: true }); }
});
