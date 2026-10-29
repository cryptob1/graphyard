import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { coordinatorConfinement, sessionMountNamespaceWorks } from '../src/master/profiles.js';
import { prepareConfinedGitPaths } from '../src/master/launch.js';
import { grantWorkerPaths, runtimeSandboxes, workerPaths, writablePaths } from '../src/worker-sandbox.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2977: GY-2967 made the outer bubblewrap layer re-expose the common git directory writable for
// packed-refs.lock, but each runtime's own sandbox (Codex --add-dir) still omitted it, so a worker
// nested inside both still failed every packed-ref update with EROFS. The grant now includes the
// common directory; the outer confinement's read-only re-binds of the coordinator's index, HEAD,
// config, hooks and non-graphyard refs keep the base branch and checkout protected.

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
  const worktree = join(root, '.graphyard', 'worktrees', 'gy-2977-1');
  mkdirSync(dirname(worktree), { recursive: true });
  run('worktree', 'add', '-b', 'graphyard/gy-2977-1', worktree, 'main');
  const other = join(root, '.graphyard', 'worktrees', 'gy-2977-2');
  run('worktree', 'add', '-b', 'graphyard/gy-2977-2', other, 'main');
  writeFileSync(join(other, 'other.txt'), 'other\n');
  execFileSync('git', ['-C', other, 'add', '.']);
  execFileSync('git', ['-C', other, 'commit', '-m', 'other branch work']);
  const otherTip = execFileSync('git', ['-C', other, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  run('worktree', 'remove', other);
  run('branch', 'graphyard/gy-2977-gone', 'main');
  run('pack-refs', '--all');
  const packed = readFileSync(join(root, '.git', 'packed-refs'), 'utf8');
  assert.match(packed, /refs\/heads\/main/, 'refs/heads/main is packed');
  assert.match(packed, /refs\/heads\/graphyard\/gy-2977-1/, 'the assignment branch is packed');
  assert.match(packed, /refs\/heads\/graphyard\/gy-2977-2/, 'the second branch is packed');
  assert.match(packed, /refs\/heads\/graphyard\/gy-2977-gone/, 'the disposable branch is packed');
  const main = run('rev-parse', 'refs/heads/main');
  prepareConfinedGitPaths(root);
  return { root, worktree, main, otherTip };
}

/** Runtimes whose launch arguments carry a write-restricting sandbox that this host can probe. */
function probeableRuntimes(): string[] {
  return Object.entries(runtimeSandboxes)
    .filter(([, sandbox]) => sandbox.mode(['--sandbox', 'workspace-write']) === 'workspace-write')
    .map(([kind]) => kind)
    .filter(kind => kind !== 'codex' || spawnSync('codex', ['--version'], { stdio: 'ignore' }).status === 0);
}

const refUpdateScript = [
  'wt="$1"; root="$2"; tip="$3"',
  'cd "$wt" || exit 9',
  'printf change > shared.txt && git -c user.email=w@t -c user.name=Worker commit -q -a -m \'worker change\' && echo COMMIT-OK || echo COMMIT-FAILED',
  'git -c user.email=w@t -c user.name=Worker merge -q --no-edit "$tip" && echo MERGE-OK || echo MERGE-FAILED',
  'git branch -f graphyard/gy-2977-3 HEAD && echo BRANCH-OK || echo BRANCH-FAILED',
  'git update-ref -d refs/heads/graphyard/gy-2977-gone && echo DELETE-OK || echo DELETE-FAILED',
  'if touch "$root/coordinator-probe" 2>/dev/null; then echo COORDINATOR-WRITE-ALLOWED; else echo COORDINATOR-WRITE-BLOCKED; fi',
  'if git -C "$root" -c user.email=w@t -c user.name=Worker commit --allow-empty -q -m probe 2>/dev/null; then echo COORDINATOR-COMMIT-ALLOWED; else echo COORDINATOR-COMMIT-BLOCKED; fi',
  'if git -C "$wt" update-ref refs/heads/main HEAD 2>/dev/null; then echo BASE-REF-ALLOWED; else echo BASE-REF-BLOCKED; fi',
  'if printf x > "$root/.git/index" 2>/dev/null; then echo INDEX-WRITE-ALLOWED; else echo INDEX-WRITE-BLOCKED; fi',
].join('\n');

test('unit:runtime-sandbox-ref-updates-on-packed-refs — inside the outer confinement wrapping each probeable runtime sandbox, every packed-ref update works: commit, merge, branch -f and update-ref -d each succeed while the coordinator\'s main and index stay refused; without the common-dir grant the Codex case fails on packed-refs.lock', async () => {
  const kinds = probeableRuntimes();
  assert.ok(kinds.includes('codex'), 'Codex is on PATH so its sandbox can be probed');
  if (process.platform !== 'linux') return;
  assert.ok(await sessionMountNamespaceWorks(), 'mount namespaces work on this Linux host');

  for (const kind of kinds) {
    // The pre-fix grant (shared paths only) still fails Codex on packed-refs.lock — the base-commit fault.
    if (kind === 'codex') {
      const oldBase = await temporaryDirectory('runtime sandbox packed refs old');
      try {
        const { root, worktree, otherTip } = fixture(oldBase);
        const paths = workerPaths(worktree);
        const oldWritable = writablePaths(paths).filter(path => path !== paths.commonDir);
        const oldArgs = grantWorkerPaths(kind, ['--sandbox', 'workspace-write'], oldWritable, worktree);
        const oldConf = await coordinatorConfinement({ kind, args: oldArgs, coordinatorRoot: root, sessionDirectory: worktree, platform: 'linux', mountNamespaceWorks: true, bwrap: 'bwrap' });
        assert.equal(oldConf?.mechanism, 'read-only-mount');
        const oldInner = runtimeSandboxes[kind].probe(oldArgs, worktree, ['/bin/sh', '-c', refUpdateScript, 'sh', worktree, root, otherTip]);
        const oldRun = spawnSync(oldConf!.wrapper[0], [...oldConf!.wrapper.slice(1), oldInner.command, ...oldInner.args],
          { encoding: 'utf8', timeout: 240_000, killSignal: 'SIGKILL', cwd: worktree });
        const oldOutput = `${oldRun.stdout}\n${oldRun.stderr}`;
        assert.ok(oldOutput.includes('packed-refs.lock') && /Read-only file system/.test(oldOutput),
          `without the common-dir grant Codex fails on packed-refs.lock EROFS: ${oldOutput.slice(0, 600)}`);
        assert.ok(!oldRun.stdout.includes('DELETE-OK'), 'the packed-ref delete does not succeed under the old grant');
      } finally {
        rmSync(oldBase, { recursive: true, force: true });
      }
    }

    const fixedBase = await temporaryDirectory(`runtime sandbox packed refs ${kind}`);
    try {
      const { root, worktree, main, otherTip } = fixture(fixedBase);
      const paths = workerPaths(worktree);
      const writable = writablePaths(paths);
      assert.ok(paths.commonDir && writable.includes(paths.commonDir), `${kind} grant list includes the common Git directory`);
      const args = grantWorkerPaths(kind, ['--sandbox', 'workspace-write'], writable, worktree);
      const confinement = await coordinatorConfinement({ kind, args, coordinatorRoot: root, sessionDirectory: worktree, platform: 'linux', mountNamespaceWorks: true, bwrap: 'bwrap' });
      assert.ok(confinement, `${kind} worker launch carries a confinement`);
      assert.equal(confinement.mechanism, 'read-only-mount', `${kind} carries the outer mount once the common Git directory is granted`);
      const inner = runtimeSandboxes[kind].probe(args, worktree, ['/bin/sh', '-c', refUpdateScript, 'sh', worktree, root, otherTip]);
      const run = spawnSync(confinement.wrapper[0], [...confinement.wrapper.slice(1), inner.command, ...inner.args],
        { encoding: 'utf8', timeout: 240_000, killSignal: 'SIGKILL', cwd: worktree });
      assert.equal(run.status, 0, `${kind} nested sandbox ran successfully: ${run.stderr}`);
      const output = `${run.stdout}\n${run.stderr}`;
      for (const marker of ['COMMIT-OK', 'MERGE-OK', 'BRANCH-OK', 'DELETE-OK'])
        assert.ok(run.stdout.includes(marker), `${kind}: ${marker} — the packed-ref update succeeded: ${run.stdout}`);
      for (const marker of ['COMMIT-FAILED', 'MERGE-FAILED', 'BRANCH-FAILED', 'DELETE-FAILED',
        'COORDINATOR-WRITE-ALLOWED', 'COORDINATOR-COMMIT-ALLOWED', 'BASE-REF-ALLOWED', 'INDEX-WRITE-ALLOWED'])
        assert.ok(!output.includes(marker), `${kind}: ${marker} never appears`);
      for (const marker of ['COORDINATOR-WRITE-BLOCKED', 'COORDINATOR-COMMIT-BLOCKED', 'BASE-REF-BLOCKED', 'INDEX-WRITE-BLOCKED'])
        assert.ok(run.stdout.includes(marker), `${kind}: ${marker} — the outer confinement still protects the coordinator`);
      assert.equal(execFileSync('git', ['-C', root, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim(), main, `${kind}: main did not move`);
      assert.doesNotMatch(readFileSync(join(root, '.git', 'packed-refs'), 'utf8'), /gy-2977-gone/, `${kind}: the deleted branch is gone from packed-refs`);
      assert.ok(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }) === '', `${kind}: the coordinator checkout stays clean`);
    } finally {
      rmSync(fixedBase, { recursive: true, force: true });
    }
  }
});
