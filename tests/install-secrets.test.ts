import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertOutsideRepository, ensureTokens, fingerprint, generateToken, installDirectory, plannedPrincipals, prepareInstallDirectory, principalsVariable, readInstallRecord, tokenFile, workerPrincipals, writeInstallRecord, Vault } from '../src/install/secrets.js';
import { principalSchema } from '../src/server.js';
import { REDACTED } from '../src/install/types.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

async function scratch() { return temporaryDirectory('secrets'); }

test('every principal token is crypto-random, role-scoped, and at least 32 characters', async () => {
  const tokens = new Set(Array.from({ length: 200 }, () => generateToken()));
  assert.equal(tokens.size, 200);
  for (const token of tokens) { assert.ok(token.length >= 32); assert.match(token, /^[A-Za-z0-9_-]+$/); }

  const principals = plannedPrincipals('owner-project', { workers: 3, producerProofs: ['integration:claim-safety', 'integration:claim-safety'] });
  assert.deepEqual(principals.map(principal => principal.role), ['admin', 'coordinator', 'worker', 'worker', 'worker', 'reader', 'producer']);
  assert.equal(new Set(principals.map(principal => principal.id)).size, principals.length);
  // A producer is lane-scoped: it exists only with an explicit, de-duplicated proof grant.
  assert.deepEqual(principals.at(-1)!.proofs, ['integration:claim-safety']);
  assert.ok(!plannedPrincipals('owner-project').some(principal => principal.role === 'producer'));
  assert.equal(workerPrincipals(principals).length, 3);
});

test('tokens are written once under the installation directory with mode 0600 and never rotate on re-apply', async () => {
  const home = await scratch();
  try {
    const directory = installDirectory('owner-project', home);
    await prepareInstallDirectory(directory, null);
    const principals = plannedPrincipals('owner-project', { workers: 2 });
    const vault = new Vault();
    const first = await ensureTokens(directory, principals, vault);
    assert.equal(first.size, principals.length);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    for (const principal of principals) assert.equal((await stat(tokenFile(directory, principal.id))).mode & 0o777, 0o600);
    const second = await ensureTokens(directory, principals, new Vault());
    for (const principal of principals) assert.equal(second.get(principal.id), first.get(principal.id));
    // One credential per principal: no two roles ever share a value.
    assert.equal(new Set(first.values()).size, principals.length);
    assert.deepEqual((await readdir(join(directory, 'tokens'))).sort(), principals.map(principal => `${principal.id}.token`).sort());
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('GRAPHYARD_PRINCIPALS matches the server principal schema and carries each role exactly once', async () => {
  const home = await scratch();
  try {
    const directory = installDirectory('owner-project', home);
    await prepareInstallDirectory(directory, null);
    const principals = plannedPrincipals('owner-project', { workers: 2, producerProofs: ['integration:install-apply-adapters'] });
    const tokens = await ensureTokens(directory, principals, new Vault());
    const parsed = principalSchema.parse(JSON.parse(principalsVariable(principals, tokens)));
    assert.equal(parsed.length, principals.length);
    assert.equal(parsed.filter(principal => principal.role === 'admin').length, 1);
    assert.equal(parsed.filter(principal => principal.role === 'coordinator').length, 1);
    assert.deepEqual(parsed.find(principal => principal.role === 'producer')!.proofs, ['integration:install-apply-adapters']);
    // Worker credentials are never any other role's credential.
    const workerTokens = parsed.filter(principal => principal.role === 'worker').map(principal => principal.token);
    const privileged = parsed.filter(principal => ['admin', 'coordinator', 'producer'].includes(principal.role)).map(principal => principal.token);
    for (const token of workerTokens) assert.ok(!privileged.includes(token));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('the vault redacts every generated secret and refuses to emit one', () => {
  const vault = new Vault();
  const token = vault.add(generateToken());
  const key = vault.add('-----BEGIN PRIVATE KEY-----\nabcdefghijklmnop\n-----END PRIVATE KEY-----');
  assert.equal(vault.scrub(`Bearer ${token}`), `Bearer ${REDACTED}`);
  assert.deepEqual(vault.scrub({ nested: [{ value: token }] }), { nested: [{ value: REDACTED }] });
  assert.ok(vault.exposes(`the key is ${key}`));
  assert.throws(() => vault.assertClean(`GRAPHYARD_PRINCIPALS=${token}`, 'the plan'), /Refusing to emit the plan/);
  assert.equal(vault.assertClean('nothing sensitive here', 'the plan'), 'nothing sensitive here');
  // A short value is not treated as a secret, so ordinary text is never over-redacted.
  vault.add('ab'); assert.equal(vault.scrub('ab cd'), 'ab cd');
  assert.equal(fingerprint(token).length, 12);
  assert.notEqual(fingerprint(token), fingerprint(`${token}x`));
});

test('the installation record round-trips without credentials and refuses a directory inside the repository', async () => {
  const home = await scratch();
  const root = await scratch();
  try {
    execFileSync('git', ['init', '-q', root]);
    await writeFile(join(root, 'package.json'), '{}');
    assert.throws(() => assertOutsideRepository(resolve(root, '.graphyard/install'), root), /inside the managed repository/);
    assert.throws(() => assertOutsideRepository(resolve(root), root), /inside the managed repository/);
    assertOutsideRepository(installDirectory('owner-project', home), root);

    const directory = installDirectory('owner-project', home);
    await prepareInstallDirectory(directory, root);
    const vault = new Vault();
    const principals = plannedPrincipals('owner-project');
    const tokens = await ensureTokens(directory, principals, vault);
    const now = new Date().toISOString();
    await writeInstallRecord(directory, {
      version: 1, installId: 'owner-project', repository: 'owner/project', provider: 'railway', baseBranch: 'main',
      reviewPolicy: 'github', domain: null, url: 'https://example.test',
      principals: principals.map(principal => ({ id: principal.id, role: principal.role, fingerprint: fingerprint(tokens.get(principal.id)!) })),
      github: null, reviewers: [], profiles: [], createdAt: now, updatedAt: now,
    }, vault);
    const record = await readInstallRecord(directory);
    assert.equal(record?.repository, 'owner/project');
    const raw = await readFile(join(directory, 'install.json'), 'utf8');
    for (const token of tokens.values()) assert.ok(!raw.includes(token));
    assert.equal((await stat(join(directory, 'install.json'))).mode & 0o777, 0o600);
    assert.equal(await readInstallRecord(join(directory, 'missing')), null);
  } finally { await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
});
