import type { ScopeFile } from './model.js';
import { classifyScope, type ScopeFinding } from './regression-guard.js';

/**
 * Local half of the regression guard, for `graphyard sync`. Parses `git diff --raw -M -z
 * --no-abbrev BASE HEAD` and `git diff --numstat -M -z BASE HEAD`, both taken directly against
 * the fetched base tip, into the same file records the control plane derives from the provider.
 * Every record here already differs from the base tip; the classifier decides which are allowed.
 */
const statuses: Record<string, ScopeFile['status']> = { A: 'added', D: 'removed', M: 'modified', R: 'renamed', C: 'copied', T: 'changed' };
const zero = /^0+$/;
export function parseLocalScopeDiff(raw: string, numstat: string): ScopeFile[] {
  const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  const numstatTokens = numstat.split('\0');
  for (let i = 0; i < numstatTokens.length; i++) {
    const match = numstatTokens[i].match(/^(\d+|-)\t(\d+|-)\t(.*)$/s);
    if (!match) continue;
    const binary = match[1] === '-';
    // A rename carries an empty path followed by the old and new paths as separate tokens.
    const path = match[3] !== '' ? match[3] : numstatTokens[(i += 2)];
    counts.set(path, { additions: binary ? 0 : Number(match[1]), deletions: binary ? 0 : Number(match[2]), binary });
  }
  const files: ScopeFile[] = [];
  const tokens = raw.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const header = tokens[i].match(/^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/);
    if (!header) continue;
    const [, , , oldSha, newSha, code] = header;
    const status = statuses[code] ?? 'modified';
    const moved = code === 'R' || code === 'C';
    const previousPath = moved ? tokens[++i] : undefined;
    const path = tokens[++i];
    const count = counts.get(path) ?? { additions: 0, deletions: 0, binary: false };
    const file: ScopeFile = { path, status, sha: zero.test(newSha) ? null : newSha, additions: count.additions, deletions: count.deletions, binary: count.binary,
      // The diff is against the base tip itself: the old side is exactly what the base holds.
      baseSha: moved ? null : zero.test(oldSha) ? null : oldSha };
    if (previousPath) { file.previousPath = previousPath; file.previousBaseSha = zero.test(oldSha) ? null : oldSha; }
    files.push(file);
  }
  return files;
}

export function localScopeFindings(plannedFiles: string[], raw: string, numstat: string): ScopeFinding[] {
  return classifyScope(plannedFiles, parseLocalScopeDiff(raw, numstat));
}
