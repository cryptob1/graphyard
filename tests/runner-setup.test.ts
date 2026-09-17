import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectRunnerRepository, snapshotRunnerSources } from '../src/runner-setup.js';
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-runner-setup-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
test('runner discovery does not execute candidate configuration or confuse filenames with inventory', async () => fixture(async root => {
  await writeFile(join(root, 'package.json'), JSON.stringify({ devDependencies: { '@playwright/test': '1.63.0' }, scripts: { pretest: 'exit 91' } }));
  await writeFile(join(root, 'package-lock.json'), '{}');
  await writeFile(join(root, 'playwright.config.ts'), 'throw new Error("must not import candidate code");');
  await writeFile(join(root, 'behavior.spec.ts'), 'throw new Error("not executed during discovery");');
  await mkdir(join(root, 'node_modules')); await writeFile(join(root, 'node_modules', 'fake.spec.ts'), '');
  const plan = await inspectRunnerRepository(root);
  assert.equal(plan.status, 'needs-approval'); assert.equal(plan.executionEnabled, false); assert.equal(plan.inventoryVerified, false);
  assert.deepEqual(plan.proposedFiles, ['behavior.spec.ts']); assert.equal(plan.blockers.length, 0);
}));
test('empty repositories describe missing inputs rather than invent coverage', async () => fixture(async root => {
  const plan = await inspectRunnerRepository(root);
  assert.equal(plan.status, 'needs-input'); assert.equal(plan.blockers.length, 4); assert.deepEqual(plan.proposedFiles, []);
}));
test('snapshot hashes exact selected bytes deterministically and changed helpers change its identity', async () => fixture(async root => {
  await writeFile(join(root, 'helper.ts'), 'export const expected = 1;'); await writeFile(join(root, 'test.spec.ts'), 'import "./helper";');
  const a = await snapshotRunnerSources(root, ['test.spec.ts', 'helper.ts']);
  const b = await snapshotRunnerSources(root, ['helper.ts', 'test.spec.ts']);
  assert.deepEqual(a, b); assert.equal(a.approved, false); assert.equal(a.executable, false);
  assert.equal(Buffer.from(a.files[0].bytes, 'base64').toString(), 'export const expected = 1;');
  await writeFile(join(root, 'helper.ts'), 'export const expected = 2;');
  assert.notEqual((await snapshotRunnerSources(root, ['helper.ts', 'test.spec.ts'])).digest, a.digest);
}));
test('snapshot rejects escape paths, secrets, duplicate files, leaf and parent symlinks', async () => fixture(async root => {
  await writeFile(join(root, 'safe.ts'), 'safe'); await mkdir(join(root, 'tests')); await writeFile(join(root, 'tests', 'x.ts'), 'x');
  await symlink(join(root, 'safe.ts'), join(root, 'alias.ts')); await symlink(join(root, 'tests'), join(root, 'linked'));
  for (const names of [['../outside'], ['/etc/passwd'], ['.env'], ['.graphyard/credentials.json'], ['private.pem'], ['safe.ts', 'safe.ts'], ['alias.ts'], ['linked/x.ts'], ['tests/../safe.ts'], []]) await assert.rejects(snapshotRunnerSources(root, names));
  const plan = await inspectRunnerRepository(root); assert.deepEqual(plan.omittedSymlinks, ['alias.ts', 'linked']);
}));
test('source reads are bounded, and invalid package metadata is reported without printing contents', async () => fixture(async root => {
  await writeFile(join(root, 'large.ts'), Buffer.alloc(20_000_001));
  await assert.rejects(snapshotRunnerSources(root, ['large.ts']), /bounded regular file/);
  await writeFile(join(root, 'package.json'), 'credential-value-not-for-logs');
  await assert.rejects(inspectRunnerRepository(root), error => error instanceof Error && error.message === 'Invalid package JSON: package.json');
}));
