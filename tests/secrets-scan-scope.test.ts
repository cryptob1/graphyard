import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gitleaksIgnorePath, gitleaksSha256, gitleaksVersion, secretScanArgv } from '../src/merge-writer/secret-scan.js';

// GY-2009: the merge writer's trial runs the pinned gitleaks scan; ignore entries stay test-only.

test('unit:secrets-scan-in-trial — the trial secret scan uses the pinned gitleaks and HEAD with the repo ignore file', () => {
  const argv = secretScanArgv('/workspace', 'gitleaks', true);
  assert.ok(argv.includes('git'));
  assert.ok(argv.includes('--redact'));
  assert.ok(argv.includes('--log-opts=HEAD'));
  assert.ok(argv.includes('--gitleaks-ignore-path'));
  assert.ok(argv.some(arg => arg.endsWith(gitleaksIgnorePath)));
  assert.match(gitleaksVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(gitleaksSha256.length, 64);
});

test('unit:gitleaksignore-test-fixtures-only: every ignored finding is a fake credential in a test file', async () => {
  const entries = (await readFile('.github/gitleaksignore.txt', 'utf8')).split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    // Fingerprint lines are sha:path:rule:line — the path must be under tests/.
    const path = entry.includes(':') ? entry.split(':').find(part => part.startsWith('tests/')) : entry;
    assert.ok(path && path.startsWith('tests/'), `ignore entry must name a test file: ${entry}`);
  }
});
