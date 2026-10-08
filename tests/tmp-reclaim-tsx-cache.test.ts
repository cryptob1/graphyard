import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { lstat, mkdir, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { reclaimTmpDirectories, tmpReclaimMinAgeMs } from '../src/tmp-reclaim.js';
import { readResources, readTmpInodes, type ResourceInputs } from '../src/master-resources.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1512: test runs write content-hashed compile files into this user's tsx cache (`tsx-<uid>`)
// all day, so the directory is never old enough for the pass to take whole: on 8 October 2026
// /tmp/tsx-1000 held 89,896 entries and the master cleared it by hand. The pass ages the cache's
// files one by one instead, and the tmp-inodes reading names the cache among this user's entries.

const backdate = (path: string, ageMs: number, now = Date.now()) => utimes(path, new Date(now - ageMs), new Date(now - ageMs));
/** This user's tsx cache name, spelled here so the file loads on a base without the change and fails there as test cases. */
const ownCache = () => { const uid = process.getuid?.(); return uid === undefined ? null : `tsx-${uid}`; };

test('unit:tmp-reclaim-tsx-cache — the pass removes old regular files under this user\'s tsx cache, keeps fresh files, sockets and directories, and stays within its per-cycle limit', { skip: ownCache() === null ? 'no uids on this platform' : false }, async () => {
  const tmp = await temporaryDirectory('tsx-cache-reclaim');
  const cache = join(tmp, ownCache()!), nested = join(cache, 'nested');
  await mkdir(nested, { recursive: true });
  const old = join(cache, '17914-old'), fresh = join(cache, '17914-fresh'), socket = join(cache, '1.pipe');
  await writeFile(old, 'compiled'); await writeFile(fresh, 'compiled');
  const server = createServer();
  server.listen(socket);
  await once(server, 'listening');
  try {
    assert.ok((await lstat(socket)).isSocket(), 'the seeded IPC entry is a socket');
    const age = tmpReclaimMinAgeMs + 30 * 60_000;
    await backdate(old, age); await backdate(socket, age); await backdate(nested, age);
    // The cache itself was written just now, as a cache in daily use is: the directory never goes whole.
    const report = await reclaimTmpDirectories({ tmpRoot: tmp, held: new Set() });
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.removed.map(entry => entry.path), [old], 'only the old file is removed');
    assert.equal(report.removed[0]!.bytes, 'compiled'.length, 'the bytes freed are reported');
    assert.equal(existsSync(old), false, 'the old compile file is gone');
    assert.equal(existsSync(fresh), true, 'a fresh compile file stays');
    assert.equal(existsSync(socket), true, 'a socket stays whatever its age');
    assert.equal(existsSync(nested), true, 'a directory under the cache stays whatever its age');
    assert.equal(existsSync(cache), true, 'the cache directory stays');

    // The per-cycle entry limit bounds the cache's share: of three old files, a pass limited to two takes the two oldest.
    const files = [1, 2, 3].map(index => join(nested, `old-${index}`));
    for (const [index, path] of files.entries()) { await writeFile(path, 'x'); await backdate(path, age + (3 - index) * 60_000); }
    const bounded = await reclaimTmpDirectories({ tmpRoot: tmp, held: new Set(), limit: 2 });
    assert.deepEqual(bounded.removed.map(entry => entry.path), files.slice(0, 2), 'the two oldest go first, and no more than the limit');
    assert.equal(existsSync(files[2]!), true, 'the file past the limit is the next pass\'s');
    // A file a live process holds open is kept, and a caller's own prefixes never sweep the cache.
    const held = await reclaimTmpDirectories({ tmpRoot: tmp, held: new Set([files[2]!]) });
    assert.deepEqual(held.removed, [], 'a held cache file stays');
    const prefixed = await reclaimTmpDirectories({ tmpRoot: tmp, held: new Set(), prefixes: ['graphyard-'] });
    assert.deepEqual(prefixed.removed, [], 'a pass over other prefixes leaves the cache alone');
  } finally {
    server.close();
  }
});

test('unit:tmp-reclaim-tsx-cache-reported — the tmp-inodes reading counts the entries under this user\'s tsx cache among this user\'s entries and names the cache', { skip: ownCache() === null ? 'no uids on this platform' : false }, async () => {
  const tmp = await temporaryDirectory('tsx-cache-reported'), root = await temporaryDirectory('tsx-cache-reported-root');
  const cache = join(tmp, ownCache()!);
  await mkdir(join(cache, 'nested'), { recursive: true });
  for (let index = 0; index < 5; index++) await writeFile(join(cache, `17914-${index}`), 'x');
  await writeFile(join(tmp, 'graphyard-leftover'), 'x');
  const inodes = await readTmpInodes(root, tmp, async () => ({ files: 1000, ffree: 100 }));
  // Top level: the cache and one test temp file; under the cache: five files and one directory.
  assert.deepEqual(inodes?.own, { entries: 2 + 6, testTemp: 1, capped: false, tsxCache: { name: ownCache()!, entries: 6 } });
  const input: ResourceInputs = { now: Date.now(), reviews: [], producers: [], agents: [], work: [], plane: null, loop: null, revision: null, disk: null, tmp: inodes, profiles: { workers: [], reviewers: [], producers: [] } };
  const reading = readResources(input).find(entry => entry.id === 'tmp-inodes');
  assert.equal(reading?.state, 'low', 'the reading warns');
  assert.match(reading?.detail ?? '', new RegExp(`8 entries are this user's \\(1 top-level with test temp names, 6 entries under its tsx compile cache ${ownCache()}\\)`), 'the attention names the cache');
  assert.match(reading?.reclaim ?? '', /tsx compile cache/, 'the registry says the pass ages the cache');
  // Without a cache the reading names none.
  const bare = await temporaryDirectory('tsx-cache-absent');
  assert.equal((await readTmpInodes(root, bare, async () => ({ files: 1000, ffree: 100 })))?.own?.tsxCache, undefined);
});
