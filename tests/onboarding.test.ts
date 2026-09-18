import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repositoryFromRemote, saveDiscovery } from '../src/onboarding.js';
import { appManifest, reviewerAppManifest, startGithubSetup } from '../src/github-setup.js';

async function repository() { const root = await mkdtemp(join(tmpdir(), 'graphyard-setup-')); execFileSync('git', ['init', '-q', root]); return root; }
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
test('App manifest refuses unsafe deployment URLs and requests no code or merge write permission', () => {
  for (const url of ['http://example.com', 'https://user:password@example.com', 'https://example.com/private']) assert.throws(() => appManifest('owner/repo', url, 'http://127.0.0.1:4311'));
  const manifest = appManifest('owner/repo', 'https://example.com', 'http://127.0.0.1:4311');
  assert.equal(manifest.default_permissions.contents, 'read'); assert.equal(manifest.public, false);
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
