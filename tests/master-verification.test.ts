import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterConfigSchema } from '../src/master.js';
import { checkoutRelease, isolateRelease } from '../src/master-verification.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// The observed release's own checkout (GY-1732): the loop's post-deploy readings decide a parent's
// checks from an isolated clean checkout of exactly the serving commit, never the coordinator's.
// Per-item deployment verification is gone (GY-1981: done = merged).

const root = fileURLToPath(new URL('..', import.meta.url));
const nodeModules = fileURLToPath(import.meta.resolve('tsx')).replace(/\/node_modules\/.*$/, '/node_modules');

/** A clean checkout of this repository's HEAD. */
async function releaseCheckout() {
  const directory = await temporaryDirectory('release');
  const checkout = join(directory, 'graphyard');
  execFileSync('git', ['clone', '-q', '--shared', '--no-hardlinks', root, checkout]);
  await symlink(nodeModules, join(checkout, 'node_modules'), 'dir');
  const sha = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { directory, checkout, cliPath: join(checkout, 'bin/graphyard.mjs'), sha };
}

test('integration:release-checkout-identity — the checkout identity is read from the real CLI checkout', async () => {
  const release = await releaseCheckout();
  const outside = await temporaryDirectory('not-a-checkout');
  try {
    assert.deepEqual(checkoutRelease(release.cliPath), { sha: release.sha, clean: true, repository: null, reason: null }, 'a clone of a local path has no GitHub origin, so it is judged as the managed checkout');
    execFileSync('git', ['-C', release.checkout, 'remote', 'set-url', 'origin', 'git@github.com:Owner/Project.git']);
    assert.equal(checkoutRelease(release.cliPath).repository, 'Owner/Project');
    const missing = checkoutRelease(join(outside, 'bin/graphyard.mjs'));
    assert.equal(missing.sha, null); assert.equal(missing.clean, false); assert.ok(missing.reason);
  } finally { await rm(release.directory, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('integration:release-checkout-identity — a coordinator checkout ahead of production isolates a clean checkout of exactly the served release', async () => {
  const release = await releaseCheckout();
  const served = release.sha;
  const git = (...args: string[]) => execFileSync('git', ['-C', release.checkout, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  await writeFile(join(release.checkout, 'docs/master-agent.md'), '# Newer guide\n');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-am', 'newer than production');
  const ahead = git('rev-parse', 'HEAD');
  await writeFile(join(release.checkout, 'src/master.ts'), '// local edit\n', { flag: 'a' });
  const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/private/master.token', cliPath: release.cliPath, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'coordinator-host', masterAgentName: 'graphyard-master-project', run: {} });
  try {
    const isolated = await isolateRelease(master, served);
    assert.ok(!('reason' in isolated), 'reason' in isolated ? isolated.reason : '');
    if ('reason' in isolated) return;
    assert.equal(isolated.release.sha, served); assert.equal(isolated.release.clean, true);
    assert.ok(isolated.checks, 'the isolated release carries its own post-deploy filer');
    await isolated.dispose();
    assert.equal(git('rev-parse', 'HEAD'), ahead, 'the coordinator checkout is untouched');
    assert.match(git('status', '--porcelain', '--untracked-files=no'), /src\/master\.ts/);
    // Missing: production serves a commit the coordinator's store lacks.
    assert.deepEqual(await isolateRelease(master, 'e'.repeat(40)), { reason: `Deployed release ${'e'.repeat(40)} is missing from the coordinator checkout; fetch it and verify again` });
  } finally { await rm(release.directory, { recursive: true, force: true }); }
});
