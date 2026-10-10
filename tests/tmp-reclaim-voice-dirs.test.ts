import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
// A namespace import: on a base without GY-1618 the cases fail, not the file's load.
import * as tmpReclaim from '../src/tmp-reclaim.js';
import { reclaimTmpDirectories, testTempMinAgeMs } from '../src/tmp-reclaim.js';
import { readResources, readTmpInodes, reclaimResources, resourceAttention, settleTmpReclaim, type ResourceInputs } from '../src/master-resources.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1618: agent sessions on another repository left six linked git worktrees in /tmp
// (`voice615-base-189-release` and siblings, ~70,600 inodes each, last written 6–7 October 2026).
// The pass matched only test temp names, so it escalated to 20,000 per cycle and removed nothing
// while /tmp fell to 2% of its inodes free. The pass now takes this user's `voice<n>-*` agent
// scratch once its whole tree, and a worktree's gitdir, has gone a day unwritten and no live
// process holds it open or names it in its command line.

const day = 24 * 3_600_000, hour = 3_600_000;
const backdate = (path: string, ageMs: number, now = Date.now()) => utimes(path, new Date(now - ageMs), new Date(now - ageMs));
/** Backdate a whole tree, deepest entries first, so writing a child never refreshes its parent. */
async function backdateTree(path: string, ageMs: number, now = Date.now()) {
  for (const name of await readdir(path, { recursive: true })) await backdate(join(path, name), ageMs, now);
  await backdate(path, ageMs, now);
}
/** A checkout like the leaked ones: a `.git` file naming a gitdir, dependencies a few levels down. */
async function checkout(tmp: string, name: string, gitdirs: string) {
  const path = join(tmp, name), gitdir = join(gitdirs, name);
  await mkdir(join(path, 'packages', 'agents', 'node_modules', 'dep'), { recursive: true });
  await writeFile(join(path, 'packages', 'agents', 'node_modules', 'dep', 'index.js'), 'x');
  await writeFile(join(path, 'AGENTS.md'), 'x');
  await mkdir(join(gitdir, 'logs'), { recursive: true });
  await writeFile(join(gitdir, 'HEAD'), 'abc\n'); await writeFile(join(gitdir, 'index'), 'x');
  await writeFile(join(path, '.git'), `gitdir: ${gitdir}\n`);
  return { path, gitdir };
}

test('integration:tmp-reclaim-voice-dirs — the pass removes this user\'s voice<n>-* scratch a day unwritten and unheld, and keeps one written deep in its tree or its gitdir, a younger one, a held one and other names', async () => {
  assert.equal(typeof tmpReclaim.agentScratchMinAgeMs, 'number', 'the pass has an agent scratch age bound');
  const base = await temporaryDirectory('voice-dirs'), tmp = join(base, 'tmp'), gitdirs = join(base, 'repo-worktrees');
  await mkdir(tmp); await mkdir(gitdirs);
  const now = Date.now(), stale = day + hour;

  const leaked = await checkout(tmp, 'voice615-base-189-release', gitdirs);
  const leakedLog = join(tmp, 'voice511-diagnostic-1.log');
  await writeFile(leakedLog, 'x');
  // Every top-level mtime is old, but a file deep inside was edited an hour ago.
  const deepEdit = await checkout(tmp, 'voice615-ci-oldhead-189', gitdirs);
  // Old throughout, but a commit there rewrote its gitdir an hour ago.
  const committed = await checkout(tmp, 'voice615-replay-189-stage', gitdirs);
  // Written twelve hours ago: past the test temp bound, short of the agent scratch one.
  const younger = await checkout(tmp, 'voice638-189-pg17', gitdirs);
  // Old and quiet, but a live process names a path inside it.
  const held = await checkout(tmp, 'voice638-189-db', gitdirs);
  // Old, but not an agent scratch name.
  const foreign = join(tmp, 'voice-recording'), other = join(tmp, 'huck-x10-voice587');
  await mkdir(foreign); await mkdir(other);

  for (const path of [leaked.path, leaked.gitdir, deepEdit.path, deepEdit.gitdir, committed.path, committed.gitdir, held.path, held.gitdir, foreign, other]) await backdateTree(path, stale, now);
  await backdate(leakedLog, stale, now);
  await backdateTree(younger.path, 12 * hour, now); await backdateTree(younger.gitdir, 12 * hour, now);
  await backdate(join(deepEdit.path, 'packages', 'agents', 'node_modules', 'dep', 'index.js'), hour, now);
  await backdate(join(committed.gitdir, 'index'), hour, now);

  const report = await reclaimTmpDirectories({ tmpRoot: tmp, now, held: new Set([join(held.path, 'postmaster.pid')]) });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.removed.map(entry => entry.path).sort(), [leaked.path, leakedLog].sort(), 'only the day-stale, unheld agent scratch goes');
  for (const path of [deepEdit.path, committed.path, younger.path, held.path, foreign, other]) assert.equal(existsSync(path), true, `${path} stays`);
  assert.ok(12 * hour > testTempMinAgeMs, 'the younger checkout is past the test temp bound, so the agent scratch bound alone keeps it');

  // The tmp-inodes reading counts this user's agent scratch entries among its own.
  const root = await temporaryDirectory('voice-dirs-root');
  const inodes = await readTmpInodes(root, tmp, async () => ({ files: 1_048_576, ffree: 400_000 }));
  assert.equal(inodes?.own?.agentScratch, 4, 'four voice<n>-* entries remain');
  const reading = readResources({ now, reviews: [], producers: [], agents: [], work: [], plane: null, loop: null, revision: null, disk: null, tmp: inodes, profiles: { workers: [], reviewers: [], producers: [] } }).find(entry => entry.id === 'tmp-inodes');
  assert.match(reading?.detail ?? '', /4 with agent scratch names/);
});

test('unit:tmp-reclaim-live-process-guard — a running process that names a voice<n>-* directory in its command line keeps it, with its working directory elsewhere and no file open there; once it exits the pass removes the directory', async () => {
  assert.deepEqual(tmpReclaim.namedPaths?.(['postgres', '-D', '/tmp/voice638-189-db/', '--dir=/tmp/a/b', 'cd /tmp/voice1-x && ls', 'https://example.com/path', './relative'].join('\0')),
    ['/tmp/voice638-189-db', '/tmp/a/b', '/tmp/voice1-x'], 'whole arguments, paths after = and paths inside a longer argument; never a URL or a relative path');
  const tmp = await temporaryDirectory('voice-live-guard');
  const named = join(tmp, 'voice638-189-db'), unnamed = join(tmp, 'voice639-189-db');
  for (const path of [named, unnamed]) { await mkdir(path); await writeFile(join(path, 'PG_VERSION'), '17'); await backdateTree(path, 2 * day); }
  // A server started with the directory as an argument, as `postgres -D <dir>` is, running from elsewhere.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '-D', named], { cwd: '/', stdio: 'ignore' });
  await once(child, 'spawn');
  try {
    const held = await tmpReclaim.heldOpenPaths();
    if (!existsSync('/proc')) return;
    assert.ok(held.has(named), 'the /proc scan reports the path the command line names');
    // No `held` given: the pass runs its own /proc scan, as the loop's does.
    const report = await reclaimTmpDirectories({ tmpRoot: tmp });
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.removed.map(entry => entry.path), [unnamed]);
    assert.equal(existsSync(named), true, 'a directory a running process names is never removed');
  } finally {
    child.kill(); if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  }
  const after = await reclaimTmpDirectories({ tmpRoot: tmp });
  assert.deepEqual(after.removed.map(entry => entry.path), [named], 'once the process has exited the stale directory goes');
});

test('integration:tmp-inodes-attention-retires — with /tmp below its headroom, the loop\'s pass removes the stale voice<n>-* trees, the tmp-inodes reading names that scope, its attention retires at or above 262,144 free, and the escalated steps stand down', async () => {
  const root = await temporaryDirectory('voice-attention');
  await mkdir(join(root, '.graphyard'));
  const tmp = join(root, 'tmp'), gitdirs = join(root, 'worktrees');
  await mkdir(tmp); await mkdir(gitdirs);
  const trees: string[] = [];
  for (const name of ['voice615-base-189-release', 'voice615-ci-base-bb-189', 'voice615-ci-oldhead-189', 'voice615-replay-189-release', 'voice615-replay-189-stage', 'voice595-date-release-base-189']) {
    const { path, gitdir } = await checkout(tmp, name, gitdirs);
    await backdateTree(path, 3 * day); await backdateTree(gitdir, 3 * day); trees.push(path);
  }
  // The host's volume as the 9 October census saw it: each tree stands for ~70,600 inodes.
  const total = 1_048_576, perTree = 70_600, headroom = tmpReclaim.tmpInodeHeadroom(total);
  assert.equal(headroom, 262_144);
  const free = () => 32_000 + trees.filter(path => !existsSync(path)).length * perTree;
  const volume = async () => ({ files: total, ffree: free() });
  const input = (tmpInodes: Awaited<ReturnType<typeof readTmpInodes>>): ResourceInputs => ({ now: Date.now(), reviews: [], producers: [], agents: [], work: [], plane: null, loop: null, revision: null, disk: null, tmp: tmpInodes, profiles: { workers: [], reviewers: [], producers: [] } });

  // Before: below the headroom, the reading is low, raises attention and names the agent scratch scope.
  const before = readResources(input(await readTmpInodes(root, tmp, volume))).find(entry => entry.id === 'tmp-inodes')!;
  assert.equal(before.state, 'low');
  assert.equal(resourceAttention([before]).length, 1, 'the resource-bound attention stands');
  assert.match(before.reclaim, /agent scratch entries \(voice<n>-\*\)/, 'the reading reports the reclaimed scope');
  assert.match(before.reclaim, /names in its command line/);

  // The loop's own pass, measured against that volume: one cycle starts it, the next records it.
  const options = { tmpRoot: tmp, tmpPass: (pass: Parameters<typeof reclaimTmpDirectories>[0]) => reclaimTmpDirectories({ ...pass, held: new Set(), volume }) };
  await reclaimResources(root, { reviewers: [], producers: [] }, { work: [], agents: [] }, options);
  await settleTmpReclaim();
  const report = await reclaimResources(root, { reviewers: [], producers: [] }, { work: [], agents: [] }, options);
  await settleTmpReclaim();
  assert.deepEqual(report.errors, []);
  for (const path of trees) assert.equal(existsSync(path), false, `${path} is reclaimed`);
  assert.ok(free() >= headroom, `headroom recovered: ${free()} free`);

  // After: the reading is above its headroom and the attention row retires.
  const after = readResources(input(await readTmpInodes(root, tmp, volume))).find(entry => entry.id === 'tmp-inodes')!;
  assert.notEqual(after.state, 'low');
  assert.deepEqual(resourceAttention([after]), [], 'the resource-bound attention retires');

  // The next pass, with the volume above its headroom, keeps its base bounds: no escalated step runs and nothing is named.
  const next = await reclaimTmpDirectories({ tmpRoot: tmp, held: new Set(), volume });
  assert.equal(next.boundStands, false);
  assert.equal(next.escalated, undefined, 'the 20,000-per-cycle step stands down');
  assert.equal(next.consumers, undefined);
});
