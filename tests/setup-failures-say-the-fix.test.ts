import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { setupFromZeroChecks, setupLine } from '../src/setup-from-zero.js';

test('e2e:setup-failures-say-the-fix — doctor gives remedies on a host missing bubblewrap with an old kernel', async () => {
  const root = await temporaryDirectory('setup-failures');
  execFileSync('git', ['init', root], { stdio: 'ignore' });
  const checks = await setupFromZeroChecks({
    root, env: {}, status: null, environments: join(root, 'agents'), loopCode: null,
    systemctl: () => '', platform: 'linux',
    sandbox: () => 'bubblewrap (bwrap) is not installed', landlockAbi: () => 8,
  });
  const line = (id: string) => setupLine(checks.find(check => check.id === id)!);
  assert.match(line('worker-sandbox'), /^FAIL worker-sandbox:.*not installed.*sudo apt install bubblewrap/);
  assert.match(line('landlock'), /^FAIL landlock:.*Landlock ABI 8.*Linux 7\.0.*fix: boot Linux 7\.0 or later.*Landlock ABI 9/);
  assert.match(line('control-plane'), /fix: run graphyard up/);
  assert.match(line('agent-environments'), /fix: run graphyard up.*Setup link/);
});

test('e2e:setup-failures-say-the-fix — prerequisites have README checks and source has no obsolete step references', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  for (const command of ['uname -r', 'node --version', 'npm --version', 'git --version', 'git remote -v', 'docker version', 'docker compose version', 'gh auth status', 'bwrap --version', 'python3 --version', 'herdr --version', 'systemctl --user status', 'graphyard doctor']) {
    assert.ok(readme.includes(command), `README is missing ${command}`);
  }
  assert.match(readme, /Linux 7\.0\+ with Landlock ABI 9\+/);
  const source = new URL('../src/', import.meta.url);
  for (const path of await readdir(source, { recursive: true })) {
    if (path.endsWith('.ts') || path.endsWith('.tsx')) assert.doesNotMatch(await readFile(new URL(path, source), 'utf8'), /README setup step/, path);
  }
});
