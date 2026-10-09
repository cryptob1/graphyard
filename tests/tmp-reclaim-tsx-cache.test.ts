import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { lstat, mkdir, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { reclaimTmpDirectories, testTempMinAgeMs, tmpReclaimMinAgeMs } from '../src/tmp-reclaim.js';
// A namespace import: on a base without GY-1597's escalation the case fails, not the file's load.
import * as tmpReclaim from '../src/tmp-reclaim.js';
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
    // A cache in use is written all day, but even one gone quiet is never taken whole: the directory
    // and every entry in it but the fresh file are past the bound, and only the old file goes.
    await backdate(cache, age);
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
    await backdate(nested, age); await backdate(cache, age);
    const bounded = await reclaimTmpDirectories({ tmpRoot: tmp, held: new Set(), limit: 2 });
    assert.deepEqual(bounded.removed.map(entry => entry.path), files.slice(0, 2), 'the two oldest go first, and no more than the limit');
    assert.equal(existsSync(files[2]!), true, 'the file past the limit is the next pass\'s');
    assert.ok(existsSync(socket) && existsSync(nested) && existsSync(cache), 'an aged cache whose files outnumber the limit is still never taken whole');
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

// GY-1597: on 9 October 2026 host /tmp fell below its 262,144-inode headroom and stayed there: the
// tsx cache grew ~450 entries per five minutes, every one younger than the six-hour bound, and the
// pass removed 0 entries a cycle at 100 per cycle. Below the headroom the pass now escalates in the
// same run — a higher cap, a younger cache age — within the same safety envelope.
test('unit:tmp-reclaim-tsx-cache — below the inode headroom one pass escalates until the volume is back above it, removing only this user\'s unheld cache files and stale test temps, and the tmp-inodes attention clears', { skip: ownCache() === null ? 'no uids on this platform' : false }, async () => {
  const tmp = await temporaryDirectory('tsx-cache-escalate');
  const cache = join(tmp, ownCache()!), nested = join(cache, 'nested');
  await mkdir(nested, { recursive: true });
  // Two hours old: past the escalated hour, short of the base six. The leak the 9 October pass never took.
  const now = Date.now(), aged: string[] = [];
  for (let index = 0; index < 300; index++) {
    const path = join(index % 2 ? nested : cache, `compiled-${index}`);
    await writeFile(path, 'x'); await backdate(path, 2 * 3_600_000, now); aged.push(path);
  }
  const fresh = join(cache, 'compiled-fresh'), heldFile = join(cache, 'compiled-held'), socket = join(cache, '2.pipe');
  await writeFile(fresh, 'x'); await writeFile(heldFile, 'x'); await backdate(heldFile, 2 * 3_600_000, now);
  const server = createServer();
  server.listen(socket);
  await once(server, 'listening');
  // Outside the cache: an old name the pass does not own, and a test temp younger than its own bound, which escalation never lowers.
  const foreign = join(tmp, 'voice-recording'), young = join(tmp, 'graphyard-young');
  await writeFile(foreign, 'x'); await backdate(foreign, 9 * 3_600_000, now);
  await mkdir(young); await backdate(young, testTempMinAgeMs - 30 * 60_000, now);
  try {
    await backdate(socket, 2 * 3_600_000, now); await backdate(nested, 9 * 3_600_000, now); await backdate(cache, 9 * 3_600_000, now);
    // The volume: 4000 inodes, so the headroom is 1000; 750 free, each removal frees one.
    const remaining = () => aged.filter(path => existsSync(path)).length;
    const measured: number[] = [];
    const volume = async () => { const ffree = 750 + aged.length - remaining(); measured.push(ffree); return { files: 4000, ffree }; };
    const report = await reclaimTmpDirectories({ tmpRoot: tmp, held: new Set([heldFile]), limit: 100, workMs: 150, volume });
    assert.deepEqual(report.errors, []);
    assert.equal(tmpReclaim.tmpInodeHeadroom?.(4000), 1000);
    assert.deepEqual(report.escalated?.map(step => ({ limit: step.limit, removed: step.removed })), [{ limit: 2_000, removed: aged.length }], 'the base pass removed nothing, and the first escalated step took every aged cache file');
    assert.equal(report.removed.length, aged.length);
    assert.equal(report.boundStands, false, 'the volume is back above its headroom');
    assert.equal(report.consumers, undefined, 'with the bound cleared no consumers are named');
    assert.ok(measured.at(-1)! >= 1000, `the last measurement is above the headroom (${measured.join(', ')})`);
    // The safety envelope is unchanged at every step.
    for (const path of [fresh, heldFile, socket, nested, cache, foreign, young]) assert.equal(existsSync(path), true, `${path} stays`);

    // The tmp-inodes reading on the next measurement: above the headroom, nothing to attend.
    const root = await temporaryDirectory('tsx-cache-escalate-root');
    const inodes = await readTmpInodes(root, tmp, volume);
    const input: ResourceInputs = { now: Date.now(), reviews: [], producers: [], agents: [], work: [], plane: null, loop: null, revision: null, disk: null, tmp: inodes, profiles: { workers: [], reviewers: [], producers: [] } };
    assert.notEqual(readResources(input).find(entry => entry.id === 'tmp-inodes')?.state, 'low', 'the resource-bound attention clears');

    // Without a volume to measure — a caller's own roots — the pass keeps its base bounds.
    const again = join(cache, 'compiled-again');
    await writeFile(again, 'x'); await backdate(again, 2 * 3_600_000);
    const base = await reclaimTmpDirectories({ tmpRoot: tmp, held: new Set() });
    assert.equal(base.escalated, undefined);
    assert.equal(existsSync(again), true, 'an unmeasured pass never lowers the cache age');
  } finally {
    server.close();
  }
});

test('unit:tmp-reclaim-tsx-cache — the escalated bounds outpace the observed leak: within an hour of cycles the top step removes far more than the ~450 entries per five minutes the cache gained', () => {
  const steps = tmpReclaim.tmpReclaimEscalation ?? [];
  assert.ok(steps.length > 0, 'the pass has escalation steps');
  const top = steps.at(-1)!, leakPerHour = 450 * 12;
  assert.ok(top.limit >= leakPerHour, `one cycle at the top step (${top.limit}) removes at least an hour of the leak (${leakPerHour})`);
  // Only what the leak wrote in the last cache-age window is out of reach: at 450 per five minutes, a few hundred entries.
  assert.ok(top.cacheAgeMs <= 15 * 60_000, 'the top step reaches cache files a quarter of an hour old');
  for (const [index, step] of steps.entries()) {
    const previous = index ? steps[index - 1]! : { limit: 100, cacheAgeMs: tmpReclaimMinAgeMs, workMs: 150 };
    assert.ok(step.limit > previous.limit && step.cacheAgeMs < previous.cacheAgeMs && step.workMs >= previous.workMs, 'each step raises the cap and lowers the cache age');
  }
});

test('unit:tmp-reclaim-tsx-cache — an escalation step\'s cap bounds the whole pass, base sweep included: a base sweep that removed 100 leaves the 2,000 step 1,900 more', { skip: ownCache() === null ? 'no uids on this platform' : false }, async () => {
  const tmp = await temporaryDirectory('tsx-cache-escalate-cap');
  const cache = join(tmp, ownCache()!);
  await mkdir(cache);
  const now = Date.now();
  // 100 stale test temps the base sweep takes, and 2,300 cache files only an escalated step reaches.
  for (let index = 0; index < 100; index++) { const path = join(tmp, `pg-password-${index}`); await writeFile(path, 'x'); await backdate(path, testTempMinAgeMs + 3_600_000, now); }
  for (let index = 0; index < 2_300; index++) { const path = join(cache, `compiled-${index}`); await writeFile(path, 'x'); await backdate(path, 2 * 3_600_000, now); }
  await backdate(cache, 9 * 3_600_000, now);
  const report = await reclaimTmpDirectories({ tmpRoot: tmp, held: new Set(), limit: 100, workMs: 60_000, volume: async () => ({ files: 4000, ffree: 100 }) });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.escalated?.map(step => ({ limit: step.limit, removed: step.removed })), [{ limit: 2_000, removed: 1_900 }, { limit: 20_000, removed: 400 }], 'each step\'s cap counts what earlier sweeps removed');
  assert.equal(report.removed.length, 2_400, 'the base 100 and every cache file, well under the 20,000 cap');
});

test('unit:tmp-reclaim-tsx-cache — escalation sweeps and names only the roots still below their headroom: a healthy TMPDIR on another volume keeps its younger cache files and stays out of the census', { skip: ownCache() === null ? 'no uids on this platform' : false }, async () => {
  const healthy = await temporaryDirectory('tsx-cache-escalate-healthy'), low = await temporaryDirectory('tsx-cache-escalate-low');
  const now = Date.now(), seeded: Record<string, string[]> = { [healthy]: [], [low]: [] };
  for (const root of [healthy, low]) {
    const cache = join(root, ownCache()!);
    await mkdir(cache);
    for (let index = 0; index < 20; index++) { const path = join(cache, `compiled-${index}`); await writeFile(path, 'x'); await backdate(path, 2 * 3_600_000, now); seeded[root]!.push(path); }
    await backdate(cache, 9 * 3_600_000, now);
  }
  const volume = async (path: string) => ({ files: 4000, ffree: path === low ? 100 : 3_000 });
  const report = await reclaimTmpDirectories({ tmpRoots: [healthy, low], held: new Set(), limit: 100, workMs: 60_000, volume });
  assert.deepEqual(report.errors, []);
  assert.equal(report.boundStands, true);
  assert.ok(seeded[low]!.every(path => !existsSync(path)), 'the low root\'s cache files went at the escalated age');
  assert.ok(seeded[healthy]!.every(path => existsSync(path)), 'the healthy root keeps the base bounds');
  assert.ok(report.consumers?.length, 'the bound still stands, so consumers are named');
  assert.ok(report.consumers!.every(consumer => consumer.path.startsWith(low)), `only the low root's consumers are named (${report.consumers!.map(consumer => consumer.path).join(', ')})`);
});
