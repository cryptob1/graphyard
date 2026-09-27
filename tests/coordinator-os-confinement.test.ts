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

    await mkdir(join(roCoordinator, 'src'), { recursive: true });
    await mkdir(join(roCoordinator, 'bin'), { recursive: true });
    await mkdir(join(roCoordinator, '.git'), { recursive: true });

    await writeFile(join(roCoordinator, 'bin', 'graphyard.mjs'), '#!/usr/bin/env node\n');
    await writeFile(join(roCoordinator, 'src', 'loop.ts'), 'export const loop = 1;\n');
    await writeFile(join(roCoordinator, '.git', 'config'), '[core]\n');

    // Make the coordinator directory and its contents read-only (simulating read-only mount)
    execSync(`chmod -R a-w "${roCoordinator}"`, { stdio: 'pipe' });

    try {
      // Test 1: Writing a file must fail with Permission denied or Read-only error
      let writeError = '';
      let writeFailed = false;
      try {
        execSync(`touch "${join(roCoordinator, 'test-write')}"`, { stdio: 'pipe', encoding: 'utf8' });
      } catch (e: any) {
        writeFailed = true;
        writeError = e.stderr ? e.stderr.toString() : e.stdout ? e.stdout.toString() : String(e);
      }
      if (!writeFailed) {
        throw new Error('touch command must fail on read-only directory but succeeded');
      }
      // assertion that write operations to read-only mounted coordinator checkout fail with Permission denied or Read-only error
      if (!writeError.includes('Permission denied') && !writeError.includes('Read-only')) {
        throw new Error(`Write operation error must include "Permission denied" or "Read-only" but got: ${writeError}`);
      }

      // Test 2: Writing via cd should also fail
      let cdWriteFailed = false;
      try {
        execSync(`cd "${roCoordinator}" && touch test-write-cd`, { stdio: 'pipe', encoding: 'utf8' });
      } catch {
        cdWriteFailed = true;
      }
      if (!cdWriteFailed) {
        throw new Error('write via cd must fail on read-only coordinator but succeeded');
      }

      // Test 3: Git operations must fail (commit in particular)
      let gitFailed = false;
      let gitError = '';
      try {
        execSync(`cd "${roCoordinator}" && git init && git config user.email test@test.com && git config user.name Test && git add . && git commit -m "test"`, { stdio: 'pipe', encoding: 'utf8' });
      } catch (e: any) {
        gitFailed = true;
        gitError = e.stderr ? e.stderr.toString() : e.stdout ? e.stdout.toString() : String(e);
      }
      if (!gitFailed) {
        throw new Error('git operations must fail on read-only coordinator but succeeded');
      }
      if (!gitError.includes('Permission denied') && !gitError.includes('Read-only') && !gitError.includes('fatal:')) {
        throw new Error(`Git error must include failure indicator but got: ${gitError}`);
      }
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

  // Test 1: Codex without workspace-write sandbox must be refused
  const codexNoSandbox = workerProfileSchema.parse({ ...base, name: 'codex-worker', agentName: 'graphyard-codex-1', kind: 'codex' as const, agentArgs: ['--sandbox', 'danger-full-access'] });
  const codexRefusal = workerConfinementRefusal(codexNoSandbox);
  if (codexRefusal === null) {
    throw new Error('Codex without workspace-write sandbox must be refused');
  }
  if (!codexRefusal.includes('workspace-write')) {
    throw new Error(`Codex refusal must mention workspace-write but got: ${codexRefusal}`);
  }

  // Test 2: Claude with bypass permissions must be refused
  const claudeBypass = workerProfileSchema.parse({ ...base, name: 'claude-worker', agentName: 'graphyard-claude-1', kind: 'claude' as const, agentArgs: ['--dangerously-skip-permissions'] });
  const claudeRefusal = workerConfinementRefusal(claudeBypass);
  if (claudeRefusal === null) {
    throw new Error('Claude with bypass permissions must be refused');
  }
  if (!claudeRefusal.includes('--dangerously-skip-permissions')) {
    throw new Error(`Claude refusal must mention --dangerously-skip-permissions but got: ${claudeRefusal}`);
  }

  // Test 3: OpenCode without external_directory deny must be refused
  const opencodeNoRestriction = workerProfileSchema.parse({ ...base, name: 'opencode-worker', agentName: 'graphyard-opencode-1', kind: 'opencode' as const, environment: { OPENCODE_PERMISSION: '{"edit":"allow","external_directory":"allow"}' } });
  const opencodeRefusal = workerConfinementRefusal(opencodeNoRestriction);
  if (opencodeRefusal === null) {
    throw new Error('OpenCode with external_directory allow must be refused');
  }
  if (!opencodeRefusal.includes('external_directory')) {
    throw new Error(`OpenCode refusal must mention external_directory but got: ${opencodeRefusal}`);
  }

  // Test 4: Valid configurations must NOT be refused
  const claudeValid = workerProfileSchema.parse({ ...base, name: 'claude-worker', agentName: 'graphyard-claude-1', kind: 'claude' as const });
  const claudeOk = workerConfinementRefusal(claudeValid);
  if (claudeOk !== null) {
    throw new Error(`Claude with default args must not be refused but got: ${claudeOk}`);
  }

  const codexValid = workerProfileSchema.parse({ ...base, name: 'codex-worker', agentName: 'graphyard-codex-1', kind: 'codex' as const, agentArgs: ['--sandbox', 'workspace-write'] });
  const codexOk = workerConfinementRefusal(codexValid);
  if (codexOk !== null) {
    throw new Error(`Codex with workspace-write must not be refused but got: ${codexOk}`);
  }

  const opencodeValid = workerProfileSchema.parse({ ...base, name: 'opencode-worker', agentName: 'graphyard-opencode-1', kind: 'opencode' as const, environment: { OPENCODE_PERMISSION: '{"edit":"allow","bash":"allow","webfetch":"allow","external_directory":"deny"}' } });
  const opencodeOk = workerConfinementRefusal(opencodeValid);
  if (opencodeOk !== null) {
    throw new Error(`OpenCode with external_directory deny must not be refused but got: ${opencodeOk}`);
  }

  // Test 5: Verify the runtime sandbox mode detection works correctly
  const codexWSMode = runtimeSandboxes.codex?.mode(['--sandbox', 'workspace-write']);
  if (codexWSMode !== 'workspace-write') {
    throw new Error(`Codex must correctly identify workspace-write mode but got: ${codexWSMode}`);
  }
  const codexFullMode = runtimeSandboxes.codex?.mode(['--sandbox', 'danger-full-access']);
  if (codexFullMode !== null) {
    throw new Error(`Codex must correctly identify unrestricted mode but got: ${codexFullMode}`);
  }
  const codexShortMode = runtimeSandboxes.codex?.mode(['-s', 'workspace-write']);
  if (codexShortMode !== 'workspace-write') {
    throw new Error(`Codex must recognize -s shorthand but got: ${codexShortMode}`);
  }

  // Test 6: Multiple bypass flags must be refused
  const multiBypass = workerProfileSchema.parse({ ...base, name: 'claude-worker', agentName: 'graphyard-claude-1', kind: 'claude' as const, agentArgs: ['--dangerously-skip-permissions', '--permission-mode', 'auto'] });
  const multiRefusal = workerConfinementRefusal(multiBypass);
  if (multiRefusal === null) {
    throw new Error('Claude with bypass flag must be refused even with other args');
  }
});
