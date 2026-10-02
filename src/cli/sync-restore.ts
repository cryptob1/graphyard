import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { localScopeFindings } from '../sync.js';

type Git = (...args: string[]) => string;

/**
 * Returns every refused path to its version at the base tip in one new commit whose message names
 * the files (GY-859): a path the base holds is restored — including a rename's original path or a
 * deleted file — and one the base does not hold is removed. Nothing already committed is rewritten,
 * so the branch stays a fast-forward of the pushed one. Returns the paths the commit touched, or
 * none when there was nothing to restore.
 *
 * Every command reads the names as literal pathspecs (GY-1080): a refused file named like pathspec
 * magic, such as `:(top)**`, must never widen the restore to in-scope files. Submodules are restored
 * recursively, so the checkout matches the base gitlink the path-limited commit then records.
 */
export function restoreOutOfScope(git: Git, baseTip: string, refused: readonly string[]): string[] {
  const paths = [...new Set(refused)].sort();
  if (!paths.length) return [];
  git('--literal-pathspecs', 'restore', `--source=${baseTip}`, '--staged', '--worktree', '--recurse-submodules', '--', ...paths);
  if (!git('--literal-pathspecs', 'diff', '--cached', '--name-only', '--', ...paths)) return [];
  git('--literal-pathspecs', 'commit', '--quiet', '-m', `Restore out-of-scope files to the base branch: ${paths.join(', ')}`, '--', ...paths);
  return paths;
}

/**
 * Names each refused submodule whose base gitlink commit is not in its checked-out clone, with the
 * fetch that brings it in (GY-1080): `restore --recurse-submodules` cannot check out a commit the
 * clone never fetched, and a raw git error would not say which submodule or what to run. A
 * submodule that is not checked out has no clone to move, so it is never missing a commit.
 */
export function missingSubmoduleCommits(git: Git, baseTip: string, refused: readonly string[]): { path: string; commit: string; fetch: string }[] {
  const paths = [...new Set(refused)].sort();
  if (!paths.length) return [];
  const top = git('rev-parse', '--show-toplevel');
  const listing = git('--literal-pathspecs', 'ls-tree', '-z', baseTip, '--', ...paths);
  const missing: { path: string; commit: string; fetch: string }[] = [];
  for (const entry of listing.split('\0').filter(Boolean)) {
    const match = /^160000 commit ([0-9a-f]+)\t(.*)$/s.exec(entry);
    if (!match) continue;
    const [, commit, path] = match;
    if (!existsSync(join(top, path, '.git'))) continue;
    try { git('-C', join(top, path), 'cat-file', '-e', `${commit}^{commit}`); }
    catch { missing.push({ path, commit, fetch: `git -C ${path} fetch origin ${commit}` }); }
  }
  return missing;
}

/**
 * `sync GY-N --restore` takes the remedy itself: one plain commit on top of the branch returns
 * every refused file to the base tip, so the PR updates with a plain push and no history is
 * rewritten. The scope is classified again after the commit, and the report says whether any file
 * still differs; one that does fails the command.
 */
export function restoreAndReport(git: Git, print: (value: unknown) => void, sync: {
  work: { key: string; plannedFiles?: string[] }; baseBranch: string; baseTip: string; regenerated: string[]; generated: string[]; refused: readonly string[];
}): void {
  const { work, baseBranch, baseTip, regenerated, generated } = sync;
  const missing = missingSubmoduleCommits(git, baseTip, sync.refused);
  if (missing.length) {
    print({ key: work.key, base: `origin/${baseBranch}`, baseTip, head: git('rev-parse', 'HEAD'), merged: true, regenerated, generated, plannedFiles: work.plannedFiles, ok: false,
      restored: [], missingSubmoduleCommits: missing, refused: [...sync.refused],
      next: `Nothing was restored: ${missing.map(({ path, commit }) => `submodule ${path} does not hold the base commit ${commit.slice(0, 12)}`).join('; ')}. Run ${missing.map(({ fetch }) => fetch).join(' && ')}, then rerun sync ${work.key} --restore. A force push is never needed or allowed.` });
    process.exitCode = 1;
    return;
  }
  const restored = restoreOutOfScope(git, baseTip, sync.refused);
  const after = localScopeFindings(work.plannedFiles ?? [], git('diff', '--raw', '-M', '-z', '--no-abbrev', baseTip, 'HEAD'), git('diff', '--numstat', '-M', '-z', baseTip, 'HEAD'), generated);
  const still = after.filter(finding => finding.refused);
  print({ key: work.key, base: `origin/${baseBranch}`, baseTip, head: git('rev-parse', 'HEAD'), merged: true, regenerated, generated, plannedFiles: work.plannedFiles, ok: !still.length,
    restored, files: after, refused: still.map(finding => `${finding.path}: ${finding.detail}`),
    next: still.length ? `Some files outside plannedFiles still differ from origin/${baseBranch} after the restore commit; rerun sync ${work.key} --restore. A force push is never needed or allowed.`
      : `Restored ${restored.length} file${restored.length === 1 ? '' : 's'} to origin/${baseBranch} in one new commit. Push with a plain git push (a force push is never needed or allowed), then complete ${work.key} EPOCH PR.` });
  if (still.length) process.exitCode = 1;
}
