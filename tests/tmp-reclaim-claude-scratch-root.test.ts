import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentScratchMinAgeMs, reclaimTmpDirectories } from '../src/tmp-reclaim.js';
import { readResources, readTmpInodes, type ResourceInputs } from '../src/master-resources.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1827: Claude Code makes one scratch directory per project path under `claude-<uid>` in a
// temporary directory, so every worker worktree got its own and none was removed when the session
// ended — 1,569 directories, 1,540 of them unwritten for more than a day and holding 17 GB, filled
// the coordinator volume while the loop's pass, which aged only `opencode`'s root, found nothing
// reclaimable. This user's `claude-<uid>` root — `<uid>` the process uid, as tsx's per-uid cache is
// — is now a runtime scratch root under the same rules as opencode: each entry inside is aged by
// its whole tree against `agentScratchMinAgeMs`, the root itself is never removed, an entry a live
// process holds open or names is kept whatever its age, another user's root is theirs, and the
// runtime scratch cap still applies below the inode headroom.

const hour = 3_600_000, day = 24 * hour;
const backdate = (path: string, ageMs: number, now = Date.now()) => utimes(path, new Date(now - ageMs), new Date(now - ageMs));
/** Backdate a whole tree, deepest entries first, so writing a child never refreshes its parent. */
async function backdateTree(path: string, ageMs: number, now = Date.now()) {
  for (const name of await readdir(path, { recursive: true })) await backdate(join(path, name), ageMs, now);
  await backdate(path, ageMs, now);
}
const blank = (overrides: Partial<ResourceInputs>): ResourceInputs => ({ now: Date.now(), reviews: [], producers: [], agents: [], work: [], plane: null, loop: null, revision: null, disk: null, tmp: null, profiles: { workers: [], reviewers: [], producers: [] }, ...overrides });

test('unit:tmp-reclaim-claude-scratch-root — a default pass ages this user\'s claude-<uid> root like opencode\'s: an entry whose whole tree went the agent scratch bound unwritten goes as runtime scratch, the recently written entry and the root itself stay, and status names the root', async () => {
  const base = await temporaryDirectory('claude-scratch-root'), tmp = join(base, 'tmp'), claude = join(tmp, `claude-${process.getuid!()}`);
  await mkdir(claude, { recursive: true });
  const now = Date.now();
  assert.ok(day + hour > agentScratchMinAgeMs, 'the stale entries sit past the agent scratch bound');
  // A project scratch directory of a finished session: every write in its tree is past the bound.
  const stale = join(claude, '-home-vish-code-graphyard--graphyard-worktrees-GY-99-0');
  await mkdir(join(stale, 'projects'), { recursive: true }); await writeFile(join(stale, 'projects', 'session.jsonl'), 'x');
  await backdateTree(stale, day + hour, now);
  // A config file of a session, left the same way.
  const staleFile = join(claude, 'machines.json'); await writeFile(staleFile, 'x'); await backdate(staleFile, 2 * day, now);
  // A live project: the session wrote an hour ago, deep inside, where a top-level reading alone
  // would call the directory stale — the claude entries are judged by their whole trees.
  const recent = join(claude, '-home-vish-code-graphyard--graphyard-worktrees-GY-1827-1');
  await mkdir(recent); await writeFile(join(recent, 'session.jsonl'), 'x');
  await backdateTree(recent, 2 * day, now); await backdate(join(recent, 'session.jsonl'), hour, now);
  await backdate(claude, 2 * day, now);
  assert.ok(now - (await lstat(claude)).mtimeMs >= 2 * day, 'the root itself sits past the bound as a run of finished sessions leaves it');

  const report = await reclaimTmpDirectories({ tmpRoot: tmp, now, held: new Set() });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.removed.map(entry => entry.path).sort(), [stale, staleFile].sort(), 'only the entries whose whole trees went past the bound go');
  assert.equal(report.classes?.runtimeScratch, 2, 'the removals count as runtime scratch');
  for (const path of [claude, recent]) assert.equal(existsSync(path), true, `${path} stays`);

  // Status names the new root beside opencode's, as the registry's reclaim line.
  const reading = readResources(blank({ tmp: await readTmpInodes(base, tmp, async () => ({ files: 1_048_576, ffree: 900_000 })) })).find(entry => entry.id === 'tmp-inodes');
  assert.match(reading?.reclaim ?? '', /scratch roots \(opencode, claude-<uid>\)/, 'the tmp-inodes reading names the claude-<uid> root');
});

test('unit:tmp-reclaim-claude-scratch-root — an entry that a live process holds open or names stays whatever its age, and a claude-<other uid> root is never touched', async () => {
  const base = await temporaryDirectory('claude-scratch-held'), tmp = join(base, 'tmp'), claude = join(tmp, `claude-${process.getuid!()}`);
  await mkdir(claude, { recursive: true });
  const now = Date.now();
  // Old past the bound, but a process holds a file descriptor into the directory.
  const heldInside = join(claude, '-home-vish-code-graphyard--graphyard-worktrees-GY-7-0');
  await mkdir(join(heldInside, 'projects'), { recursive: true }); await writeFile(join(heldInside, 'projects', 'session.jsonl'), 'x');
  await backdateTree(heldInside, 3 * day, now);
  // Old past the bound, and named whole on a process's command line.
  const heldNamed = join(claude, '-home-vish-code-graphyard--graphyard-worktrees-GY-8-0');
  await mkdir(heldNamed); await writeFile(join(heldNamed, 'session.jsonl'), 'x');
  await backdateTree(heldNamed, 3 * day, now);
  // Old past the bound and held by nothing: it goes.
  const stale = join(claude, '-home-vish-code-graphyard--graphyard-worktrees-GY-9-0');
  await mkdir(stale); await writeFile(join(stale, 'session.jsonl'), 'x');
  await backdateTree(stale, 3 * day, now);
  await backdate(claude, 3 * day, now);
  const held = new Set([join(heldInside, 'projects'), heldNamed]);

  const report = await reclaimTmpDirectories({ tmpRoot: tmp, now, held });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.removed.map(entry => entry.path), [stale], 'only the unheld stale entry goes');
  for (const path of [claude, heldInside, heldNamed]) assert.equal(existsSync(path), true, `${path} stays whatever its age`);

  // Another user's claude root is theirs: a pass running as another uid skips it whole, whatever
  // the age of what sits inside.
  const getuid = process.getuid!, realUid = getuid(), foreign = join(tmp, `claude-${realUid + 1}`);
  await mkdir(join(foreign, 'projects'), { recursive: true });
  await writeFile(join(foreign, 'projects', 'session.jsonl'), 'x');
  await backdateTree(foreign, 3 * day, now); await backdate(foreign, 3 * day, now);
  process.getuid = () => realUid + 1;
  let others;
  try { others = await reclaimTmpDirectories({ tmpRoot: tmp, now, held: new Set() }); } finally { process.getuid = getuid; }
  assert.deepEqual(others.errors, []);
  assert.deepEqual(others.removed, [], 'another user\'s claude root is never examined');
  assert.equal(existsSync(join(foreign, 'projects', 'session.jsonl')), true, 'the other uid\'s entries stay');
});
