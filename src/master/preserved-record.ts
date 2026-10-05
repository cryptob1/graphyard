// Concern: what a released worktree's record holds — its stopped operation, tracked diff and untracked files — and what it keeps aside.
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, rename, open, cp } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { ChildRun } from '../child-runner.js';

/*
 * Split out of worktrees.ts (GY-1215): releasing a held branch records the holder before it is
 * changed, and these helpers capture that record and keep what the record cannot restore.
 */

/** What an earlier attempt's worktree held when an allocation released its branch: where it was, what it pointed at, the operation it was mid-way through, and the uncommitted diff it carried. */
export interface PreservedWorktree { path: string; head: string; branchTip: string; op: 'rebase' | 'merge' | 'cherry-pick' | null; refs: string; diff: string; at: string }

/** The git a branch release runs: the asynchronous runner, so a launcher on this loop never blocks on a child. */
export type BranchGit = (cwd: string, ...args: string[]) => Promise<string>;

/** An operation a holder can be stopped inside; the ledger's record names the first three, and the diff's first line names the rest. */
export type HolderOperation = NonNullable<PreservedWorktree['op']> | 'revert' | 'merge --squash';

/** The in-progress operation a worktree is stopped inside, or null; each state lives in that worktree's own git dir. */
export async function inProgressOperation(git: BranchGit, path: string): Promise<HolderOperation | null> {
  const gitPath = async (name: string) => resolve(path, (await git(path, 'rev-parse', '--git-path', name)).trim());
  if (existsSync(await gitPath('rebase-merge')) || existsSync(await gitPath('rebase-apply'))) return 'rebase';
  if (existsSync(await gitPath('MERGE_HEAD'))) return 'merge';
  if (existsSync(await gitPath('CHERRY_PICK_HEAD'))) return 'cherry-pick';
  if (existsSync(await gitPath('REVERT_HEAD'))) return 'revert';
  // `merge --squash` writes no MERGE_HEAD; its message file is what marks it.
  if (existsSync(await gitPath('SQUASH_MSG'))) return 'merge --squash';
  return null;
}

/** The branch a stopped rebase is rewriting, read from its own state, or empty. */
export async function rebaseHeadName(git: BranchGit, path: string): Promise<string> {
  for (const state of ['rebase-merge', 'rebase-apply']) {
    const directory = resolve(path, (await git(path, 'rev-parse', '--git-path', state)).trim());
    if (!existsSync(directory)) continue;
    try { return (await readFile(resolve(directory, 'head-name'), 'utf8')).trim(); } catch { return ''; }
  }
  return '';
}

/** The most `git diff` output a release buffers (GY-1059): far above the ledger's limit, far below the runner's. */
export const preservedDiffCaptureBytes = 1024 * 1024;

/**
 * The holder's uncommitted tracked changes, bounded before they are buffered: a diff larger than
 * the capture limit (or one git cannot produce) is recorded as its stat instead, saying so.
 */
export async function trackedDiff(run: ChildRun, path: string): Promise<string> {
  try { return String(await run('git', ['-C', path, 'diff', 'HEAD'], { maxBuffer: preservedDiffCaptureBytes })); }
  catch (error) {
    let stat = '';
    try { stat = String(await run('git', ['-C', path, 'diff', 'HEAD', '--stat=200'], { maxBuffer: preservedDiffCaptureBytes })); } catch {}
    return `-- the full diff could not be captured (${(error instanceof Error ? error.message : String(error)).split('\n')[0]}); its stat follows --\n${stat}`;
  }
}

/**
 * Each untracked file by path and content, within `budget` characters: the record alone can then
 * restore it, not only name it. A binary file, a symlink or anything past the budget is named
 * only, and returned in `unrecorded` (GY-1215): the record cannot restore those, so whoever is
 * about to clean the worktree must keep them. A section recorded in full ends within the budget.
 */
export async function untrackedContents(git: BranchGit, path: string, budget: number): Promise<{ text: string; unrecorded: string[] }> {
  const paths = (await git(path, 'ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean);
  const sections: string[] = [], unrecorded: string[] = [];
  let used = 0;
  for (const name of paths) {
    const file = resolve(path, name), info = await lstat(file).catch(() => null);
    let section = `-- untracked file ${name} --`, whole = false;
    if (info?.isSymbolicLink()) section = `-- untracked symlink ${name} --`;
    else if (info?.isFile() && used + section.length < budget) {
      const handle = await open(file, 'r');
      try {
        const room = Math.min(info.size, budget - used - section.length - 1);
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(room), 0, room, 0);
        const bytes = buffer.subarray(0, bytesRead), text = bytes.toString('utf8');
        if (bytes.includes(0)) section = `-- untracked binary file ${name} (${info.size} bytes) --`;
        else {
          section += `\n${text}${bytesRead < info.size ? `\n… ${info.size - bytesRead} more bytes not recorded` : ''}`;
          // Bytes that are not UTF-8 do not survive the record either.
          whole = bytesRead === info.size && Buffer.from(text, 'utf8').equals(bytes);
        }
      } finally { await handle.close(); }
    }
    if (!whole) unrecorded.push(name);
    sections.push(section); used += section.length + 1;
  }
  return { text: sections.join('\n'), unrecorded };
}

/**
 * Move the untracked files a record names but does not hold out of a worktree about to be cleaned
 * (GY-1215), into `aside`, keeping their relative paths. A file that cannot be kept rejects, so
 * the clean that would delete it never runs.
 */
export async function moveAside(path: string, names: string[], aside: string) {
  for (const name of names) {
    const from = resolve(path, name), to = resolve(aside, name);
    if (!await lstat(from).catch(() => null)) continue;
    await mkdir(dirname(to), { recursive: true });
    try { await rename(from, to); }
    catch { await cp(from, to, { recursive: true, verbatimSymlinks: true }); }
  }
}
