import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { blockedFeatures, controlPlanePermissions, describeShortfall, permissionShortfalls, permissionTable, requiredPermissions, reviewerPermissions } from '../src/github-permissions.js';
import { appManifest, reviewerAppManifest } from '../src/github-setup.js';

// unit:app-permissions-declaration
test('the control-plane declaration carries the merge queue\'s Contents: write and nothing beyond what a feature names', () => {
  const required = requiredPermissions(controlPlanePermissions);
  assert.deepEqual(required, { actions: 'write', administration: 'read', checks: 'write', contents: 'write', deployments: 'read', issues: 'read', metadata: 'read', pull_requests: 'write', workflows: 'write' });
  const queue = controlPlanePermissions.filter(requirement => requirement.feature === 'merge-queue');
  assert.deepEqual(queue.map(requirement => [requirement.permission, requirement.level]), [['contents', 'write']], 'the queue is the only reason for Contents: write');
  for (const requirement of controlPlanePermissions) assert.ok(requirement.reason.length > 10, `${requirement.permission} ${requirement.level} states why it is needed`);
});

test('the reviewer declaration never gains Contents: write, Checks, or Administration', () => {
  const required = requiredPermissions(reviewerPermissions);
  assert.deepEqual(required, { contents: 'read', issues: 'read', metadata: 'read', pull_requests: 'write' });
  assert.equal(reviewerPermissions.some(requirement => requirement.feature === 'merge-queue' || requirement.feature === 'check'), false, 'a reviewer neither lands the queue nor publishes the gate check');
});

test('shortfalls compare granted levels with the declaration, name the blocked features, and point at the installation page', () => {
  const legacy = { actions: 'write', administration: 'read', checks: 'write', contents: 'read', deployments: 'read', issues: 'read', metadata: 'read', pull_requests: 'write', workflows: 'write' };
  const missing = permissionShortfalls(legacy, controlPlanePermissions);
  assert.deepEqual(missing.map(shortfall => ({ permission: shortfall.permission, required: shortfall.required, granted: shortfall.granted, features: shortfall.features })),
    [{ permission: 'contents', required: 'write', granted: 'read', features: ['merge-queue'] }]);
  assert.deepEqual(blockedFeatures(missing), ['merge-queue']);
  const sentence = describeShortfall(missing[0], 'graphyard-owner-repo', 'https://github.com/settings/installations/42');
  assert.match(sentence, /^App graphyard-owner-repo lacks Contents: write \(installed with read\), which branch refresh needs to push base refreshes/);
  assert.match(sentence, /accept the pending permission request at https:\/\/github\.com\/settings\/installations\/42$/);
  // A permission that is absent altogether blocks every feature that names it, at the highest level asked.
  const bare = permissionShortfalls({ metadata: 'read' }, controlPlanePermissions);
  const contents = bare.find(shortfall => shortfall.permission === 'contents')!;
  assert.equal(contents.granted, null); assert.equal(contents.required, 'write'); assert.deepEqual(contents.features, ['observation', 'merge-queue']);
  assert.deepEqual(blockedFeatures(bare).sort(), ['check', 'check-rerun', 'comment-events', 'merge-queue', 'observation', 'production-watch', 'review-dispatch', 'workflow-sync']);
  // Write satisfies read; admin satisfies write; unknown or missing values satisfy nothing.
  assert.deepEqual(permissionShortfalls({ ...legacy, contents: 'admin' }, controlPlanePermissions), []);
  assert.equal(permissionShortfalls({ ...legacy, contents: 'write', checks: 'yes' }, controlPlanePermissions)[0].permission, 'checks');
  assert.equal(permissionShortfalls(null, controlPlanePermissions).length, Object.keys(requiredPermissions(controlPlanePermissions)).length);
});

// integration:app-permissions-manifest
test('the App manifests request exactly the declared sets, so the queue\'s Contents: write is requested and reviewers stay read-only', () => {
  const control = appManifest('owner/repo', 'https://example.com', 'http://127.0.0.1:4311');
  assert.deepEqual(control.default_permissions, requiredPermissions(controlPlanePermissions));
  assert.equal(control.default_permissions.contents, 'write');
  assert.equal(control.default_permissions.actions, 'write');
  const reviewer = reviewerAppManifest('claude', 'owner/repo', 'https://example.com', 'http://127.0.0.1:4311');
  assert.deepEqual(reviewer.default_permissions, requiredPermissions(reviewerPermissions));
  assert.equal(reviewer.default_permissions.contents, 'read');
  assert.equal('actions' in reviewer.default_permissions, false);
  assert.equal('checks' in reviewer.default_permissions, false); assert.equal('administration' in reviewer.default_permissions, false);
});

test('the setup guide carries the permission tables generated from the declaration, and explains why only the control plane writes', async () => {
  const guide = await readFile(new URL('../docs/github.md', import.meta.url), 'utf8');
  assert.ok(guide.includes(permissionTable(controlPlanePermissions)), 'docs/github.md must contain the control-plane table exactly as permissionTable() renders it');
  assert.ok(guide.includes(permissionTable(reviewerPermissions)), 'docs/github.md must contain the reviewer table exactly as permissionTable() renders it');
  assert.match(guide, /never granted Contents: write, Checks, or Administration/);
  assert.match(guide, /worker identities are not Apps at all/);
  assert.doesNotMatch(guide, /Contents remains read-only/, 'the pre-queue statement must not survive next to the declaration');
  const install = await readFile(new URL('../docs/install.md', import.meta.url), 'utf8');
  assert.match(install, /github-setup --update-permissions/);
  assert.match(install, /## Upgrading an existing installation/);
});


test('Actions write is diagnosed before attempting failed-job reruns', () => {
  for (const actions of [undefined, 'read']) {
    const missing = permissionShortfalls({ ...requiredPermissions(controlPlanePermissions), actions }, controlPlanePermissions);
    assert.equal(missing.length, 1);
    assert.equal(missing[0].permission, 'actions');
    assert.deepEqual(blockedFeatures(missing), ['check-rerun']);
    assert.match(describeShortfall(missing[0], 'control', 'https://github.com/settings/installations/42'), /lacks Actions: write.*rerun failed workflow jobs/);
  }
});

// unit:github-setup-rerun-permission
test('github-setup names Actions: write as the failed-rerun shortfall when the installation lacks it, and verifies it once held (GY-1328)', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { inspectAppPermissions } = await import('../src/github-setup.js');
  const root = await mkdtemp(join(tmpdir(), 'gy-1328-'));
  try {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await mkdir(join(root, '.graphyard'), { recursive: true });
    await writeFile(join(root, '.graphyard', 'github-app.json'), JSON.stringify({ appId: 123, slug: 'graphyard-owner-repo', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), webhookSecret: 'test-only', repository: 'owner/repo', installationId: 161493384 }), { mode: 0o600 });
    const full = requiredPermissions(controlPlanePermissions);
    let granted: Record<string, string> = { ...full, actions: 'read' };
    const fetcher = (async (url: unknown) => String(url) === 'https://api.github.com/app'
      ? new Response(JSON.stringify({ id: 123, slug: 'graphyard-owner-repo', owner: { login: 'owner', type: 'User' }, permissions: full }))
      : new Response(JSON.stringify({ id: 161493384, html_url: 'https://github.com/settings/installations/161493384', permissions: granted }))) as typeof fetch;
    for (const actions of ['read', undefined]) {
      granted = { ...full }; if (actions) granted.actions = actions; else delete granted.actions;
      const short = await inspectAppPermissions(root, { fetcher });
      assert.equal(short.verified, false);
      assert.deepEqual(short.appShortfalls, []);
      assert.deepEqual(short.installationShortfalls.map(entry => [entry.permission, entry.required, entry.granted, entry.features]), [['actions', 'write', actions ?? null, ['check-rerun']]]);
      assert.match(short.steps[0], /^Open https:\/\/github\.com\/settings\/installations\/161493384 and accept the pending permission request for Actions: write \(failed CI reruns\)\./);
      assert.match(short.steps[1], /github-setup --update-permissions/);
    }
    granted = { ...full };
    const held = await inspectAppPermissions(root, { fetcher });
    assert.equal(held.verified, true);
    assert.deepEqual(held.installationShortfalls, []); assert.deepEqual(held.steps, []);
    assert.equal(held.granted!.actions, 'write');
  } finally { await rm(root, { recursive: true, force: true }); }
});

// GY-1327: the GitHub-deployments provider reads /deployments with the control-plane App.
test('Deployments read is requested for production observation and a missing grant holds nothing else', () => {
  assert.deepEqual(controlPlanePermissions.filter(requirement => requirement.permission === 'deployments').map(requirement => [requirement.level, requirement.feature]), [['read', 'production-watch']]);
  const missing = permissionShortfalls({ ...requiredPermissions(controlPlanePermissions), deployments: undefined }, controlPlanePermissions);
  assert.deepEqual(missing.map(shortfall => shortfall.permission), ['deployments']);
  assert.deepEqual(blockedFeatures(missing), ['production-watch']);
  assert.match(describeShortfall(missing[0], 'control', 'https://github.com/settings/installations/42'), /^App control lacks Deployments: read, which production observation needs to read the deployments/);
});
