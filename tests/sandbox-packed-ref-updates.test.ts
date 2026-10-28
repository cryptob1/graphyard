import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { coordinatorConfinement, sessionMountNamespaceWorks } from '../src/master/profiles.js';
import { prepareConfinedGitPaths } from '../src/master/launch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2967: git takes the common git directory's packed-refs lock for every ref update or delete of
// a ref present in packed-refs, so once anything packs the repository's refs (git gc does), every
// ref transaction a worker runs inside the confinement — commit, merge, reset, branch -f,
// update-ref, a cherry-pick's cleanup — failed with `packed-refs.lock: Read-only file system`, not
// only the cherry-pick cleanup GY-2950 patched around in sync. The confinement now re-exposes the
// common git directory writable and re-binds only the coordinator's own state read-only inside it,
// so every ref update works on packed refs.

/** A coordinator checkout whose every ref is packed, with an assignment worktree on a packed graphyard branch and a second packed branch carrying another commit. */
function fixture(base: string) {
  const root = join(base, 'coordinator');
  const run = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 1;\n');
  writeFileSync(join(root, 'shared.txt'), 'base\n');
  writeFileSync(join(root, '.gitignore'), '.graphyard/\n');
  run('init', '-b', 'main');
  run('config', 'user.email', 'graphyard@localhost');
  run('config', 'user.name', 'Graphyard');
  run('add', '.');
  run('commit', '-m', 'coordinator');
  const worktree = join(root, '.graphyard', 'worktrees', 'gy-2967-1');
  mkdirSync(dirname(worktree), { recursive: true });
  run('worktree', 'add', '-b', 'graphyard/gy-2967-1', worktree, 'main');
  // The commit the confined worker merges, on its own graphyard branch.
  const other = join(root, '.graphyard', 'worktrees', 'gy-2967-2');
  run('worktree', 'add', '-b', 'graphyard/gy-2967-2', other, 'main');
  writeFileSync(join(other, 'other.txt'), 'other\n');
  execFileSync('git', ['-C', other, 'add', '.']);
  execFileSync('git', ['-C', other, 'commit', '-m', 'other branch work']);
  run('worktree', 'remove', other);
  // A packed graphyard branch nobody has checked out, for the confined update-ref -d.
  run('branch', 'graphyard/gy-2967-gone', 'main');
  // Pack every ref, exactly as any git gc does: the fault is a packed-refs lock the sandbox kept
  // read-only, and it bites every ref update, not one command alone.
  run('pack-refs', '--all');
  const packed = readFileSync(join(root, '.git', 'packed-refs'), 'utf8');
  assert.match(packed, /refs\/heads\/main/, 'refs/heads/main is packed');
  assert.match(packed, /refs\/heads\/graphyard\/gy-2967-1/, 'the assignment branch is packed');
  assert.match(packed, /refs\/heads\/graphyard\/gy-2967-2/, 'the second branch is packed');
  assert.match(packed, /refs\/heads\/graphyard\/gy-2967-gone/, 'the disposable branch is packed');
  const main = run('rev-parse', 'refs/heads/main');
  const otherTip = run('rev-parse', 'refs/heads/graphyard/gy-2967-2');
  prepareConfinedGitPaths(root);
  return { root, worktree, main, otherTip };
}

test('unit:sandbox-ref-updates-work-on-packed-refs — inside the worker confinement every ref update works on packed refs: commit, merge, reset --hard, branch -f and update-ref -d each succeed while the coordinator checkout and the base branch stay protected', async () => {
  const base = await temporaryDirectory('sandbox packed refs');
  try {
    const { root, worktree, main, otherTip } = fixture(base);
    const confinement = await coordinatorConfinement({ kind: 'pi', args: [], coordinatorRoot: root, sessionDirectory: worktree, platform: 'linux', mountNamespaceWorks: true, bwrap: 'bwrap' });
    assert.ok(confinement, 'the worker launch carries a confinement');
    assert.equal(confinement.mechanism, 'read-only-mount');
    assert.ok(confinement.wrapper.includes(join(root, '.git', 'worktrees', 'gy-2967-1')), 'the session pins its own worktree admin directory');
    if (process.platform !== 'linux') return;
    assert.ok(await sessionMountNamespaceWorks(), 'mount namespaces work on this Linux host');
    // The worker's own ref updates, in the confinement, on refs packed at launch.
    const script = [
      'wt="$1"; root="$2"',
      'cd "$wt" || exit 9',
      'printf change > shared.txt && git -c user.email=w@t -c user.name=Worker commit -q -a -m \'worker change\' && echo COMMIT-OK || echo COMMIT-FAILED',
      'git -c user.email=w@t -c user.name=Worker merge -q --no-edit "$3" && echo MERGE-OK || echo MERGE-FAILED',
      'git reset -q --hard HEAD~1 && echo RESET-OK || echo RESET-FAILED',
      'git branch -f graphyard/gy-2967-3 HEAD && echo BRANCH-OK || echo BRANCH-FAILED',
      'git update-ref -d refs/heads/graphyard/gy-2967-gone && echo DELETE-OK || echo DELETE-FAILED',
      // The protection the fix must not weaken: the coordinator checkout, its own commit and the
      // base branch stay unwritable, packed refs or not.
      'if touch "$root/coordinator-probe" 2>/dev/null; then echo COORDINATOR-WRITE-ALLOWED; else echo COORDINATOR-WRITE-BLOCKED; fi',
      'if git -C "$root" -c user.email=w@t -c user.name=Worker commit --allow-empty -q -m probe 2>/dev/null; then echo COORDINATOR-COMMIT-ALLOWED; else echo COORDINATOR-COMMIT-BLOCKED; fi',
      'head=$(git -C "$root" rev-parse HEAD)',
      'if git -C "$wt" update-ref refs/heads/main "$head" 2>/dev/null; then echo BASE-REF-ALLOWED; else echo BASE-REF-BLOCKED; fi',
    ].join('\n');
    const run = spawnSync(confinement.wrapper[0], [...confinement.wrapper.slice(1, -1), '/bin/sh', '-c', script, 'sh', worktree, root, otherTip],
      { encoding: 'utf8', timeout: 240_000, killSignal: 'SIGKILL' });
    assert.equal(run.status, 0, `the confined worker ran successfully: ${run.stderr}`);
    const output = run.stdout + '\n' + run.stderr;
    for (const marker of ['COMMIT-OK', 'MERGE-OK', 'RESET-OK', 'BRANCH-OK', 'DELETE-OK'])
      assert.ok(run.stdout.includes(marker), `${marker} — the packed-ref update succeeded: ${run.stdout}`);
    for (const marker of ['COMMIT-FAILED', 'MERGE-FAILED', 'RESET-FAILED', 'BRANCH-FAILED', 'DELETE-FAILED',
      'COORDINATOR-WRITE-ALLOWED', 'COORDINATOR-COMMIT-ALLOWED', 'BASE-REF-ALLOWED', 'Read-only file system'])
      assert.ok(!output.includes(marker), `${marker} never appears`);
    for (const marker of ['COORDINATOR-WRITE-BLOCKED', 'COORDINATOR-COMMIT-BLOCKED', 'BASE-REF-BLOCKED'])
      assert.ok(run.stdout.includes(marker), `${marker} — the confinement still protects the coordinator and the base branch`);
    // The worker's branch holds the reset's own commit, the disposable branch is gone, and the
    // coordinator's main and packed-refs are untouched.
    const workerTip = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(workerTip, execFileSync('git', ['-C', root, 'rev-parse', 'refs/heads/graphyard/gy-2967-1'], { encoding: 'utf8' }).trim(), 'the worker branch moved with its resets');
    assert.equal(execFileSync('git', ['-C', root, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim(), main, 'main did not move');
    assert.match(readFileSync(join(root, '.git', 'packed-refs'), 'utf8'), /refs\/heads\/main/, 'main is still packed for everyone else');
    assert.doesNotMatch(readFileSync(join(root, '.git', 'packed-refs'), 'utf8'), /gy-2967-gone/, 'the deleted branch is gone from packed-refs');
    assert.ok(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }) === '', 'the coordinator checkout stays clean');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
