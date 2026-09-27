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

test('unit:coordinator-write-blocked-for-shell — shell commands cannot write to or commit in the coordinator checkout through read-only permissions', async () => {
  if (!isLinux) {
    console.log('Skipping shell command test on non-Linux platform');
    return;
  }

  const tmpRoot = await realpath(await mkdtemp(join(tmpdir(), 'graphyard-os-confinement-')));
  try {
    // Create a minimal coordinator checkout structure with read-only permissions
    const roCoordinator = join(tmpRoot, 'ro-coordinator');
    const rwTest = join(tmpRoot, 'rw-test');

    await mkdir(join(roCoordinator, 'src'), { recursive: true });
    await mkdir(join(roCoordinator, 'bin'), { recursive: true });
    await mkdir(join(roCoordinator, '.git'), { recursive: true });
    await mkdir(rwTest, { recursive: true });

    await writeFile(join(roCoordinator, 'bin', 'graphyard.mjs'), '#!/usr/bin/env node\n');
    await writeFile(join(roCoordinator, 'src', 'loop.ts'), 'export const loop = 1;\n');
    await writeFile(join(roCoordinator, '.git', 'config'), '[core]\n');

    // Make the coordinator directory and its contents read-only (simulating read-only mount)
    execSync(`chmod -R a-w "${roCoordinator}"`, { stdio: 'pipe' });

    try {
      // Test 1: Writing a file should fail
      let writeError = '';
      let writeFailed = false;
      try {
        execSync(`touch "${join(roCoordinator, 'test-write')}"`, { stdio: 'pipe', encoding: 'utf8' });
      } catch (e: any) {
        writeFailed = true;
        writeError = e.stderr ? e.stderr.toString() : e.stdout ? e.stdout.toString() : String(e);
      }
      assert.ok(writeFailed, 'touch command should fail on read-only directory');
      assert.ok(writeError.includes('Permission denied') || writeError.includes('Read-only'), 'assertion that write operations to read-only mounted coordinator checkout fail with Permission denied or Read-only error');

      // Test 2: Writing via cd into the directory should also fail
      let cdWriteError = '';
      let cdWriteFailed = false;
      try {
        execSync(`cd "${roCoordinator}" && touch test-write-cd`, { stdio: 'pipe', encoding: 'utf8' });
      } catch (e: any) {
        cdWriteFailed = true;
        cdWriteError = e.stderr ? e.stderr.toString() : e.stdout ? e.stdout.toString() : String(e);
      }
      assert.ok(cdWriteFailed, 'write via cd should fail on read-only coordinator');

      // Test 3: Git operations should fail (commit in particular)
      let gitFailed = false;
      let gitError = '';
      try {
        // Try to add and commit (this is what we're protecting against)
        execSync(`cd "${roCoordinator}" && git init && git config user.email test@test.com && git config user.name Test && git add . && git commit -m "test"`, { stdio: 'pipe', encoding: 'utf8' });
      } catch (e: any) {
        gitFailed = true;
        gitError = e.stderr ? e.stderr.toString() : e.stdout ? e.stdout.toString() : String(e);
      }
      assert.ok(gitFailed, 'git operations should fail on read-only coordinator');
      assert.ok(gitError.includes('Permission denied') || gitError.includes('Read-only') || gitError.includes('fatal:'), 'git operations fail on read-only coordinator');
    } finally {
      // Restore write permissions for cleanup
      execSync(`chmod -R u+w "${roCoordinator}"`, { stdio: 'pipe' });
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test('unit:unconfined-launch-refused — launches without proper confinement are refused by workerConfinementRefusal', async () => {
  // Create test profiles
  const base = { mode: 'launch' as const, approvals: 'auto' as const, principal: 'graphyard-worker-1', credentialFile: '/tmp/worker.token', agentArgs: [], environment: {} };

  // Test 1: Codex without workspace-write sandbox should be refused
  const codexNoSandbox = workerProfileSchema.parse({ ...base, name: 'codex-worker', agentName: 'graphyard-codex-1', kind: 'codex' as const, agentArgs: ['--sandbox', 'danger-full-access'] });
  const codexRefusal = workerConfinementRefusal(codexNoSandbox);
  assert.ok(codexRefusal !== null, 'Codex without workspace-write sandbox is refused');
  assert.match(codexRefusal!, /workspace-write/);

  // Test 2: Claude with bypass permissions should be refused
  const claudeBypass = workerProfileSchema.parse({ ...base, name: 'claude-worker', agentName: 'graphyard-claude-1', kind: 'claude' as const, agentArgs: ['--dangerously-skip-permissions'] });
  const claudeRefusal = workerConfinementRefusal(claudeBypass);
  assert.ok(claudeRefusal !== null, 'Claude with bypass permissions is refused');
  assert.match(claudeRefusal!, /--dangerously-skip-permissions/);

  // Test 3: OpenCode without external_directory deny should be refused
  const opencodeNoRestriction = workerProfileSchema.parse({ ...base, name: 'opencode-worker', agentName: 'graphyard-opencode-1', kind: 'opencode' as const, environment: { OPENCODE_PERMISSION: '{"edit":"allow","external_directory":"allow"}' } });
  const opencodeRefusal = workerConfinementRefusal(opencodeNoRestriction);
  assert.ok(opencodeRefusal !== null, 'OpenCode with external_directory allow is refused');
  assert.match(opencodeRefusal!, /external_directory/);

  // Test 4: Valid configurations should not be refused
  const claudeValid = workerProfileSchema.parse({ ...base, name: 'claude-worker', agentName: 'graphyard-claude-1', kind: 'claude' as const });
  const claudeOk = workerConfinementRefusal(claudeValid);
  assert.equal(claudeOk, null, 'Claude with default args is not refused');

  const codexValid = workerProfileSchema.parse({ ...base, name: 'codex-worker', agentName: 'graphyard-codex-1', kind: 'codex' as const, agentArgs: ['--sandbox', 'workspace-write'] });
  const codexOk = workerConfinementRefusal(codexValid);
  assert.equal(codexOk, null, 'Codex with workspace-write is not refused');

  const opencodeValid = workerProfileSchema.parse({ ...base, name: 'opencode-worker', agentName: 'graphyard-opencode-1', kind: 'opencode' as const, environment: { OPENCODE_PERMISSION: '{"edit":"allow","bash":"allow","webfetch":"allow","external_directory":"deny"}' } });
  const opencodeOk = workerConfinementRefusal(opencodeValid);
  assert.equal(opencodeOk, null, 'OpenCode with external_directory deny is not refused');

  // Test 5: Verify the runtime sandbox mode detection works correctly
  assert.equal(runtimeSandboxes.codex?.mode(['--sandbox', 'workspace-write']), 'workspace-write', 'Codex correctly identifies workspace-write mode');
  assert.equal(runtimeSandboxes.codex?.mode(['--sandbox', 'danger-full-access']), null, 'Codex correctly identifies unrestricted mode');
  assert.equal(runtimeSandboxes.codex?.mode(['-s', 'workspace-write']), 'workspace-write', 'Codex recognizes -s shorthand');

  // Test 6: Multiple bypass flags should be refused
  const multiBypass = workerProfileSchema.parse({ ...base, name: 'claude-worker', agentName: 'graphyard-claude-1', kind: 'claude' as const, agentArgs: ['--dangerously-skip-permissions', '--permission-mode', 'auto'] });
  const multiRefusal = workerConfinementRefusal(multiBypass);
  assert.ok(multiRefusal !== null, 'Claude with bypass flag is refused even with other args');
});
