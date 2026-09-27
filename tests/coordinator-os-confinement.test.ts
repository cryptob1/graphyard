import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { coordinatorConfinement, coordinatorConfinementRefusal, sessionMountNamespaceWorks, workerConfinementRefusal } from '../src/master/profiles.js';
import { prepareConfinedGitPaths } from '../src/master/launch.js';

// GY-888: every session the launcher starts — worker, reviewer, producer and approver — is
// launched so that the coordinator checkout is unwritable at the OS level, shell commands
// included. A runtime with a workspace-write sandbox is confined by its sandbox; every other
// runtime runs inside a bubblewrap mount namespace that mounts the checkout read-only and
// re-exposes only the session's own worktree and the shared Git areas it writes. A launch that
// can carry no confinement is refused with the reason named, never started unconfined.

/** A coordinator checkout with a linked assignment worktree under it, exactly as the launcher prepares them. */
function coordinatorFixture(base: string) {
  const root = join(base, 'coordinator');
  const run = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 1;\n');
  run('init', '-b', 'main');
  run('config', 'user.email', 'graphyard@localhost');
  run('config', 'user.name', 'Graphyard');
  run('add', '.');
  run('commit', '-m', 'coordinator');
  const worktree = join(root, '.graphyard', 'worktrees', 'session');
  mkdirSync(dirname(worktree), { recursive: true });
  run('worktree', 'add', '-b', 'graphyard/gy-888-1', worktree, 'main');
  prepareConfinedGitPaths(root);
  return { root, worktree };
}

test('unit:coordinator-write-blocked-for-shell — every runtime kind launches confined, and a confined shell cannot write, commit in or switch the coordinator checkout', async () => {
  const base = mkdtempSync(join(tmpdir(), 'graphyard-confinement-'));
  try {
    const { root, worktree } = coordinatorFixture(base);
    // Every runtime kind builds a launch whose confinement is present, by the mechanism its runtime supports.
    for (const [kind, args] of [['claude', []], ['cursor', []], ['opencode', []], ['pi', []], ['codex', ['--sandbox', 'workspace-write']]] as [string, string[]][]) {
      const confinement = await coordinatorConfinement({ kind, args, coordinatorRoot: root, sessionDirectory: worktree, platform: 'linux', mountNamespaceWorks: true });
      assert.ok(confinement, `${kind} launches confined`);
      if (kind === 'codex') {
        assert.equal(confinement.mechanism, 'runtime-sandbox', 'the codex workspace-write sandbox is the confinement');
        assert.deepEqual(confinement.wrapper, [], 'the runtime sandbox needs no wrapper words');
      } else {
        assert.equal(confinement.mechanism, 'read-only-mount');
        assert.ok(confinement.wrapper.includes('--ro-bind') && confinement.wrapper.includes(root), `${kind} binds the coordinator checkout read-only`);
        assert.ok(confinement.wrapper.includes('--bind') && confinement.wrapper.includes(worktree), `${kind} re-exposes the session's own worktree writable`);
        assert.ok(confinement.wrapper.at(-1) === '--', `${kind}'s wrapper leaves the runtime command itself in place`);
      }
    }
    // A codex runtime without its workspace-write sandbox carries the mount namespace instead: it is never launched unconfined.
    const unconfinedCodex = await coordinatorConfinement({ kind: 'codex', args: ['--sandbox', 'danger-full-access'], coordinatorRoot: root, sessionDirectory: worktree, platform: 'linux', mountNamespaceWorks: true });
    assert.equal(unconfinedCodex?.mechanism, 'read-only-mount', 'a codex sandbox turned off falls back to the read-only mount');
    // On Linux with the namespaces available, run a shell command inside the confinement itself.
    if (process.platform !== 'linux' || !(await sessionMountNamespaceWorks())) return;
    const confinement = await coordinatorConfinement({ kind: 'claude', args: [], coordinatorRoot: root, sessionDirectory: worktree });
    assert.equal(confinement?.mechanism, 'read-only-mount');
    const probe = [
      'if touch "$1/coordinator-write-probe" 2>/tmp/.gy-probe-1; then echo WRITE-ALLOWED; else echo WRITE-BLOCKED; tail -1 /tmp/.gy-probe-1; fi',
      'if git -C "$1" -c user.email=g@l -c user.name=g commit --allow-empty -m probe 2>/tmp/.gy-probe-2; then echo COMMIT-ALLOWED; else echo COMMIT-BLOCKED; tail -1 /tmp/.gy-probe-2; fi',
      'if git -C "$1" checkout -b gy-888-escape 2>/tmp/.gy-probe-3; then echo CHECKOUT-ALLOWED; else echo CHECKOUT-BLOCKED; tail -1 /tmp/.gy-probe-3; fi',
      'touch "$2/session-write-probe" && git -C "$2" -c user.email=g@l -c user.name=g commit --allow-empty -m probe && echo SESSION-WROTE',
    ].join('\n');
    const run = spawnSync(confinement.wrapper[0], [...confinement.wrapper.slice(1, -1), '/bin/sh', '-c', probe, 'sh', root, worktree],
      { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' });
    assert.equal(run.status, 0, `the confined shell ran and its session worktree worked: ${run.stderr}`);
    for (const marker of ['WRITE-BLOCKED', 'COMMIT-BLOCKED', 'CHECKOUT-BLOCKED', 'SESSION-WROTE']) assert.ok(run.stdout.includes(marker), `${marker} was expected: ${run.stdout}`);
    for (const marker of ['WRITE-ALLOWED', 'COMMIT-ALLOWED', 'CHECKOUT-ALLOWED']) assert.ok(!run.stdout.includes(marker), `${marker} must never happen: ${run.stdout}`);
    assert.match(run.stdout, /Read-only file system/, `writing the checkout is refused by the mount itself: ${run.stdout}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('unit:unconfined-launch-refused — a launch that cannot apply the confinement is refused with the reason named, never started unconfined', async () => {
  const confined = { kind: 'claude', args: [] as string[], coordinatorRoot: '/coordinator', sessionDirectory: '/coordinator/wt' };
  // No mount namespace without Linux, without bubblewrap, or on a host that refuses the namespaces.
  const darwin = await coordinatorConfinementRefusal({ ...confined, platform: 'darwin' });
  assert.match(darwin!, /never starts a session unconfined/);
  assert.match(darwin!, /darwin/);
  const noBwrap = await coordinatorConfinementRefusal({ ...confined, platform: 'linux', bwrap: null });
  assert.match(noBwrap!, /bubblewrap/);
  const refusedNamespaces = await coordinatorConfinementRefusal({ ...confined, platform: 'linux', mountNamespaceWorks: false });
  assert.match(refusedNamespaces!, /namespaces/);
  // The builder carries the same refusal: it never returns an unconfined launch.
  await assert.rejects(() => coordinatorConfinement({ ...confined, platform: 'darwin', mountNamespaceWorks: true }), /never starts a session unconfined/);
  // A runtime with a workspace-write sandbox of its own needs neither Linux nor bubblewrap.
  assert.equal(await coordinatorConfinementRefusal({ kind: 'codex', args: ['--sandbox', 'workspace-write'], coordinatorRoot: '/coordinator', sessionDirectory: '/coordinator/wt', platform: 'darwin' }), null);
  // A worker profile that would turn its runtime's own confinement off is still refused at the launch (GY-857).
  assert.match(workerConfinementRefusal({ kind: 'claude', agentArgs: ['--dangerously-skip-permissions'] })!, /--dangerously-skip-permissions/);
  assert.match(workerConfinementRefusal({ kind: 'codex', agentArgs: ['--sandbox', 'danger-full-access'] })!, /workspace-write/);
  assert.match(workerConfinementRefusal({ kind: 'opencode', environment: { OPENCODE_PERMISSION: '{"edit":"allow","external_directory":"allow"}' } })!, /external_directory/);
  assert.equal(workerConfinementRefusal({ kind: 'claude', agentArgs: [] }), null);
  assert.equal(workerConfinementRefusal({ kind: 'codex', agentArgs: ['--sandbox', 'workspace-write'] }), null);
});
