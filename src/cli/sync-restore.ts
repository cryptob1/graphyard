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
 * `sync GY-N --restore` takes the remedy itself: one plain commit on top of the branch returns
 * every refused file to the base tip, so the PR updates with a plain push and no history is
 * rewritten. The scope is classified again after the commit, and the report says whether any file
 * still differs; one that does fails the command.
 */
export function restoreAndReport(git: Git, print: (value: unknown) => void, sync: {
  work: { key: string; plannedFiles?: string[] }; baseBranch: string; baseTip: string; regenerated: string[]; generated: string[]; refused: readonly string[];
}): void {
  const { work, baseBranch, baseTip, regenerated, generated } = sync;
  const restored = restoreOutOfScope(git, baseTip, sync.refused);
  const after = localScopeFindings(work.plannedFiles ?? [], git('diff', '--raw', '-M', '-z', '--no-abbrev', baseTip, 'HEAD'), git('diff', '--numstat', '-M', '-z', baseTip, 'HEAD'), generated);
  const still = after.filter(finding => finding.refused);
  print({ key: work.key, base: `origin/${baseBranch}`, baseTip, head: git('rev-parse', 'HEAD'), merged: true, regenerated, generated, plannedFiles: work.plannedFiles, ok: !still.length,
    restored, files: after, refused: still.map(finding => `${finding.path}: ${finding.detail}`),
    next: still.length ? `Some files outside plannedFiles still differ from origin/${baseBranch} after the restore commit; rerun sync ${work.key} --restore. A force push is never needed or allowed.`
      : `Restored ${restored.length} file${restored.length === 1 ? '' : 's'} to origin/${baseBranch} in one new commit. Push with a plain git push (a force push is never needed or allowed), then complete ${work.key} EPOCH PR.` });
  if (still.length) process.exitCode = 1;
}
