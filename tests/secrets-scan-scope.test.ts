import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// GY-435, 2026-09-25: the required 'secrets' check scanned every fetched branch (--log-opts=--all),
// so a fake API key in one branch's test fixture (GY-409) failed every pull request's check and
// stopped all merges. A ref is now scanned over its own history only, and a known false positive
// is recorded by fingerprint in .github/gitleaksignore.txt, which may name test files only.

test('unit:secrets-scan-pr-scoped: the secrets job scans HEAD with the ignore file, never every branch', async () => {
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  const scan = workflow.split('\n').find(line => /\.\/gitleaks git /.test(line));
  assert.ok(scan, 'the secrets job runs gitleaks');
  assert.doesNotMatch(scan!, /--log-opts=--all/, 'one branch\'s finding must not fail another branch\'s check');
  assert.match(scan!, /--log-opts=HEAD\b/);
  assert.match(scan!, /--gitleaks-ignore-path "\$GITHUB_WORKSPACE\/\.github\/gitleaksignore\.txt"/);
});

test('unit:gitleaksignore-test-fixtures-only: every ignored finding is a fake credential in a test file', async () => {
  const entries = (await readFile('.github/gitleaksignore.txt', 'utf8')).split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    const [commit, file, rule, line] = entry.split(':');
    assert.match(commit, /^[0-9a-f]{40}$/, `${entry}: a full commit hash`);
    assert.match(file, /(^|\/)(tests?|browser-tests)\/|\.(test|spec)\.[cm]?[jt]sx?$/, `${entry}: only test files may be ignored`);
    assert.doesNotMatch(file, /^(src|deploy|\.github|scripts)\//, `${entry}: never a source or config path`);
    assert.ok(rule && /^\d+$/.test(line), `${entry}: rule and line`);
  }
});
