import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repositoryFromRemote, saveDiscovery } from '../src/onboarding.js';
import { appManifest, reviewerAppManifest, startGithubSetup } from '../src/github-setup.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

async function repository() { const root = await temporaryDirectory('setup'); execFileSync('git', ['init', '-q', root]); return root; }
test('discovery identifies GitHub without exposing embedded credentials and preserves repository instructions', async () => {
  assert.equal(repositoryFromRemote('https://test-only-password@github.com/owner/repo.git'), 'owner/repo');
  assert.equal(repositoryFromRemote('git@github.com:owner/repo.git'), 'owner/repo');
  for (const remote of ['ssh://git@GitHub.com/owner/repo.git', 'ssh://git@github.com/owner/repo.git', 'ssh://git@github.com:22/owner/repo.git', 'ssh://git@ssh.github.com:443/owner/repo.git', 'https://GitHub.com/owner/repo.git', 'https://github.com:443/owner/repo.git']) assert.equal(repositoryFromRemote(remote), 'owner/repo');
  for (const remote of ['https://github.com.attacker.test/owner/repo', 'ssh://git@github.com.attacker.test/owner/repo', 'https://github.com@attacker.test/owner/repo', 'ssh://git@github.com/owner/repo.git?other', 'file:///owner/repo']) assert.equal(repositoryFromRemote(remote), null);
  const root = await repository();
  try {
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:owner/repo.git'], { cwd: root });
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'example', typecheck: 'example' }, devDependencies: { vitest: '1' } }));
    const found = await saveDiscovery(root); assert.equal(found.repository, 'owner/repo'); assert.deepEqual(found.frameworks, ['vitest']);
    assert.equal(execFileSync('git', ['check-ignore', '.graphyard/project.json'], { cwd: root, encoding: 'utf8' }).trim(), '.graphyard/project.json');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('App setup binds callbacks, stores credentials privately, verifies installation, and resumes', async () => {
  const root = await repository(); let conversions = 0;
  const dependencies = {
    convert: async () => { conversions++; return { id: 123, slug: 'graphyard-example', pem: 'test-only-private-key', webhook_secret: 'test-only-webhook' }; },
    verify: async (_app: unknown, installation: number) => { if (installation !== 456) throw new Error('Wrong installation'); },
  };
  let setup = await startGithubSetup(root, 'owner/repo', 'https://example.com', 0, dependencies);
  const close = () => new Promise<void>(r => setup.http.close(() => r()));
  try {
    const page = await (await fetch(setup.url)).text(); const state = page.match(/state=([a-f0-9]+)/)![1];
    assert.equal((await fetch(`${setup.url}/created?code=example&state=wrong`)).status, 409); assert.equal(conversions, 0);
    const registered = await (await fetch(`${setup.url}/created?code=example&state=${state}`)).text();
    assert.match(registered, /Install GitHub App/); assert.doesNotMatch(registered, /test-only-private-key/);
    assert.equal((await stat(setup.file)).mode & 0o777, 0o600);
    assert.equal((await fetch(`${setup.url}/created?code=example&state=${state}`)).status, 409); assert.equal(conversions, 1);
    assert.equal((await fetch(`${setup.url}/installed?installation_id=999`)).status, 502);
    assert.equal(JSON.parse(await readFile(setup.file, 'utf8')).installationId, undefined);
    assert.match(await (await fetch(`${setup.url}/installed?installation_id=456`)).text(), /installation verified/);
    await close(); setup = await startGithubSetup(root, 'owner/repo', 'https://example.com', 0, dependencies);
    assert.match(await (await fetch(setup.url)).text(), /installation verified/); assert.equal(conversions, 1);
  } finally { await close(); await rm(root, { recursive: true, force: true }); }
});
test('App manifest refuses unsafe deployment URLs and requests the declared control-plane set', () => {
  for (const url of ['http://example.com', 'https://user:password@example.com', 'https://example.com/private']) assert.throws(() => appManifest('owner/repo', url, 'http://127.0.0.1:4311'));
  const manifest = appManifest('owner/repo', 'https://example.com', 'http://127.0.0.1:4311');
  // The merge queue publishes merge commits and queue refs, which is the declared reason for Contents: write.
  assert.equal(manifest.default_permissions.contents, 'write'); assert.equal(manifest.public, false);
  assert.equal(manifest.hook_attributes.url, 'https://example.com/api/github/webhook');
});

test('reviewer App manifest registers an independent identity without control-plane authority', async () => {
  for (const url of ['http://example.com', 'https://user:password@example.com', 'https://example.com/private']) assert.throws(() => reviewerAppManifest('claude', 'owner/repo', url, 'http://127.0.0.1:4311'));
  assert.throws(() => reviewerAppManifest('Claude Reviewer', 'owner/repo', 'https://example.com', 'http://127.0.0.1:4311'), /lowercase identifier/);
  assert.throws(() => reviewerAppManifest('claude-cloud-reviewer', 'owner/long-repository-name', 'https://example.com', 'http://127.0.0.1:4311'), /34 characters/);
  const manifest = reviewerAppManifest('claude', 'owner/repo', 'https://example.com', 'http://127.0.0.1:4311');
  assert.equal(manifest.name, 'owner-repo review claude'); assert.equal(manifest.public, false);
  assert.equal(manifest.default_permissions.contents, 'read'); assert.equal(manifest.default_permissions.pull_requests, 'write');
  // A reviewer can never publish Graphyard's gate check or read repository administration.
  assert.equal('checks' in manifest.default_permissions, false);
  assert.equal('administration' in manifest.default_permissions, false);
  assert.equal('hook_attributes' in manifest, false);
});

test('reviewer setup resolves the bot identity and prints the registry entry, never the key', async () => {
  const root = await repository();
  const dependencies = {
    convert: async () => ({ id: 55_001, slug: 'owner-repo-review-claude', pem: 'test-only-private-key' }),
    verify: async (_app: unknown, installation: number) => { if (installation !== 456) throw new Error('Wrong installation'); },
    resolveBot: async (slug: string) => ({ id: slug === 'owner-repo-review-claude' ? 55_002 : 0, type: 'Bot' }),
  };
  let setup = await startGithubSetup(root, 'owner/repo', 'https://example.com', 0, dependencies, 'claude');
  const close = () => new Promise<void>(r => setup.http.close(() => r()));
  try {
    assert.match(setup.file, /github-reviewer-claude\.json$/);
    const page = await (await fetch(setup.url)).text();
    assert.match(page, /reviewer App/); assert.doesNotMatch(page, /webhook/);
    const state = page.match(/state=([a-f0-9]+)/)![1];
    assert.match(await (await fetch(`${setup.url}/created?code=example&state=${state}`)).text(), /Install GitHub App/);
    assert.equal((await stat(setup.file)).mode & 0o777, 0o600);
    const registered = await (await fetch(`${setup.url}/installed?installation_id=456`)).text();
    assert.match(registered, /GRAPHYARD_REVIEWER_APPS/);
    assert.match(registered, /&quot;appId&quot;: 55001/); assert.match(registered, /&quot;botUserId&quot;: 55002/);
    assert.doesNotMatch(registered, /test-only-private-key/);
    const saved = JSON.parse(await readFile(setup.file, 'utf8'));
    assert.equal(saved.botUserId, 55_002); assert.equal(saved.reviewer, 'claude'); assert.equal(saved.installationId, 456);
    // A saved credential is never adopted under another Graphyard role or reviewer name.
    await close();
    await writeFile(join(root, '.graphyard', 'github-reviewer-other.json'), JSON.stringify({ ...saved, reviewer: 'claude' }), { mode: 0o600 });
    await assert.rejects(startGithubSetup(root, 'owner/repo', 'https://example.com', 0, dependencies, 'other'), /different Graphyard role/);
    await writeFile(join(root, '.graphyard', 'github-reviewer-plain.json'), JSON.stringify({ ...saved, reviewer: undefined }), { mode: 0o600 });
    await assert.rejects(startGithubSetup(root, 'owner/repo', 'https://example.com', 0, dependencies, 'plain'), /different Graphyard role/);
    setup = await startGithubSetup(root, 'owner/repo', 'https://example.com', 0, dependencies, 'claude');
    assert.match(await (await fetch(setup.url)).text(), /GRAPHYARD_REVIEWER_APPS/);
  } finally { await close(); await rm(root, { recursive: true, force: true }); }
});

// integration:app-permissions-migration
test('the permission migration reads the App and its installation back, prints the exact remaining steps, and verifies acceptance', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { inspectAppPermissions, updateAppPermissions } = await import('../src/github-setup.js');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const root = await repository();
  try {
    await assert.rejects(inspectAppPermissions(root), /register it first with graphyard github-setup HTTPS_URL/);
    const { mkdir: makeDirectory } = await import('node:fs/promises');
    await makeDirectory(join(root, '.graphyard'), { recursive: true });
    await writeFile(join(root, '.graphyard', 'github-app.json'), JSON.stringify({ appId: 123, slug: 'graphyard-owner-repo', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), webhookSecret: 'test-only', repository: 'owner/repo', installationId: 456 }), { mode: 0o600 });
    const legacy = { administration: 'read', checks: 'write', contents: 'read', issues: 'read', metadata: 'read', pull_requests: 'write' };
    let registered: Record<string, string> = { ...legacy }, granted: Record<string, string> = { ...legacy };
    const requests: string[] = [];
    const fetcher = (async (url: unknown, options: any) => {
      requests.push(String(url));
      assert.match(options.headers.Authorization, /^Bearer eyJ/, 'App endpoints are read with the App JWT');
      if (String(url) === 'https://api.github.com/app') return new Response(JSON.stringify({ id: 123, slug: 'graphyard-owner-repo', owner: { login: 'owner', type: 'User' }, permissions: registered }));
      if (String(url) === 'https://api.github.com/app/installations/456') return new Response(JSON.stringify({ id: 456, app_slug: 'graphyard-owner-repo', html_url: 'https://github.com/settings/installations/456', permissions: granted }));
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    // Step 1: the App itself still declares Contents: read. Both browser steps remain.
    const before = await inspectAppPermissions(root, { fetcher });
    assert.equal(before.verified, false); assert.equal(before.role, 'control-plane');
    assert.deepEqual(before.appShortfalls.map(s => [s.permission, s.required]), [['contents', 'write']]);
    assert.deepEqual(before.installationShortfalls.map(s => [s.permission, s.required]), [['contents', 'write']]);
    assert.equal(before.settingsUrl, 'https://github.com/settings/apps/graphyard-owner-repo/permissions');
    assert.equal(before.installationUrl, 'https://github.com/settings/installations/456');
    assert.match(before.steps[0], /^Open https:\/\/github\.com\/settings\/apps\/graphyard-owner-repo\/permissions, set Contents: write under Repository permissions, and save\. GitHub has no API/);
    assert.match(before.steps[1], /^Open https:\/\/github\.com\/settings\/installations\/456 and accept the pending permission request for Contents: write/);
    assert.match(before.steps[2], /github-setup --update-permissions/);
    assert.equal(before.steps.length, 3);
    // Step 2: the App was updated in the browser; only the installation's acceptance remains.
    registered = { ...legacy, contents: 'write' };
    const pending = await inspectAppPermissions(root, { fetcher });
    assert.deepEqual(pending.appShortfalls, []); assert.equal(pending.installationShortfalls.length, 1); assert.equal(pending.verified, false);
    assert.match(pending.steps[0], /^Open https:\/\/github\.com\/settings\/installations\/456 and accept/); assert.equal(pending.steps.length, 2);
    // --wait polls until the installation reports the permission, announcing the steps once.
    const announcements: string[] = []; let polls = 0;
    const result = await updateAppPermissions(root, { fetcher, waitMs: 60_000, pollMs: 1, announce: message => announcements.push(message), wait: async () => { if (++polls === 2) granted = { ...legacy, contents: 'write' }; } });
    assert.equal(result.verified, true); assert.equal(result.waited, false); assert.equal(polls, 2);
    assert.equal(announcements.length, 1); assert.match(announcements[0], /^1\. Open https:\/\/github\.com\/settings\/installations\/456 and accept/);
    assert.deepEqual(result.granted, { ...legacy, contents: 'write' }); assert.deepEqual(result.excess, []);
    // Without --wait an unaccepted request is reported, not waited for.
    granted = { ...legacy };
    const reported = await updateAppPermissions(root, { fetcher, announce: () => {} });
    assert.equal(reported.verified, false); assert.equal(reported.waited, false);
    // Organization-owned Apps get the organization settings page; a rejected key is explained.
    const organization = (async (url: unknown) => String(url) === 'https://api.github.com/app'
      ? new Response(JSON.stringify({ id: 123, slug: 'graphyard-owner-repo', owner: { login: 'acme', type: 'Organization' }, permissions: registered }))
      : new Response(JSON.stringify({ id: 456, html_url: 'https://github.com/organizations/acme/settings/installations/456', permissions: granted }))) as typeof fetch;
    const owned = await inspectAppPermissions(root, { fetcher: organization });
    assert.equal(owned.settingsUrl, 'https://github.com/organizations/acme/settings/apps/graphyard-owner-repo/permissions');
    assert.equal(owned.installationUrl, 'https://github.com/organizations/acme/settings/installations/456');
    await assert.rejects(inspectAppPermissions(root, { fetcher: (async () => new Response('{}', { status: 401 })) as typeof fetch }), /failed \(401\); the saved App key was rejected/);
    assert.ok(requests.every(url => url.startsWith('https://api.github.com/app')), 'the migration reads App-level endpoints only');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('a reviewer App is inspected against its own declaration and an excess Contents: write is a step to reduce, never accepted', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { inspectAppPermissions } = await import('../src/github-setup.js');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const root = await repository();
  try {
    const { mkdir: makeDirectory } = await import('node:fs/promises');
    await makeDirectory(join(root, '.graphyard'), { recursive: true });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    await writeFile(join(root, '.graphyard', 'github-reviewer-claude.json'), JSON.stringify({ appId: 55_001, slug: 'owner-repo-review-claude', privateKey: pem, webhookSecret: '', repository: 'owner/repo', installationId: 789, reviewer: 'claude', botUserId: 55_002 }), { mode: 0o600 });
    let granted: Record<string, string> = { contents: 'write', issues: 'read', metadata: 'read', pull_requests: 'write', checks: 'write' };
    const fetcher = (async (url: unknown) => String(url) === 'https://api.github.com/app'
      ? new Response(JSON.stringify({ id: 55_001, slug: 'owner-repo-review-claude', owner: { login: 'owner', type: 'User' }, permissions: granted }))
      : new Response(JSON.stringify({ id: 789, html_url: 'https://github.com/settings/installations/789', permissions: granted }))) as typeof fetch;
    const widened = await inspectAppPermissions(root, { reviewer: 'claude', fetcher });
    assert.equal(widened.role, 'reviewer'); assert.equal(widened.verified, false);
    assert.deepEqual(widened.appShortfalls, []); assert.deepEqual(widened.installationShortfalls, []);
    assert.deepEqual(widened.excess, [{ permission: 'checks', granted: 'write', declared: null }, { permission: 'contents', granted: 'write', declared: 'read' }]);
    assert.match(widened.steps[0], /^Reduce Checks: write, Contents: write at https:\/\/github\.com\/settings\/apps\/owner-repo-review-claude\/permissions: a reviewer App must never hold more than its declaration, and never Contents: write\./);
    granted = { contents: 'read', issues: 'read', metadata: 'read', pull_requests: 'write' };
    const exact = await inspectAppPermissions(root, { reviewer: 'claude', fetcher });
    assert.equal(exact.verified, true); assert.deepEqual(exact.steps, []);
    // The control-plane credential file is never inspected under a reviewer role, or vice versa.
    await assert.rejects(inspectAppPermissions(root, { fetcher }), /No saved Graphyard App/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
