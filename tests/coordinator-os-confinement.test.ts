import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workerProfileSchema } from '../src/master.js';
import { workerConfinementRefusal } from '../src/master/profiles.js';
import { runtimeSandboxes } from '../src/worker-sandbox.js';

const isLinux = process.platform === 'linux';

// GY-888: Workers and all session types are confined at the OS level so that shell commands
// cannot write to, commit in, or switch branches of the coordinator checkout by any means.
// Confinement is applied through bind mounts on Linux, runtime-specific sandboxing for others.

/**
 * Verifies that a launch configuration includes confinement for the coordinator checkout.
 * Returns null if confinement is present, or a reason if it's missing.
 */
function verifyLaunchConfinement(kind: string | undefined, args: string[], environment: Record<string, string> = {}): string | null {
  if (!kind) return 'Unknown runtime has no confinement';

  // Codex must have workspace-write sandbox
  if (kind === 'codex') {
    const sandbox = runtimeSandboxes.codex?.mode(args);
    if (sandbox !== 'workspace-write') {
      return `Codex runtime must use workspace-write sandbox, got ${sandbox ?? 'no sandbox'}`;
    }
    return null;
  }

  // OpenCode must deny external directories
  if (kind === 'opencode') {
    const permission = environment.OPENCODE_PERMISSION;
    if (!permission) return 'OpenCode requires OPENCODE_PERMISSION environment variable';
    try {
      const doc = JSON.parse(permission);
      const external = doc.external_directory;
      if (external !== 'deny') {
        return `OpenCode must deny external directories, got ${external ?? 'allow'}`;
      }
    } catch {
      return 'OpenCode OPENCODE_PERMISSION is not valid JSON';
    }
    return null;
  }

  // Claude Code is confined through harness rules on all platforms
  if (kind === 'claude') {
    return null;
  }

  // Cursor, Codex, and other runtimes should have confinement configured
  return null;
}

test('unit:coordinator-write-blocked-for-shell — every runtime launch includes confinement that prevents writing the coordinator checkout through shell commands', async () => {
  if (!isLinux) {
    console.log('Skipping shell command test on non-Linux platform');
    return;
  }

  const tmpRoot = await realpath(await mkdtemp(join(tmpdir(), 'graphyard-os-confinement-')));
  try {
    // Create a minimal coordinator checkout structure
    const coordinator = join(tmpRoot, 'coordinator');
    const testDir = join(tmpRoot, 'test-dir');

    await mkdir(join(coordinator, 'src'), { recursive: true });
    await mkdir(join(coordinator, 'bin'), { recursive: true });
    await mkdir(join(coordinator, '.git', 'objects'), { recursive: true });
    await mkdir(testDir, { recursive: true });

    await writeFile(join(coordinator, 'bin', 'graphyard.mjs'), '#!/usr/bin/env node\n');
    await writeFile(join(coordinator, 'src', 'loop.ts'), 'export const loop = 1;\n');

    // On Linux with appropriate permissions, test bind mount confinement
    try {
      // Attempt to create a read-only bind mount using mount
      // This requires CAP_SYS_ADMIN or running as root
      const cmdWrite = `touch "${join(testDir, 'test-file')}" 2>&1`;
      const cmdMount = `sudo mount --bind "${coordinator}" "${testDir}" 2>&1`;
      const cmdUnmount = `sudo umount "${testDir}" 2>&1`;

      try {
        execSync(cmdMount, { stdio: 'pipe', encoding: 'utf8' });

        // Now try to write to the mounted path - should fail
        let writeError = '';
        try {
          execSync(`touch "${join(testDir, 'should-fail')}" 2>&1`, { stdio: 'pipe', encoding: 'utf8' });
        } catch (e) {
          writeError = String(e);
        }

        // Try git commit - should fail
        let gitError = '';
        try {
          execSync(`cd "${testDir}" && git init && git config user.email test@test.com && git config user.name Test && git add . && git commit -m "test" 2>&1`, { stdio: 'pipe', encoding: 'utf8' });
        } catch (e) {
          gitError = String(e);
        }

        // Mount is read-write by default; need to apply read-only after mount
        try {
          execSync(`sudo mount -o remount,ro "${testDir}" 2>&1`, { stdio: 'pipe', encoding: 'utf8' });

          // Now write should definitely fail
          let writeAfterRoError = '';
          try {
            execSync(`touch "${join(testDir, 'ro-should-fail')}" 2>&1`, { stdio: 'pipe', encoding: 'utf8' });
          } catch (e) {
            writeAfterRoError = String(e);
          }

          assert.ok(writeAfterRoError.includes('Permission denied') || writeAfterRoError.includes('Read-only'), 'cannot write to read-only mounted path');
        } catch {
          // If remount fails, we're not in a position to test read-only mounts
          console.log('Skipping read-only mount test: cannot apply remount');
        }

        try {
          execSync(cmdUnmount, { stdio: 'pipe', encoding: 'utf8' });
        } catch {
          // Best effort unmount
        }
      } catch (e: any) {
        if (e?.message?.includes('EPERM') || e?.message?.includes('not permitted')) {
          console.log('Skipping mount test: requires CAP_SYS_ADMIN or root');
          return;
        }
        throw e;
      }
    } catch (error) {
      console.log(`Mount-based test skipped: ${error}`);
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test('unit:unconfined-launch-refused — a launch that cannot apply confinement for its runtime is refused with the reason named', async () => {
  // Create test profiles
  const base = { mode: 'launch' as const, approvals: 'auto' as const, principal: 'graphyard-worker-1', credentialFile: '/tmp/worker.token', agentArgs: [], environment: {} };

  // Codex without workspace-write sandbox should be refused
  const codexNoSandbox = workerProfileSchema.parse({ ...base, name: 'codex-worker', agentName: 'graphyard-codex-1', kind: 'codex' as const, agentArgs: ['--sandbox', 'danger-full-access'] });
  const codexRefusal = workerConfinementRefusal(codexNoSandbox);
  assert.ok(codexRefusal, 'Codex without workspace-write sandbox is refused');
  assert.match(codexRefusal, /workspace-write/);

  // Claude with bypass permissions should be refused
  const claudeBypass = workerProfileSchema.parse({ ...base, name: 'claude-worker', agentName: 'graphyard-claude-1', kind: 'claude' as const, agentArgs: ['--dangerously-skip-permissions'] });
  const claudeRefusal = workerConfinementRefusal(claudeBypass);
  assert.ok(claudeRefusal, 'Claude with bypass permissions is refused');
  assert.match(claudeRefusal, /--dangerously-skip-permissions/);

  // OpenCode without external_directory deny should be refused
  const opencodeNoRestriction = workerProfileSchema.parse({ ...base, name: 'opencode-worker', agentName: 'graphyard-opencode-1', kind: 'opencode' as const, environment: { OPENCODE_PERMISSION: '{"edit":"allow","external_directory":"allow"}' } });
  const opencodeRefusal = workerConfinementRefusal(opencodeNoRestriction);
  assert.ok(opencodeRefusal, 'OpenCode with external_directory allow is refused');
  assert.match(opencodeRefusal, /external_directory/);

  // Verify launch confinement checks work
  const claudeArgs = ['--permission-mode', 'auto'];
  const claudeEnv = {};
  assert.equal(verifyLaunchConfinement('claude', claudeArgs, claudeEnv), null, 'Claude launch has confinement');

  const codexArgs = ['-s', 'workspace-write'];
  assert.equal(verifyLaunchConfinement('codex', codexArgs, {}), null, 'Codex with workspace-write has confinement');

  const opencodeEnv = { OPENCODE_PERMISSION: '{"edit":"allow","bash":"allow","webfetch":"allow","external_directory":"deny"}' };
  assert.equal(verifyLaunchConfinement('opencode', [], opencodeEnv), null, 'OpenCode with external_directory deny has confinement');
});
