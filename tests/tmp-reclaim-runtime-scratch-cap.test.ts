import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
// A namespace import: on a base without GY-1683 the cases fail, not the file's load.
import * as tmpReclaim from '../src/tmp-reclaim.js';
import { agentScratchMinAgeMs, reclaimTmpDirectories, tmpInodeHeadroom } from '../src/tmp-reclaim.js';
import { describeTmpClasses, readResources, readTmpInodes, type ResourceInputs } from '../src/master-resources.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1683: five long-lived opencode sessions kept ~18 full pnpm-workspace worktrees warm under
// /tmp/opencode inside the 24-hour agent scratch bound (498,925 entries, 56% of /tmp's used inodes),
// so the pass removed 0 entries for 17 passes while the inode bound stood. While a scanned root is
// below its inode headroom the pass now caps each runtime scratch root to its most recently written
// entries, oldest first and whatever their age; above headroom the agent scratch bound alone decides.

const hour = 3_600_000, day = 24 * hour;
const backdate = (path: string, ageMs: number, now = Date.now()) => utimes(path, new Date(now - ageMs), new Date(now - ageMs));
/** Backdate a whole tree, deepest entries first, so writing a child never refreshes its parent. */
async function backdateTree(path: string, ageMs: number, now = Date.now()) {
  for (const name of await readdir(path, { recursive: true })) await backdate(join(path, name), ageMs, now);
  await backdate(path, ageMs, now);
}
/** A session's scratch checkout as opencode leaves it: a pnpm workspace with dependencies a few levels down. */
async function checkout(scratch: string, name: string, ageMs: number, now: number) {
  const path = join(scratch, name);
  await mkdir(join(path, 'node_modules', 'dep'), { recursive: true });
  await writeFile(join(path, 'node_modules', 'dep', 'index.js'), 'x');
  await writeFile(join(path, 'pnpm-workspace.yaml'), 'packages: []\n');
  await backdateTree(path, ageMs, now);
  return path;
}
/** A volume below its inode headroom until `freed` of the root's entries are gone, as the host's /tmp was. */
function lowVolume(scratch: string, entries: () => string[], perEntry: number, used: number) {
  const total = 1_048_576;
  return async () => ({ files: total, ffree: total - used + entries().filter(path => !existsSync(path)).length * perEntry });
}
const blank = (overrides: Partial<ResourceInputs>): ResourceInputs => ({ now: Date.now(), reviews: [], producers: [], agents: [], work: [], plane: null, loop: null, revision: null, disk: null, tmp: null, profiles: { workers: [], reviewers: [], producers: [] }, ...overrides });

test('unit:runtime-scratch-cap-oldest-first — with the root below its inode headroom, the pass keeps the cap\'s most recently written entries of /tmp/opencode (by their whole trees), removes the oldest beyond it although every entry is younger than the agent scratch bound, never the root itself nor another user\'s entries, and the record names the class', async () => {
  assert.equal(typeof tmpReclaim.runtimeScratchCapEntries, 'number', 'the pass has a runtime scratch cap');
  assert.ok(tmpReclaim.runtimeScratchCapEntries >= 5, 'the cap keeps a live session\'s current checkout for each of several sessions');
  const base = await temporaryDirectory('scratch-cap'), tmp = join(base, 'tmp'), scratch = join(tmp, 'opencode');
  await mkdir(scratch, { recursive: true });
  const now = Date.now();
  // Six checkouts, every one written inside the 24-hour bound: hours 1–6, oldest last. The third's top
  // level is the oldest of all but a file deep in its tree was written an hour ago: it is the newest.
  const names = ['he-activate-final', 'he-35b', 'canary-poll-review', 'f400-review', 'fence-tick', 'w6-final'];
  const paths: string[] = [];
  for (const [index, name] of names.entries()) paths.push(await checkout(scratch, name, (index + 2) * hour, now));
  await backdateTree(paths[2]!, 20 * hour, now);
  await backdate(join(paths[2]!, 'node_modules', 'dep', 'index.js'), hour, now);
  // A packet file of a session, three hours old, is an entry like any other.
  const packet = join(scratch, '500e0ab4-packet.txt');
  await writeFile(packet, 'x'); await backdate(packet, 3 * hour, now);
  await backdate(scratch, hour, now);
  const all = [...paths, packet];
  for (const path of all) assert.ok(now - (await lstat(path)).mtimeMs < agentScratchMinAgeMs, `${path} is inside the agent scratch bound`);

  // Above headroom, nothing in the root is old enough: today's rule (the base sweep, and no escalation).
  const healthy = await reclaimTmpDirectories({ tmpRoot: tmp, now, held: new Set(), volume: async () => ({ files: 1_048_576, ffree: 900_000 }), runtimeScratchCap: 3 });
  assert.deepEqual(healthy.removed, [], 'above headroom every entry inside the bound stays');
  assert.equal(healthy.boundStands, false);

  // Below headroom: the three most recently written stay — the deep-edited checkout, the youngest
  // checkout and the packet — and the four oldest go, oldest first, whatever their age.
  // Each checkout stands for ~30,000 inodes: four gone bring the volume back above its headroom.
  const volume = lowVolume(scratch, () => all, 30_000, 900_000);
  const report = await reclaimTmpDirectories({ tmpRoot: tmp, now, held: new Set(), volume, runtimeScratchCap: 3 });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.removed.map(entry => entry.path), [paths[5], paths[4], paths[3], paths[1]], 'the entries beyond the cap go, oldest first');
  for (const path of [scratch, paths[0], paths[2], packet]) assert.equal(existsSync(path), true, `${path} stays`);
  assert.equal(report.classes?.runtimeScratch, 4, 'the removals are runtime scratch');
  assert.equal(report.escalated?.length, 1, 'the cap ran in the escalated step, which cleared the bound');
  assert.equal(report.boundStands, false, 'the root is back above its headroom');
  assert.equal(describeTmpClasses(report.classes!), '0 test temp, 0 tsx cache, 0 agent worktree, 4 runtime scratch', 'the record names the classes that took the entries');

  // Another user's entries are theirs: with this user's uid elsewhere nothing in the root is touched.
  const getuid = process.getuid!, realUid = getuid();
  process.getuid = () => realUid + 1;
  let foreign;
  try { foreign = await reclaimTmpDirectories({ tmpRoot: tmp, now, held: new Set(), volume: async () => ({ files: 1_048_576, ffree: 1_000 }), runtimeScratchCap: 1 }); } finally { process.getuid = getuid; }
  assert.deepEqual(foreign.removed, [], 'another user\'s entries stay, cap or no cap');
  for (const path of [scratch, paths[0], paths[2], packet]) assert.equal(existsSync(path), true, `${path} stays`);

  // The default cap is the documented one, and the tmp-inodes reading states it.
  const root = await temporaryDirectory('scratch-cap-root');
  const reading = readResources(blank({ tmp: await readTmpInodes(root, tmp, async () => ({ files: 1_048_576, ffree: 400_000 })) })).find(entry => entry.id === 'tmp-inodes');
  assert.match(reading?.reclaim ?? '', new RegExp(`caps each runtime scratch root to its ${tmpReclaim.runtimeScratchCapEntries} most recently written entries`), 'the registry describes the cap');
});

test('unit:runtime-scratch-cap-keeps-held — below headroom an entry beyond the cap that a live process holds open or names stays, counted as kept, while the unheld ones beyond the cap go', async () => {
  const base = await temporaryDirectory('scratch-cap-held'), tmp = join(base, 'tmp'), scratch = join(tmp, 'opencode');
  await mkdir(scratch, { recursive: true });
  const now = Date.now();
  const newest = await checkout(scratch, 'he-final', 2 * hour, now);
  // Old, beyond the cap, but a process has its working directory inside it.
  const heldInside = await checkout(scratch, 'activate-review', 5 * hour, now);
  // Old, beyond the cap, and named whole on a process's command line.
  const heldNamed = await checkout(scratch, 'orchestrate-review3', 6 * hour, now);
  const stale = await checkout(scratch, 'he-1952-final', 7 * hour, now);
  const staleFile = join(scratch, '7e5bafba-review.txt');
  await writeFile(staleFile, 'x'); await backdate(staleFile, 8 * hour, now);
  await backdate(scratch, hour, now);
  const all = [newest, heldInside, heldNamed, stale, staleFile];
  const held = new Set([join(heldInside, 'node_modules'), heldNamed]);
  const report = await reclaimTmpDirectories({ tmpRoot: tmp, now, held, volume: lowVolume(scratch, () => all, 28_000, 900_000), runtimeScratchCap: 1 });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.removed.map(entry => entry.path), [staleFile, stale], 'only the unheld entries beyond the cap go, oldest first');
  for (const path of [scratch, newest, heldInside, heldNamed]) assert.equal(existsSync(path), true, `${path} stays`);
  assert.ok(report.kept >= 2, `the held entries are counted as kept (${report.kept})`);
  // Once the holders are gone, the next pass below headroom takes them too.
  const next = await reclaimTmpDirectories({ tmpRoot: tmp, now, held: new Set(), volume: lowVolume(scratch, () => all, 28_000, 900_000), runtimeScratchCap: 1 });
  assert.deepEqual(next.removed.map(entry => entry.path), [heldNamed, heldInside]);
  assert.equal(existsSync(newest), true);
});

test('unit:runtime-scratch-uncapped-unchanged — above headroom the pass keeps today\'s rules: an entry of /tmp/opencode goes only once its tree has gone the agent scratch bound unwritten, so a healthy /tmp loses nothing new', async () => {
  const base = await temporaryDirectory('scratch-uncapped'), tmp = join(base, 'tmp'), scratch = join(tmp, 'opencode');
  await mkdir(scratch, { recursive: true });
  const now = Date.now();
  // Far more entries than the cap, every one inside the bound but one.
  const young: string[] = [];
  for (let index = 0; index < tmpReclaim.runtimeScratchCapEntries + 3; index++) young.push(await checkout(scratch, `session-${index}`, (index + 1) * hour, now));
  const stale = await checkout(scratch, 'he-display-1939', day + hour, now);
  await backdate(scratch, hour, now);
  const headroom = tmpInodeHeadroom(1_048_576);
  assert.equal(headroom, 262_144);
  // Exactly at the headroom: not below it, so no escalation and no cap.
  const report = await reclaimTmpDirectories({ tmpRoot: tmp, now, held: new Set(), volume: async () => ({ files: 1_048_576, ffree: headroom }) });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.removed.map(entry => entry.path), [stale], 'only the day-stale entry goes, as before');
  assert.equal(report.escalated, undefined, 'no escalated step ran');
  assert.equal(report.boundStands, false);
  for (const path of young) assert.equal(existsSync(path), true, `${path} stays inside the bound`);
  // Without a volume to measure (a caller's pass) the same holds.
  const unmeasured = await reclaimTmpDirectories({ tmpRoot: tmp, now, held: new Set() });
  assert.deepEqual(unmeasured.removed, []);
  for (const path of young) assert.equal(existsSync(path), true);
});
