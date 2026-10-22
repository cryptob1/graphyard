import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { freeBytes, readWorktreeInventoryCache, statusWorktreeInventory, worktreesDirectory, writeWorktreeInventoryCache } from '../src/master.js';
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

test('unit:master-status-unreadable-disk-unanswered — master status never answers a low disk reading from a drained pass when the worktrees directory is unreadable under a standing cache', async () => {
  const { execFileSync } = await import('node:child_process');
  const { masterConfigSchema } = await import('../src/master.js');
  const { emptyDaemonState, writeDaemonState } = await import('../src/master-daemon.js');
  const { masterStatusReport } = await import('../src/cli/master-status.js');
  const root = await temporaryDirectory('unreadable-status'), secrets = await temporaryDirectory('unreadable-status-secrets');
  execFileSync('git', ['init', '-q', root]);
  const credential = join(secrets, 'coordinator.token');
  await writeFile(credential, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  // A threshold half again the volume's free space, so the reading is low yet above the exhaustion floor; the loop's latest pass drained, now.
  const thresholdGb = Math.max(0.1, ((await freeBytes(root)) ?? 1e9) * 1.5 / 1e9);
  const master = masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:9', credentialFile: credential, cliPath: '/bin/true', repository: 'owner/project', baseBranch: 'main',
    githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], run: { worktreeRoot: join(secrets, 'checkouts'), diskThresholdGb: thresholdGb } });
  const state = emptyDaemonState(master);
  state.reclaim = { at: new Date().toISOString(), scanned: 0, trees: 0, treeBacklog: 0, removed: 0, kept: 0, freedBytes: 0, freeBytes: 1, errors: [], checkouts: 0, checkoutsOffVolume: 0, rootFreeBytes: null };
  await writeDaemonState(master, state);
  const status = async (path: string) => path.startsWith('work-snapshot') ? { work: [], now: new Date().toISOString() } : path === 'status' ? { actor: { id: 'coordinator-1', role: 'coordinator' } } : path === 'actions' ? { executors: undefined } : {};
  const read = () => masterStatusReport(root, master, status as never, { actor: { id: 'coordinator-1' } }, { commit: null });
  // A readable, empty directory under its drained cache: the reading is answered.
  await mkdir(worktreesDirectory(root), { recursive: true });
  await writeWorktreeInventoryCache(root, { at: new Date().toISOString(), entries: [], held: [] });
  const readable = await read();
  assert.equal(readable.disk.low, true);
  assert.equal(readable.disk.answered, true, 'a drained pass over a readable inventory answers a low reading');
  // The directory turns unreadable under the standing cache: nothing is known, so nothing is answered.
  await turnUnreadable(worktreesDirectory(root));
  const unreadable = await read();
  assert.equal(unreadable.disk.answered, false, 'an unreadable directory is not a drained plan');
  assert.equal(unreadable.disk.drained, false);
  assert.ok((unreadable as unknown as { attentionItems: { subject: string }[] }).attentionItems.some(item => item.subject === 'disk'), 'the low reading raises its attention');
});
