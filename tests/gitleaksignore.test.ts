import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// GY-435: the required 'secrets' check reads .github/gitleaksignore.txt, so the file may only ever
// carry fingerprints of fake fixtures in test files — never a src/ or configuration path, and
// never an allowlist for a real secret. One case per proof:
// unit:gitleaksignore-test-fixtures-only, unit:secrets-doc.

const FINGERPRINT = /^([0-9a-f]{40}):([^:\s]+):([A-Za-z0-9_-]+):(\d+)$/;

test('unit:gitleaksignore-test-fixtures-only — .github/gitleaksignore.txt exists, the secrets job passes it, and every fingerprint it holds names a test file, never a src/ or config path', async () => {
  const ignore = await readFile(new URL('../.github/gitleaksignore.txt', import.meta.url), 'utf8');
  const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

  assert.match(ci, /--gitleaks-ignore-path ("?\$GITHUB_WORKSPACE\/)?\.github\/gitleaksignore\.txt/, 'the secrets job passes the ignore file to gitleaks');
  const entries = ignore.split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const match = line.match(FINGERPRINT);
      assert.ok(match, `every line is a comment or a sha:file:rule:line fingerprint: ${line}`);
      return { line, file: match[2], rule: match[3], at: Number(match[4]) };
    });
  assert.ok(entries.length > 0, 'the ignore file lists at least one fingerprint');
  for (const entry of entries) {
    assert.match(entry.file, /^tests\//, `every fingerprint names a test file: ${entry.line}`);
    assert.doesNotMatch(entry.file, /^src\//, `no fingerprint names a src/ path: ${entry.line}`);
    assert.doesNotMatch(entry.file, /(^|\/)(package|tsconfig|vite\.config|playwright\.config)[^/]*$|\.github\//, `no fingerprint names a configuration path: ${entry.line}`);
  }
  assert.ok(entries.some(entry => entry.line === '31d6c0f2b6e173b2dfaaaf7ad473ceebe665de2a:tests/connect-account.test.ts:generic-api-key:25'), 'the GY-409 fake fixture is recorded');
  assert.match(ignore, /GY-409/);
  assert.match(ignore, /fake/i, 'the comment says the finding is a fake test fixture');
});

test('unit:secrets-doc — the docs tell a writer to make a credential-shaped fixture an obvious non-secret, or record its fingerprint in .github/gitleaksignore.txt, never an allowlist for a real secret', async () => {
  const onboarding = await readFile(new URL('../docs/onboarding.md', import.meta.url), 'utf8');
  assert.match(onboarding, /obvious non-secret, such as `test-key-not-real`/, 'the docs name an obvious non-secret shape for a fake fixture');
  assert.match(onboarding, /record its fingerprint in `\.github\/gitleaksignore\.txt`/, 'the docs give the ignore file as the escape hatch for a realistic fixture');
  assert.match(onboarding, /never an allowlist for a real secret/, 'the docs forbid using the ignore file for real secrets');
  assert.match(onboarding, /base's full history plus `base\.\.HEAD`/, 'the docs state the pull-request scan covers the base history plus base..HEAD');
});
