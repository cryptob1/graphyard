import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coordinatorConfinement, sessionMountNamespaceWorks } from '../src/master/profiles.js';
import { prepareConfinedGitPaths } from '../src/master/launch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2950: a worker that cherry-picks a preserved attempt's saved commit cannot conclude the pick
// inside its confinement. Removing CHERRY_PICK_HEAD runs a ref transaction that takes the common
// git directory's packed-refs lock, the read-only mount keeps that directory unwritable, and git
// exits 0 with the state still in place — so `graphyard sync` was refused forever ("You have not
// concluded your cherry-pick") and the preserved work could not land. Sync now ends the pick as
// its own quit would have, in the worktree admin directory the sandbox grants, without granting
// the coordinator checkout or any ref outside the worker's own scope.

/** A coordinator checkout with a linked assignment worktree, packed refs, and a saved commit that conflicts with the assignment branch's own change, exactly as the bug found them. */
function fixture(base: string) {
  const root = join(base, 'coordinator');
  const run = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 1;\n');
  writeFileSync(join(root, 'shared.txt'), 'base\n');
  run('init', '-b', 'main');
  run('config', 'user.email', 'graphyard@localhost');
  run('config', 'user.name', 'Graphyard');
  run('add', '.');
  run('commit', '-m', 'coordinator');
  // The refs packed here are why git cannot conclude the pick: removing CHERRY_PICK_HEAD locks
  // the common packed-refs file, which the confinement keeps read-only.
  run('gc', '--quiet');
  assert.match(readFileSync(join(root, '.git', 'packed-refs'), 'utf8'), /refs\/heads\/main/, 'refs/heads/main is packed');
  const worktree = join(root, '.graphyard', 'worktrees', 'gy-2950-1');
  mkdirSync(dirname(worktree), { recursive: true });
  run('worktree', 'add', '-b', 'graphyard/gy-2950-1', worktree, 'main');
  const inWorktree = (...args: string[]) => execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  // The preserved attempt's saved work, twice over: each conflicts with what the branch holds.
  inWorktree('checkout', '-q', '-b', 'saved');
  writeFileSync(join(worktree, 'shared.txt'), 'saved work\n');
  inWorktree('commit', '-am', 'saved work');
  const saved = inWorktree('rev-parse', 'HEAD');
  inWorktree('checkout', '-q', '-b', 'saved-two');
  writeFileSync(join(worktree, 'shared.txt'), 'saved twice\n');
  inWorktree('commit', '-am', 'saved twice');
  const savedTwo = inWorktree('rev-parse', 'HEAD');
  inWorktree('checkout', '-q', 'graphyard/gy-2950-1');
  writeFileSync(join(worktree, 'shared.txt'), 'workspace\n');
  inWorktree('commit', '-am', 'the branch own change');
  // The base tip the supported sync merges, as the merge writer advances it: nothing is fetched.
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'advance.md'), 'advanced on main\n');
  run('add', '.');
  run('commit', '-m', 'advance main');
  run('update-ref', 'refs/remotes/origin/main', run('rev-parse', 'HEAD'));
  prepareConfinedGitPaths(root);
  return { root, worktree, saved, savedTwo, admin: join(root, '.git', 'worktrees', 'gy-2950-1') };
}

test('integration:worker-cherry-pick-cleanup — inside the launched worker confinement a saved commit is cherry-picked, completed and quit, and the supported sync succeeds with no CHERRY_PICK_HEAD left while the coordinator files and the base branch stay protected', async () => {
  const base = await temporaryDirectory('cherry-pick cleanup');
  try {
    const { root, worktree, saved, savedTwo, admin } = fixture(base);
    // The launch the worker runs under: the coordinator checkout read-only in a mount namespace,
    // the assignment worktree and its own git admin re-exposed writable.
    const confinement = await coordinatorConfinement({ kind: 'pi', args: [], coordinatorRoot: root, sessionDirectory: worktree, platform: 'linux', mountNamespaceWorks: true, bwrap: 'bwrap' });
    assert.ok(confinement, 'the worker launch carries a confinement');
    assert.equal(confinement.mechanism, 'read-only-mount');
    assert.ok(confinement.wrapper.includes(join(root, '.git', 'worktrees', 'gy-2950-1')), 'the session pins its own worktree admin directory');
    if (process.platform !== 'linux') return;
    assert.ok(await sessionMountNamespaceWorks(), 'mount namespaces work on this Linux host');
    // The worker's own actions, in the confinement: cherry-pick the saved commit, complete it
    // (`--continue` after resolving), then a second pick quit (`--quit` and the reset a quit
    // needs), each followed by the supported sync. The sync helper runs from this checkout, whose
    // node_modules carry tsx; everything it writes goes to the worktree and its admin directory.
    const checkout = dirname(dirname(fileURLToPath(import.meta.url)));
    const script = [
      'wt="$1"; root="$2"; gyroot="$3"',
      'cd "$wt" || exit 9',
      'git cherry-pick "$4" >/dev/null 2>&1',
      'printf \'resolved by the worker\\n\' > shared.txt',
      'git add shared.txt',
      'GIT_EDITOR=true git -c user.email=w@t -c user.name=Worker cherry-pick --continue >/dev/null 2>&1',
      'if test -f "$(git rev-parse --git-path CHERRY_PICK_HEAD)"; then echo PICK-STATE-REMAINS; else echo PICK-STATE-CLEAN; fi',
      'cd "$gyroot" || exit 9',
      'WORKER_TREE="$wt" WORKER_KEY=GY-2950 node --import tsx "$gyroot/tests/helpers/worker-sync.mjs" || echo SYNC-ONE-FAILED',
      'cd "$wt" || exit 9',
      'if test -f "$(git rev-parse --git-path CHERRY_PICK_HEAD)"; then echo AFTER-SYNC-STATE-REMAINS; else echo AFTER-SYNC-STATE-CLEAN; fi',
      'git cherry-pick "$5" >/dev/null 2>&1',
      'git cherry-pick --quit >/dev/null 2>&1',
      'if test -f "$(git rev-parse --git-path CHERRY_PICK_HEAD)"; then echo QUIT-STATE-REMAINS; else echo QUIT-STATE-CLEAN; fi',
      'git reset --merge >/dev/null 2>&1',
      'cd "$gyroot" || exit 9',
      'WORKER_TREE="$wt" WORKER_KEY=GY-2950 node --import tsx "$gyroot/tests/helpers/worker-sync.mjs" || echo SYNC-TWO-FAILED',
      'cd "$wt" || exit 9',
      'if test -f "$(git rev-parse --git-path CHERRY_PICK_HEAD)"; then echo AFTER-SYNC2-STATE-REMAINS; else echo AFTER-SYNC2-STATE-CLEAN; fi',
      // The protection the fix must not weaken: the coordinator checkout, its git directory and
      // the base branch stay unwritable, packed-refs with them.
      'if touch "$root/coordinator-probe" 2>/dev/null; then echo COORDINATOR-WRITE-ALLOWED; else echo COORDINATOR-WRITE-BLOCKED; fi',
      'if git -C "$root" -c user.email=w@t -c user.name=Worker commit --allow-empty -m probe >/dev/null 2>&1; then echo COORDINATOR-COMMIT-ALLOWED; else echo COORDINATOR-COMMIT-BLOCKED; fi',
      'head=$(git -C "$root" rev-parse HEAD)',
      'if git -C "$wt" update-ref refs/heads/main "$head" >/dev/null 2>&1; then echo BASE-REF-ALLOWED; else echo BASE-REF-BLOCKED; fi',
      'if printf tampered >> "$root/.git/packed-refs" 2>/dev/null; then echo PACKED-REFS-WRITE-ALLOWED; else echo PACKED-REFS-WRITE-BLOCKED; fi',
    ].join('\n');
    const run = spawnSync(confinement.wrapper[0], [...confinement.wrapper.slice(1, -1), '/bin/sh', '-c', script, 'sh', worktree, root, checkout, saved, savedTwo],
      { encoding: 'utf8', timeout: 240_000, killSignal: 'SIGKILL' });
    assert.equal(run.status, 0, `the confined worker ran successfully: ${run.stderr}`);
    const output = run.stdout + '\n' + run.stderr;
    const syncs = [...run.stdout.matchAll(/^WORKER-SYNC (.*)$/gm)].map(match => JSON.parse(match[1]));
    // The bug's precondition: git concluded the pick — the commit landed — but could not remove
    // its state, so the refusal every later sync met was real.
    assert.ok(run.stdout.includes('PICK-STATE-REMAINS'), 'the completed pick leaves CHERRY_PICK_HEAD behind in the confinement');
    assert.match(output, /packed-refs\.lock/, 'git names the packed-refs lock it could not take');
    assert.equal(syncs.length, 2, `both syncs reported: ${run.stdout}`);
    for (const report of syncs) {
      assert.equal(report.ok, true, `the supported sync succeeds: ${JSON.stringify(report)}`);
      assert.equal(report.merged, true);
      assert.equal(report.fetched, false, 'nothing is fetched: the shared origin/BASE is the merge writer tip');
    }
    assert.ok(run.stdout.includes('AFTER-SYNC-STATE-CLEAN'), 'no CHERRY_PICK_HEAD remains after the sync of the completed pick');
    assert.ok(run.stdout.includes('QUIT-STATE-REMAINS'), 'the quit pick leaves its state behind too');
    assert.ok(run.stdout.includes('AFTER-SYNC2-STATE-CLEAN'), 'and the sync of the quit pick clears it');
    for (const marker of ['COORDINATOR-WRITE-BLOCKED', 'COORDINATOR-COMMIT-BLOCKED', 'BASE-REF-BLOCKED', 'PACKED-REFS-WRITE-BLOCKED'])
      assert.ok(run.stdout.includes(marker), `${marker} — the confinement still protects the coordinator and the base branch`);
    for (const marker of ['COORDINATOR-WRITE-ALLOWED', 'COORDINATOR-COMMIT-ALLOWED', 'BASE-REF-ALLOWED', 'PACKED-REFS-WRITE-ALLOWED', 'SYNC-ONE-FAILED', 'SYNC-TWO-FAILED', 'AFTER-SYNC-STATE-REMAINS', 'AFTER-SYNC2-STATE-REMAINS', 'PICK-STATE-CLEAN', 'QUIT-STATE-CLEAN'])
      assert.ok(!run.stdout.includes(marker), marker);
    // The preserved work landed: the pick commit, the merge of the base tip, the resolution kept,
    // and no pick state on disk.
    const log = execFileSync('git', ['-C', worktree, 'log', '--oneline', '-4'], { encoding: 'utf8' });
    assert.match(log, /saved work/, 'the saved commit was picked onto the branch');
    assert.match(log, /Merge/, 'the supported sync committed the merge');
    assert.equal(readFileSync(join(worktree, 'shared.txt'), 'utf8'), 'resolved by the worker\n', 'the worker resolution survived both syncs');
    assert.equal(existsSync(join(worktree, 'docs', 'advance.md')), true, 'the base tip was merged in');
    assert.equal(existsSync(join(admin, 'CHERRY_PICK_HEAD')), false, 'no CHERRY_PICK_HEAD on disk');
    assert.equal(existsSync(join(admin, 'AUTO_MERGE')), false, 'no AUTO_MERGE on disk');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
