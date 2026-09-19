import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { blockedFeatures, controlPlanePermissions, describeShortfall, permissionShortfalls, permissionTable, requiredPermissions, reviewerPermissions } from '../src/github-permissions.js';
import { appManifest, reviewerAppManifest } from '../src/github-setup.js';

// unit:app-permissions-declaration
test('the control-plane declaration carries the merge queue\'s Contents: write and nothing beyond what a feature names', () => {
  const required = requiredPermissions(controlPlanePermissions);
  assert.deepEqual(required, { administration: 'read', checks: 'write', contents: 'write', issues: 'read', metadata: 'read', pull_requests: 'write' });
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
  const legacy = { administration: 'read', checks: 'write', contents: 'read', issues: 'read', metadata: 'read', pull_requests: 'write' };
  const missing = permissionShortfalls(legacy, controlPlanePermissions);
  assert.deepEqual(missing.map(shortfall => ({ permission: shortfall.permission, required: shortfall.required, granted: shortfall.granted, features: shortfall.features })),
    [{ permission: 'contents', required: 'write', granted: 'read', features: ['merge-queue'] }]);
  assert.deepEqual(blockedFeatures(missing), ['merge-queue']);
  const sentence = describeShortfall(missing[0], 'graphyard-owner-repo', 'https://github.com/settings/installations/42');
  assert.match(sentence, /^App graphyard-owner-repo lacks Contents: write \(installed with read\), which the merge queue needs to publish speculative merge-queue tips/);
  assert.match(sentence, /accept the pending permission request at https:\/\/github\.com\/settings\/installations\/42$/);
  // A permission that is absent altogether blocks every feature that names it, at the highest level asked.
  const bare = permissionShortfalls({ metadata: 'read' }, controlPlanePermissions);
  const contents = bare.find(shortfall => shortfall.permission === 'contents')!;
  assert.equal(contents.granted, null); assert.equal(contents.required, 'write'); assert.deepEqual(contents.features, ['observation', 'merge-queue']);
  assert.deepEqual(blockedFeatures(bare).sort(), ['check', 'comment-events', 'merge-queue', 'observation', 'review-dispatch']);
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
  const reviewer = reviewerAppManifest('claude', 'owner/repo', 'https://example.com', 'http://127.0.0.1:4311');
  assert.deepEqual(reviewer.default_permissions, requiredPermissions(reviewerPermissions));
  assert.equal(reviewer.default_permissions.contents, 'read');
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
