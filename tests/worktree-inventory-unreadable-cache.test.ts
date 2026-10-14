import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readWorktreeInventoryCache, statusWorktreeInventory, worktreesDirectory, writeWorktreeInventoryCache } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1793: the inventory cache the loop's reclaim step keeps answered `master status` whatever the
// directory had become since: a drained pass wrote an empty cache, and the unreadable answer only
// ran when no cache stood, so a worktrees directory that turned unreadable afterwards read as
// nothing disposable and quietly held the warn-line fault down for as long as the cache did.
// statusWorktreeInventory now asks the directory before it trusts the cache: unreadable wins over
// a cache of any age, a readable directory answers from the cache unchanged, and the unreadable
// answer never writes over the last real inventory the cache holds.

/** A root whose worktrees directory holds one assignment tree with an install, so the inventory is never trivially empty. */
async function host() {
  const root = await temporaryDirectory('unreadable-cache');
  await mkdir(join(worktreesDirectory(root), 'GY-9-1', 'node_modules', 'pg'), { recursive: true });
  return root;
}
/** The worktrees directory turned into a file: it exists, and reading it fails with something other than ENOENT. */
async function turnUnreadable(base: string) {
  await rm(base, { recursive: true, force: true });
  await writeFile(base, 'a file where the directory was');
}

test('unit:worktree-inventory-unreadable-before-cache — a directory unreadable under a standing cache reads as unknown, never as the cached reading', async () => {
  const root = await host(), base = worktreesDirectory(root);
  const walked = await statusWorktreeInventory(root);
  assert.equal(walked.cached, false);
  assert.equal(walked.entries.length, 1);
  assert.equal(walked.unreadable, undefined, 'a readable directory is not reported unreadable');
  // The pass wrote the cache; with the directory still readable the next call answers from it.
  const cached = await statusWorktreeInventory(root);
  assert.equal(cached.cached, true);
  assert.deepEqual(cached.entries, walked.entries);
  // The directory turns unreadable while that cache stands: the answer is the unknown one, the
  // one a host with no cache gets, not the cache's.
  await turnUnreadable(base);
  const answered = await statusWorktreeInventory(root);
  assert.equal(answered.unreadable, true, 'the unreadable directory is reported with a cache standing too');
  assert.equal(answered.cached, false);
  assert.equal(answered.entries.length, 0, 'the cached reading is not returned for a directory nobody can read');
  // The unreadable answer keeps the cache's last real inventory for the day readability returns.
  assert.equal((await readWorktreeInventoryCache(root))?.entries.length, 1);
});

test('unit:worktree-inventory-readable-cache-unchanged — a readable directory answers from the cache unchanged, held trees with it', async () => {
  const root = await host(), base = worktreesDirectory(root);
  await statusWorktreeInventory(root);
  const cache = await readWorktreeInventoryCache(root);
  assert.ok(cache, 'the readable walk left the cache behind');
  const held = [{ path: join(base, 'GY-9-1'), activityAt: cache.entries[0].activityAt, reason: 'Uncommitted changes' }];
  await writeWorktreeInventoryCache(root, { at: cache.at, entries: cache.entries, held });
  const status = await statusWorktreeInventory(root);
  assert.equal(status.cached, true);
  assert.equal(status.at, cache.at);
  assert.deepEqual(status.entries, cache.entries);
  assert.deepEqual(status.held, held);
  assert.equal(status.unreadable, undefined);
});
