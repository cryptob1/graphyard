import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, readlinkSync } from 'node:fs';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDeployCheckout } from '../src/cli/upgrade.js';
import { deployCheckoutOf } from '../src/install/loop-unit.js';
import { deploySourceCheck } from '../src/setup-from-zero.js';
import { defaultChildRun } from '../src/child-runner.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3350: hwd-backend's deploy checkout was a worktree of core's checkout, so cleaning core broke
// hwd-backend's deploy with "not a git repository". Each install's deploy source is its own clone.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

/** Another install's checkout with an origin and two commits. */
async function otherCheckout(root: string) {
  const other = join(root, 'core');
  await mkdir(other, { recursive: true });
  git(other, 'init', '-q', '-b', 'main');
  git(other, 'commit', '-q', '--allow-empty', '-m', 'first');
  git(other, 'remote', 'add', 'origin', 'https://example.invalid/graphyard.git');
  git(other, 'config', 'url./srv/graphyard.git.insteadOf', 'https://example.invalid/graphyard.git');
  return other;
}

test('a worktree deploy source is replaced by a standalone clone at the same commit, survives the other checkout, and doctor names it', async () => {
  const root = await temporaryDirectory('deploy-source');
  const other = await otherCheckout(root);
  const install = join(root, 'install'), checkout = deployCheckoutOf(install);
  await mkdir(join(checkout, '..'), { recursive: true });
  git(other, 'worktree', 'add', '-q', '--detach', checkout, 'HEAD');
  const commit = git(checkout, 'rev-parse', 'HEAD');
  git(other, 'commit', '-q', '--allow-empty', '-m', 'second'); // the other checkout moves on
  await mkdir(join(checkout, '.graphyard'));
  await symlink('/published-release', join(checkout, '.graphyard', 'cli-current'));

  const before = await deploySourceCheck(install);
  assert.equal(before?.status, 'fail');
  assert.match(before!.detail, /worktree of another checkout/);
  assert.match(before!.detail, new RegExp(checkout));

  await ensureDeployCheckout(checkout, other, defaultChildRun);
  assert.ok(lstatSync(join(checkout, '.git')).isDirectory(), 'the deploy source has its own .git directory');
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), commit, 'the clone is at the commit the worktree was at');
  assert.equal(git(checkout, 'config', '--get', 'remote.origin.url'), 'https://example.invalid/graphyard.git', 'origin stays the source\'s remote');
  assert.equal(git(checkout, 'remote', 'get-url', 'origin'), '/srv/graphyard.git', 'with its URL rewrite');
  assert.equal(readlinkSync(join(checkout, '.graphyard', 'cli-current')), '/published-release', 'the release pointer stays with the install');
  assert.equal((await deploySourceCheck(install))?.status, 'pass');

  await rm(other, { recursive: true, force: true });
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), commit, 'the deploy resolves its commit after the other checkout is deleted');
  assert.equal(git(checkout, 'status', '--porcelain', '--untracked-files=no'), '');
});

test('a fresh setup creates the deploy source as a standalone clone of the source HEAD', async () => {
  const root = await temporaryDirectory('deploy-source-fresh');
  const other = await otherCheckout(root);
  const install = join(root, 'install'), checkout = deployCheckoutOf(install);
  assert.equal(await deploySourceCheck(install), null, 'an install with no deploy source has no line');

  await ensureDeployCheckout(checkout, other, defaultChildRun);
  assert.ok(lstatSync(join(checkout, '.git')).isDirectory());
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), git(other, 'rev-parse', 'HEAD'));
  assert.equal(git(other, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 1, 'the source gains no worktree');
  assert.equal((await deploySourceCheck(install))?.status, 'pass');

  await rm(other, { recursive: true, force: true });
  assert.match(git(checkout, 'rev-parse', 'HEAD'), /^[0-9a-f]{40}$/);
});
