import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { runChild, type ChildRun } from '../src/child-runner.js';
import { releaseHeldBranch } from '../src/master/worktrees.js';

// GY-1215: the follow-up of GY-1059's review. A reused same-epoch path is cleaned, and the clean
// may delete only what the preserved record holds in full: an untracked file the record merely
// names (binary, a symlink, past the record's limit) is moved aside first, where the record says.

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function host() {
  const root = await temporaryDirectory('preserved-aside');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  for (const [key, value] of [['user.email', 'hold@example.com'], ['user.name', 'Hold Test'], ['commit.gpgsign', 'false']]) git(root, 'config', key, value);
  await writeFile(join(root, 'source.ts'), 'export const value = 1;\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'base');
  return root;
}
function attemptWorktree(root: string, key: string, epoch: number) {
  const path = join(root, '.graphyard', 'worktrees', `${key}-${epoch}`), branch = `graphyard/${key.toLowerCase()}-${epoch}`;
  git(root, 'worktree', 'add', '-q', '-b', branch, path, 'main');
  return { path, branch };
}
const keptUnder = (diff: string) => /\n-- untracked files not recorded in full are kept under (.+) --$/.exec(diff)?.[1];

test('unit:worktree-preserved-aside — a reused path keeps every untracked file its record does not hold in full', async () => {
  const root = await host();
  try {
    const own = attemptWorktree(root, 'GY-890', 1);
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]), big = 'a line past the budget\n'.repeat(6_000); // ~138,000 characters
    await writeFile(join(own.path, 'a-small.txt'), 'recorded in full\n');
    await writeFile(join(own.path, 'b-image.png'), binary);
    await symlink('source.ts', join(own.path, 'c-link'));
    await mkdir(join(own.path, 'nested'));
    await writeFile(join(own.path, 'nested', 'd-big.log'), big);
    await writeFile(join(own.path, 'z-after.txt'), 'past the budget entirely\n');
    const released = await releaseHeldBranch(root, own.branch, own.path, runChild);
    assert.equal(released?.reused, true);
    const diff = released!.preserved.diff, aside = keptUnder(diff);
    assert.ok(diff.length <= 100_000, 'the record still fits the ledger');
    assert.ok(aside, 'the record names where the unrecorded files were kept');
    assert.ok(!aside.startsWith(`${own.path}/`), 'kept outside the working tree');
    assert.match(diff, /-- untracked file a-small\.txt --\nrecorded in full\n/);
    assert.equal(existsSync(join(aside, 'a-small.txt')), false, 'a file the record holds in full is not kept twice');
    assert.deepEqual(await readFile(join(aside, 'b-image.png')), binary, 'a binary file keeps its bytes');
    assert.equal(await readlink(join(aside, 'c-link')), 'source.ts', 'a symlink is kept as one');
    assert.equal(await readFile(join(aside, 'nested', 'd-big.log'), 'utf8'), big, 'a file cut by the budget is kept whole');
    assert.equal(await readFile(join(aside, 'z-after.txt'), 'utf8'), 'past the budget entirely\n', 'a file past the budget is kept');
    assert.equal(git(own.path, 'status', '--porcelain'), '', 'the reused checkout still starts clean');
    assert.equal(git(own.path, 'symbolic-ref', '--short', 'HEAD'), own.branch);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:worktree-preserved-aside — untracked files are kept when the tracked diff alone fills the record, and nothing is moved when the record holds everything or the path is not reused', async () => {
  const root = await host();
  try {
    const own = attemptWorktree(root, 'GY-891', 1);
    await writeFile(join(own.path, 'source.ts'), 'export const line = 1;\n'.repeat(8_000)); // ~184,000 characters of tracked change
    await writeFile(join(own.path, 'scratch.txt'), 'never reached by the record\n');
    const full = await releaseHeldBranch(root, own.branch, own.path, runChild);
    const aside = keptUnder(full!.preserved.diff);
    assert.ok(full!.preserved.diff.length <= 100_000);
    assert.ok(aside, 'a truncated record still names where the files were kept');
    assert.equal(await readFile(join(aside, 'scratch.txt'), 'utf8'), 'never reached by the record\n');
    assert.equal(git(own.path, 'status', '--porcelain'), '');

    const clean = attemptWorktree(root, 'GY-892', 1);
    await writeFile(join(clean.path, 'leftover.txt'), 'from a failed hook\n');
    const recorded = await releaseHeldBranch(root, clean.branch, clean.path, runChild);
    assert.equal(keptUnder(recorded!.preserved.diff), undefined, 'a record that holds everything names no directory');
    assert.equal(existsSync(join(git(clean.path, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'graphyard-preserved', 'GY-892-1')), false);
    assert.equal(git(clean.path, 'status', '--porcelain'), '');

    // A holder at another path is detached, never cleaned: its files stay where they are.
    const old = attemptWorktree(root, 'GY-893', 1);
    await writeFile(join(old.path, 'image.png'), Buffer.from([0, 1, 2]));
    const detached = await releaseHeldBranch(root, old.branch, join(root, '.graphyard', 'worktrees', 'GY-893-2'), runChild);
    assert.equal(detached?.reused, false);
    assert.equal(keptUnder(detached!.preserved.diff), undefined);
    assert.equal(existsSync(join(old.path, 'image.png')), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// GY-1274: the follow-ups of GY-1215's review.
test('unit:worktree-preserved-aside — kept files outlive the worktree, a file ending at the budget line is never cut and deleted, and an unresolvable git dir rejects before anything changes', async () => {
  const root = await host();
  try {
    // A file recorded "in full" whose end falls in the window the truncation suffix takes, followed by
    // a named-only binary file that pushes the record past its limit.
    const own = attemptWorktree(root, 'GY-894', 1);
    const common = git(own.path, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    const keptNote = `\n-- untracked files not recorded in full are kept under ${join(common, 'graphyard-preserved', 'GY-894-1', new Date().toISOString().replace(/[:.]/g, '-'))} --`;
    const heading = '-- untracked files --\n', header = '-- untracked file a-edge.txt --\n';
    const edge = 'e'.repeat(100_000 - keptNote.length - 10 - heading.length - header.length);
    await writeFile(join(own.path, 'a-edge.txt'), edge);
    await writeFile(join(own.path, 'b-image.png'), Buffer.from([0, 1, 2]));
    const released = await releaseHeldBranch(root, own.branch, own.path, runChild);
    const diff = released!.preserved.diff, aside = keptUnder(diff)!;
    assert.ok(diff.length <= 100_000);
    assert.ok(aside.startsWith(join(common, 'graphyard-preserved', 'GY-894-1')), 'kept under the common git dir');
    const kept = existsSync(join(aside, 'a-edge.txt')) ? await readFile(join(aside, 'a-edge.txt'), 'utf8') : null;
    assert.ok(kept === edge || diff.includes(`${header}${edge}\n`), 'the edge file is either recorded whole or kept whole');
    assert.equal(kept, edge, 'a file the suffix would cut is not counted as recorded in full');
    // Reclaiming the attempt worktree deletes its own git dir; the kept files survive it.
    git(root, 'worktree', 'remove', '--force', own.path);
    git(root, 'worktree', 'prune');
    assert.deepEqual(await readFile(join(aside, 'b-image.png')), Buffer.from([0, 1, 2]), 'the named directory outlives the worktree');

    // A git that cannot name the git dir rejects the release: nothing is registered, moved or cleaned.
    const stuck = attemptWorktree(root, 'GY-895', 1);
    await writeFile(join(stuck.path, 'image.png'), Buffer.from([0, 1, 2]));
    const refusing: ChildRun = (command, args, options) => args.includes('--git-common-dir') ? Promise.reject(new Error('git refused')) : runChild(command, args, options);
    let registered = false;
    await assert.rejects(releaseHeldBranch(root, stuck.branch, stuck.path, refusing, async () => { registered = true; }), /git refused/);
    assert.equal(registered, false);
    assert.deepEqual(await readFile(join(stuck.path, 'image.png')), Buffer.from([0, 1, 2]), 'the untracked file stays where it was');
  } finally { await rm(root, { recursive: true, force: true }); }
});
