import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
// A namespace import: on a base without GY-1683 the cases fail, not the file's load.
import * as tmpReclaim from '../src/tmp-reclaim.js';
import { reclaimTmpDirectories, tmpReclaimMinAgeMs } from '../src/tmp-reclaim.js';
import { describeTmpClasses, readResources, readTmpInodes, type ResourceInputs } from '../src/master-resources.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1683: installs into checkouts under /tmp dragged pnpm's per-drive store onto the same tmpfs
// (/tmp/.pnpm-store, 52,699 inodes, unwritten since 26 September 2026) and Node's module compile
// cache added one directory per version (5,749 entries); the pass matched neither. It now ages this
// user's regular files under a same-volume store one by one past the store age bound, as it ages the
// tsx cache, and removes a node-compile-cache version directory whole once its newest write is older
// than the pass's cache age bound.

const hour = 3_600_000, day = 24 * hour;
const backdate = (path: string, ageMs: number, now = Date.now()) => utimes(path, new Date(now - ageMs), new Date(now - ageMs));
/** Backdate a whole tree, deepest entries first, so writing a child never refreshes its parent. */
async function backdateTree(path: string, ageMs: number, now = Date.now()) {
  for (const name of await readdir(path, { recursive: true })) await backdate(join(path, name), ageMs, now);
  await backdate(path, ageMs, now);
}
/** A pnpm v10 store: content-addressed files under `files/<2 hex>/` and an index beside them. */
async function store(tmp: string, files: Record<string, number>, now: number) {
  const root = join(tmp, '.pnpm-store', 'v10');
  await mkdir(join(root, 'files', 'ab'), { recursive: true }); await mkdir(join(root, 'index', 'cd'), { recursive: true });
  const paths: Record<string, string> = {};
  for (const [name, ageMs] of Object.entries(files)) {
    const path = join(root, name.startsWith('index/') ? name : join('files', 'ab', name));
    await writeFile(path, 'package bytes'); await backdate(path, ageMs, now);
    paths[name] = path;
  }
  await backdateTree(join(tmp, '.pnpm-store'), 20 * day, now);
  for (const [name, ageMs] of Object.entries(files)) await backdate(paths[name]!, ageMs, now);
  return { root: join(tmp, '.pnpm-store'), paths };
}
const blank = (overrides: Partial<ResourceInputs>): ResourceInputs => ({ now: Date.now(), reviews: [], producers: [], agents: [], work: [], plane: null, loop: null, revision: null, disk: null, tmp: null, profiles: { workers: [], reviewers: [], producers: [] }, ...overrides });

test('unit:pnpm-store-aged-file-sweep — the pass removes this user\'s regular files under a same-volume .pnpm-store older than the store age bound, oldest first within the per-cycle limit, keeps younger files and every directory, never follows a store that is a symlink, and leaves another user\'s store alone', async () => {
  assert.deepEqual(tmpReclaim.packageStoreNames, ['.pnpm-store']);
  assert.equal(tmpReclaim.packageStoreMinAgeMs, 7 * day, 'the store age bound is a week');
  const base = await temporaryDirectory('pnpm-store'), tmp = join(base, 'tmp');
  await mkdir(tmp);
  const now = Date.now();
  const { root, paths } = await store(tmp, { 'oldest-content': 15 * day, 'older-content': 12 * day, 'old-content': 8 * day, 'index/cd/old-index.json': 9 * day, 'fresh-content': 2 * day }, now);
  const report = await reclaimTmpDirectories({ tmpRoot: tmp, now, held: new Set() });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.removed.map(entry => entry.path), [paths['oldest-content'], paths['older-content'], paths['index/cd/old-index.json'], paths['old-content']], 'the week-old files go, oldest first');
  assert.equal(report.removed[0]!.bytes, 'package bytes'.length, 'the bytes freed are reported');
  assert.equal(existsSync(paths['fresh-content']!), true, 'a file inside the bound stays');
  for (const directory of [root, join(root, 'v10'), join(root, 'v10', 'files', 'ab'), join(root, 'v10', 'index', 'cd')]) assert.equal(existsSync(directory), true, `${directory} stays: pnpm refills it`);
  assert.deepEqual(report.classes, { testTemp: 0, tsxCache: 0, agentWorktree: 0, runtimeScratch: 0, packageStore: 4 }, 'the record counts the class once it took an entry');
  assert.equal(describeTmpClasses(report.classes!), '0 test temp, 0 tsx cache, 0 agent worktree, 0 runtime scratch, 4 pnpm store');
  assert.equal(describeTmpClasses({ testTemp: 1, tsxCache: 0, agentWorktree: 0, runtimeScratch: 0 }), '1 test temp, 0 tsx cache, 0 agent worktree, 0 runtime scratch', 'a record without the class reads as before');

  // The per-cycle limit bounds the store's share: of three old files, a pass limited to two takes the two oldest.
  const files = [1, 2, 3].map(index => join(root, 'v10', 'files', 'ab', `bounded-${index}`));
  for (const [index, path] of files.entries()) { await writeFile(path, 'x'); await backdate(path, 10 * day + (3 - index) * hour, now); }
  const bounded = await reclaimTmpDirectories({ tmpRoot: tmp, now, held: new Set(), limit: 2 });
  assert.deepEqual(bounded.removed.map(entry => entry.path), files.slice(0, 2));
  assert.equal(existsSync(files[2]!), true, 'the file past the limit is the next pass\'s');

  // A caller's own prefixes never sweep the store.
  const prefixed = await reclaimTmpDirectories({ tmpRoot: tmp, now, held: new Set(), prefixes: ['graphyard-'] });
  assert.deepEqual(prefixed.removed, []);
  assert.equal(existsSync(files[2]!), true);

  // Another user's store is theirs: with this user's uid elsewhere nothing goes.
  const getuid = process.getuid!, realUid = getuid();
  process.getuid = () => realUid + 1;
  let foreign;
  try { foreign = await reclaimTmpDirectories({ tmpRoot: tmp, now, held: new Set() }); } finally { process.getuid = getuid; }
  assert.deepEqual(foreign.removed, []);
  assert.equal(existsSync(files[2]!), true);

  // A store that is a symlink to a directory elsewhere is not followed: lstat sees no directory.
  const linked = join(base, 'tmp-linked'), elsewhere = join(base, 'elsewhere-store');
  await mkdir(linked); await mkdir(join(elsewhere, 'v10'), { recursive: true });
  const away = join(elsewhere, 'v10', 'content'); await writeFile(away, 'x'); await backdateTree(elsewhere, 20 * day, now);
  await symlink(elsewhere, join(linked, '.pnpm-store'));
  const viaLink = await reclaimTmpDirectories({ tmpRoot: linked, now, held: new Set() });
  assert.deepEqual(viaLink.removed, []);
  assert.equal(existsSync(away), true, 'a store reached only through a symlink stays');

  // A regular file bind-mounted into the store is another filesystem's inode, which the walk's
  // directory device check cannot see: the per-file rule refuses any file whose device is not the
  // store's own. No mount can be made in this sandbox, so the rule is checked on the stats it reads.
  const stats = (overrides: Partial<{ dev: number; uid: number; mtimeMs: number; file: boolean }> = {}) => ({ isFile: () => overrides.file ?? true, dev: overrides.dev ?? 7, uid: overrides.uid ?? realUid, mtimeMs: overrides.mtimeMs ?? now - 10 * day });
  assert.equal(tmpReclaim.agedFileSweepable(stats(), { dev: 7 }, realUid, now, 7 * day), true, 'this user\'s aged regular file on the store\'s device goes');
  assert.equal(tmpReclaim.agedFileSweepable(stats({ dev: 8 }), { dev: 7 }, realUid, now, 7 * day), false, 'a file on another device than its store stays, however old');
  assert.equal(tmpReclaim.agedFileSweepable(stats({ uid: realUid + 1 }), { dev: 7 }, realUid, now, 7 * day), false, 'another user\'s file stays');
  assert.equal(tmpReclaim.agedFileSweepable(stats({ mtimeMs: now - day }), { dev: 7 }, realUid, now, 7 * day), false, 'a file inside the bound stays');
  assert.equal(tmpReclaim.agedFileSweepable(stats({ file: false }), { dev: 7 }, realUid, now, 7 * day), false, 'only a regular file goes');
  assert.equal(tmpReclaim.agedFileSweepable(stats({ uid: realUid + 1 }), { dev: 7 }, undefined, now, 7 * day), true, 'without uids, age and device alone decide');

  // The tmp-inodes reading states the store bound.
  const reading = readResources(blank({ tmp: await readTmpInodes(await temporaryDirectory('pnpm-store-root'), tmp, async () => ({ files: 1_048_576, ffree: 400_000 })) })).find(entry => entry.id === 'tmp-inodes');
  assert.match(reading?.reclaim ?? '', /same-volume pnpm store \(\.pnpm-store\) older than 7 days/, 'the registry describes the store sweep');
  assert.match(reading?.reclaim ?? '', /node-compile-cache version directories/, 'the registry describes the compile cache sweep');
});

test('unit:pnpm-store-mounted-subtree-kept — a store directory or file the process\'s mount table names as a mount point is never entered or unlinked, although a bind mount from the same volume reports the store\'s own device, and a store whose mount table cannot be read ages nothing this pass, named in the record\'s errors', async () => {
  const base = await temporaryDirectory('pnpm-store-mounted'), tmp = join(base, 'tmp');
  await mkdir(tmp);
  const now = Date.now();
  const { root, paths } = await store(tmp, { 'plain-old': 15 * day, 'mounted-file': 14 * day, 'index/cd/old-index.json': 9 * day }, now);
  // A directory bind-mounted into the store from this volume: same device, listed in the table.
  const mountedDirectory = join(root, 'v10', 'files', 'ab'), indexDirectory = join(root, 'v10', 'index', 'cd');
  const mounted = await reclaimTmpDirectories({ tmpRoot: tmp, now, held: new Set(), mounts: [mountedDirectory] });
  assert.deepEqual(mounted.errors, []);
  assert.deepEqual(mounted.removed.map(entry => entry.path), [paths['index/cd/old-index.json']], 'only the file outside the mounted directory goes');
  for (const name of ['plain-old', 'mounted-file']) assert.equal(existsSync(paths[name]!), true, `${name} is under the mount and stays`);
  // A single file bind-mounted into the store: listed in the table, never unlinked, while its neighbour goes.
  await writeFile(paths['index/cd/old-index.json']!, 'package bytes'); await backdate(paths['index/cd/old-index.json']!, 9 * day, now); await backdate(indexDirectory, 20 * day, now);
  const file = await reclaimTmpDirectories({ tmpRoot: tmp, now, held: new Set(), mounts: [paths['mounted-file']!] });
  assert.deepEqual(file.errors, []);
  assert.deepEqual(file.removed.map(entry => entry.path), [paths['plain-old'], paths['index/cd/old-index.json']]);
  assert.equal(existsSync(paths['mounted-file']!), true, 'the mounted file stays');
  // A mount table that cannot be read: nothing of the store is aged, and the record says why.
  const unreadable = await reclaimTmpDirectories({ tmpRoot: tmp, now, held: new Set(), mounts: null });
  assert.deepEqual(unreadable.removed, []);
  assert.equal(existsSync(paths['mounted-file']!), true);
  assert.deepEqual(unreadable.errors, [`${root}: the mount table could not be read, so no file of it was aged this pass`]);
  // A store that is itself a mount point, bind-mounted from this volume, is another filesystem's: nothing of it is aged.
  const whole = await reclaimTmpDirectories({ tmpRoot: tmp, now, held: new Set(), mounts: [root] });
  assert.deepEqual(whole.removed, []);
  assert.deepEqual(whole.errors, []);
  // The live table, read by the pass itself, lists no mount inside a test directory: the file goes.
  const live = await reclaimTmpDirectories({ tmpRoot: tmp, now, held: new Set() });
  assert.deepEqual(live.removed.map(entry => entry.path), [paths['mounted-file']]);
});

test('unit:pnpm-store-held-files-kept — a store file a live process holds open stays whatever its age, and the rest of the aged files go', async () => {
  const base = await temporaryDirectory('pnpm-store-held'), tmp = join(base, 'tmp');
  await mkdir(tmp);
  const now = Date.now();
  const { paths } = await store(tmp, { 'held-content': 15 * day, 'free-content': 12 * day, 'fresh-content': day }, now);
  const report = await reclaimTmpDirectories({ tmpRoot: tmp, now, held: new Set([paths['held-content']!]) });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.removed.map(entry => entry.path), [paths['free-content']], 'the unheld aged file goes');
  assert.equal(existsSync(paths['held-content']!), true, 'a held store file stays');
  assert.equal(existsSync(paths['fresh-content']!), true);
  // Released, it goes on the next pass.
  const next = await reclaimTmpDirectories({ tmpRoot: tmp, now, held: new Set() });
  assert.deepEqual(next.removed.map(entry => entry.path), [paths['held-content']]);
});

test('unit:compile-cache-stale-versions-swept — a node-compile-cache version directory whose newest write is older than the cache age bound goes whole, one written inside the bound stays (though its own mtime is old), a held one stays, and the cache root is never removed', async () => {
  assert.equal(tmpReclaim.compileCacheName, 'node-compile-cache');
  const base = await temporaryDirectory('compile-cache'), tmp = join(base, 'tmp'), cache = join(tmp, 'node-compile-cache');
  await mkdir(cache, { recursive: true });
  const now = Date.now(), stale = tmpReclaimMinAgeMs + hour;
  const version = async (name: string) => { const path = join(cache, name); await mkdir(path); for (const file of ['a1', 'b2', 'c3']) await writeFile(join(path, file), 'compiled'); return path; };
  const oldest = await version('v24.8.0-abc'), older = await version('v22.19.0-def'), active = await version('v26.10.0-ghi'), held = await version('v25.1.0-jkl');
  await backdateTree(oldest, 3 * day, now); await backdateTree(older, stale, now); await backdateTree(held, stale, now);
  // The active version's directory is old, but Node wrote a cache file into it half an hour ago.
  await backdateTree(active, stale, now); await backdate(join(active, 'c3'), hour / 2, now);
  await backdate(cache, stale, now);
  const report = await reclaimTmpDirectories({ tmpRoot: tmp, now, held: new Set([join(held, 'a1')]) });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.removed.map(entry => entry.path), [oldest, older], 'the stale versions go whole, oldest first');
  assert.equal(report.removed[0]!.bytes, 3 * 'compiled'.length, 'a version\'s bytes are the files under it');
  for (const path of [cache, active, held]) assert.equal(existsSync(path), true, `${path} stays`);
  assert.equal(report.classes?.compileCache, 2);
  assert.equal(describeTmpClasses(report.classes!), '0 test temp, 0 tsx cache, 0 agent worktree, 0 runtime scratch, 2 compile cache');
  // Below headroom the escalated cache age applies: a version unwritten for over an hour goes at the first step.
  const recent = await version('v26.9.0-mno');
  await backdateTree(recent, 2 * hour, now);
  await backdate(cache, stale, now);
  let low = true;
  const escalated = await reclaimTmpDirectories({ tmpRoot: tmp, now, held: new Set([join(held, 'a1')]), volume: async () => ({ files: 1_048_576, ffree: low ? 1_000 : 900_000 }), escalation: [{ limit: 2_000, cacheAgeMs: hour, workMs: 5_000 }] });
  low = false;
  assert.deepEqual(escalated.removed.map(entry => entry.path), [recent], 'the escalated step\'s cache age reaches the version two hours quiet');
  assert.equal(existsSync(active), true, 'the version written half an hour ago stays');
  // The per-cycle limit holds: with three stale versions and a limit of one, one goes per pass.
  for (const name of ['v20.1.0-p', 'v20.2.0-q', 'v20.3.0-r']) await backdateTree(await version(name), 3 * day, now);
  await backdate(cache, stale, now);
  const bounded = await reclaimTmpDirectories({ tmpRoot: tmp, now, held: new Set(), limit: 1 });
  assert.equal(bounded.removed.length, 1);
  assert.ok(bounded.kept >= 2, 'the versions past the limit are counted as kept');
  // A version goes whole only once its tree is read to the end on the scanned root's own device: a
  // filesystem mounted anywhere inside it, directory or single file, keeps it. No mount can be made
  // in the sandbox, so the walk is judged against a device the tree is not on, which is what a mount
  // inside it is (review of 9c6cbd0fd7).
  const { dev } = await lstat(cache);
  assert.equal(await tmpReclaim.treeOnDevice(active, dev), true, 'a version on the scanned device may go whole');
  assert.equal(await tmpReclaim.treeOnDevice(active, dev + 1), false, 'an entry on another device anywhere in the tree keeps the whole version');
  // A same-volume bind mount keeps the device number: the mount table names it, and a version it reaches into stays, counted as kept (Codex review of 519dc64fff).
  assert.equal(await tmpReclaim.treeOnDevice(active, dev, [join(active, 'inner')]), false, 'a mount point inside the version keeps it whole');
  await backdateTree(active, 3 * day, now); await backdate(cache, stale, now);
  const mountedVersion = await reclaimTmpDirectories({ tmpRoot: tmp, now, held: new Set(), mounts: [join(active, 'inner')] });
  assert.equal(mountedVersion.removed.some(entry => entry.path === active), false, 'the version a mount reaches into is not removed');
  assert.equal(existsSync(active), true);
  assert.ok(mountedVersion.kept >= 1, 'it is counted as kept');
});

test('unit:compile-cache-unfinished-version-retried — a version whose removal fails partway is recorded as unfinished and is due at once on the next pass, although the half-finished removal left it looking freshly written', { skip: process.getuid?.() === 0 ? 'root ignores directory permissions' : false }, async () => {
  const base = await temporaryDirectory('compile-cache-unfinished'), tmp = join(base, 'tmp'), cache = join(tmp, 'node-compile-cache');
  const version = join(cache, 'v24.0.0-locked'), inner = join(version, 'inner');
  await mkdir(inner, { recursive: true });
  for (const file of ['a1', 'b2']) await writeFile(join(version, file), 'compiled');
  await writeFile(join(inner, 'c3'), 'compiled');
  const now = Date.now(), stale = tmpReclaimMinAgeMs + hour;
  await backdateTree(version, stale, now); await backdate(cache, stale, now);
  const unfinished = new Set<string>();
  // The inner directory refuses its file's unlinking: the removal fails partway through the version.
  await chmod(inner, 0o555);
  let first;
  try { first = await reclaimTmpDirectories({ tmpRoot: tmp, now, held: new Set(), unfinished, retryMs: 0 }); } finally { await chmod(inner, 0o755); }
  assert.deepEqual(first.removed, []);
  assert.equal(first.errors.length, 1, `the failed removal is reported (${first.errors.join('; ')})`);
  assert.deepEqual([...unfinished], [version], 'the version is recorded as unfinished');
  assert.equal(existsSync(join(inner, 'c3')), true);
  // Whatever the removal left of it, the version now looks written this instant.
  await utimes(version, new Date(now), new Date(now));
  const forgotten = await reclaimTmpDirectories({ tmpRoot: tmp, now, held: new Set(), unfinished: new Set(), retryMs: 0 });
  assert.deepEqual(forgotten.removed, [], 'a pass that had not recorded the failure would keep the young-looking version until the bound passes again');
  const second = await reclaimTmpDirectories({ tmpRoot: tmp, now, held: new Set(), unfinished, retryMs: 0 });
  assert.deepEqual(second.errors, []);
  assert.deepEqual(second.removed.map(entry => entry.path), [version], 'the next pass takes the unfinished version at once');
  assert.equal(existsSync(version), false);
  assert.equal(existsSync(cache), true, 'the cache root stays');
  assert.equal(unfinished.size, 0, 'a finished removal is no longer unfinished');
});
