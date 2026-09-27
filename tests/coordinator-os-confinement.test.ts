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
        assert.equal(confinement.mechanism, 'read-only-mount', `${kind} uses read-only-mount mechanism`);
        const roIdx = confinement.wrapper.indexOf('--ro-bind');
        assert.ok(roIdx >= 0 && confinement.wrapper[roIdx + 1] === root && confinement.wrapper[roIdx + 2] === root, `${kind} binds ${root} read-only with correct arguments`);
        const worktreeIdx = confinement.wrapper.indexOf(worktree);
        assert.ok(worktreeIdx > 0 && confinement.wrapper[worktreeIdx - 1] === '--bind', `${kind} re-exposes ${worktree} with --bind`);
        assert.equal(confinement.wrapper.at(-1), '--', `${kind}'s wrapper ends with --`);
      }
    }
    // A codex runtime without its workspace-write sandbox carries the mount namespace instead: it is never launched unconfined.
    const unconfinedCodex = await coordinatorConfinement({ kind: 'codex', args: ['--sandbox', 'danger-full-access'], coordinatorRoot: root, sessionDirectory: worktree, platform: 'linux', mountNamespaceWorks: true });
    assert.equal(unconfinedCodex?.mechanism, 'read-only-mount', 'a codex sandbox turned off falls back to the read-only mount');
    // On Linux with the namespaces available, run a shell command inside the confinement itself.
    if (process.platform !== 'linux') return;
    assert.ok(await sessionMountNamespaceWorks(), 'mount namespaces work on this Linux host');
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
    assert.equal(run.status, 0, `the confined shell ran successfully: ${run.stderr}`);
    const output = run.stdout + '\n' + run.stderr;
    assert.ok(run.stdout.includes('WRITE-BLOCKED'), 'write to coordinator checkout is blocked');
    assert.ok(run.stdout.includes('COMMIT-BLOCKED'), 'git commit in coordinator checkout is blocked');
    assert.ok(run.stdout.includes('CHECKOUT-BLOCKED'), 'git checkout in coordinator checkout is blocked');
    assert.ok(run.stdout.includes('SESSION-WROTE'), 'session worktree is writable');
    assert.ok(!run.stdout.includes('WRITE-ALLOWED'), 'write to coordinator is never allowed');
    assert.ok(!run.stdout.includes('COMMIT-ALLOWED'), 'commit in coordinator is never allowed');
    assert.ok(!run.stdout.includes('CHECKOUT-ALLOWED'), 'checkout in coordinator is never allowed');
    assert.match(output, /Read-only file system/, 'operations fail with read-only filesystem error');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('unit:unconfined-launch-refused — a launch that cannot apply the confinement is refused with the reason named, never started unconfined', async () => {
  const confined = { kind: 'claude', args: [] as string[], coordinatorRoot: '/coordinator', sessionDirectory: '/coordinator/wt' };
  // No mount namespace without Linux, without bubblewrap, or on a host that refuses the namespaces.
  const darwin = await coordinatorConfinementRefusal({ ...confined, platform: 'darwin' });
  assert.ok(darwin !== null, 'darwin platform must be refused');
  assert.match(darwin!, /never starts a session unconfined/, 'refusal message includes confinement requirement');
  assert.match(darwin!, /darwin/, 'refusal message identifies platform');

  const noBwrap = await coordinatorConfinementRefusal({ ...confined, platform: 'linux', bwrap: null });
  assert.ok(noBwrap !== null, 'missing bubblewrap must be refused');
  assert.match(noBwrap!, /bubblewrap/, 'refusal message mentions bubblewrap');
  assert.match(noBwrap!, /not installed/, 'refusal message says bubblewrap is not installed');

  const refusedNamespaces = await coordinatorConfinementRefusal({ ...confined, platform: 'linux', mountNamespaceWorks: false });
  assert.ok(refusedNamespaces !== null, 'refused mount namespaces must be refused');
  assert.match(refusedNamespaces!, /namespaces/, 'refusal message mentions namespaces');
  assert.match(refusedNamespaces!, /refuses/, 'refusal message indicates the host refuses namespaces');

  // The builder carries the same refusal: it never returns an unconfined launch.
  await assert.rejects(() => coordinatorConfinement({ ...confined, platform: 'darwin', mountNamespaceWorks: true }), /never starts a session unconfined/);

  // A runtime with a workspace-write sandbox of its own needs neither Linux nor bubblewrap.
  const sandboxedCodex = await coordinatorConfinementRefusal({ kind: 'codex', args: ['--sandbox', 'workspace-write'], coordinatorRoot: '/coordinator', sessionDirectory: '/coordinator/wt', platform: 'darwin' });
  assert.equal(sandboxedCodex, null, 'codex with workspace-write sandbox is not refused on darwin');

  // A worker profile that would turn its runtime's own confinement off is still refused at the launch (GY-857).
  const claudeBypass = workerConfinementRefusal({ kind: 'claude', agentArgs: ['--dangerously-skip-permissions'] });
  assert.ok(claudeBypass !== null, 'claude with --dangerously-skip-permissions must be refused');
  assert.match(claudeBypass!, /--dangerously-skip-permissions/, 'refusal message names the flag');
  assert.match(claudeBypass!, /confinement/, 'refusal message explains it disables confinement');

  const codexUnsandboxed = workerConfinementRefusal({ kind: 'codex', agentArgs: ['--sandbox', 'danger-full-access'] });
  assert.ok(codexUnsandboxed !== null, 'codex without workspace-write sandbox must be refused');
  assert.match(codexUnsandboxed!, /workspace-write/, 'refusal message identifies correct sandbox mode');
  assert.match(codexUnsandboxed!, /danger-full-access/, 'refusal message names the incorrect setting');

  const opencodeUndanied = workerConfinementRefusal({ kind: 'opencode', environment: { OPENCODE_PERMISSION: '{"edit":"allow","external_directory":"allow"}' } });
  assert.ok(opencodeUndanied !== null, 'opencode with external_directory allow must be refused');
  assert.match(opencodeUndanied!, /external_directory/, 'refusal message identifies the permission');
  assert.match(opencodeUndanied!, /"deny"/, 'refusal message specifies correct setting');

  const claudeSafe = workerConfinementRefusal({ kind: 'claude', agentArgs: [] });
  assert.equal(claudeSafe, null, 'claude with no flags is allowed');

  const codexSafe = workerConfinementRefusal({ kind: 'codex', agentArgs: ['--sandbox', 'workspace-write'] });
  assert.equal(codexSafe, null, 'codex with workspace-write is allowed');
});
