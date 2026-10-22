
import type { Work } from './model.js';

/**
 * Per open candidate, the other open candidates git itself cannot merge it with. The master reads
 * this to sequence merges: landing a candidate first forces every candidate it conflicts with
 * through a sync → review → proof round, so the smallest conflict set lands first and a pair that
 * conflicts is never left to discover it in the merge queue.
 *
 * The probe is `git merge-tree --write-tree` between the two candidate heads — a real three-way
 * merge from their merge base, done in memory, touching no worktree. It reports what git will
 * report at merge time; it does not judge semantic conflicts, and a candidate whose head this
 * checkout has not fetched is reported as unprobed rather than as conflict-free.
 */
export interface CandidateConflict { key: string; files: string[] }
export interface ConflictReport { conflicts: CandidateConflict[]; unprobed: string[] }
/** Why a pair was left unprobed, keyed `LEFT|RIGHT` (the two item keys, sorted): never conflict-free, always named. */
export type UnprobedReasons = Record<string, string>;
export const BUDGET_EXHAUSTED_REASON = 'probe budget exhausted';
export const PROBE_FAILED_REASON = 'head unavailable or probe failed';
/** `null` when either head is unavailable locally; otherwise the conflicted paths (empty when the merge is clean). */
export type ConflictProbe = (a: string, b: string) => string[] | null;

export const openCandidates = (work: Work[]) => work.filter(item => item.stage !== 'done' && !!item.submission && !!item.candidate?.sha);

function filesOverlap(filesA: readonly string[], filesB: readonly string[]): boolean {
  const isDirPrefix = (path: string) => path.endsWith('/');
  const pathMatches = (pattern: string, path: string): boolean => {
    if (pattern === path) return true;
    if (isDirPrefix(pattern)) return path.startsWith(pattern);
    // A file also overlaps everything beneath it: `foo` on one side and `foo/bar` on the other is
    // a real file/directory merge conflict, so the pair must be probed.
    if (path.startsWith(`${pattern}/`)) return true;
    return false;
  };
  return filesA.some(fileA =>
    filesB.some(fileB =>
      pathMatches(fileA, fileB) || pathMatches(fileB, fileA)
    )
  );
}

/** A probe the budget may consult without charging it: the pair's cached answer, or `undefined` when it has none. */
export type CachedProbe = (a: string, b: string) => string[] | null | undefined;
/** The budget a probe loop runs under. `elapsedMs` reads budget consumption from the budget's own
 *  opening — not from when the loop starts — so every phase inside it counts against the same budget. */
export interface ProbeBudget { timeoutMs?: number; elapsedMs?: () => number; peek?: CachedProbe }

export function candidateConflicts(work: Work[], probe: ConflictProbe, budget?: ProbeBudget, unprobedReasons?: UnprobedReasons): Record<string, ConflictReport> {
  const candidates = openCandidates(work);
  const report: Record<string, ConflictReport> = Object.fromEntries(candidates.map(item => [item.key, { conflicts: [], unprobed: [] }]));
  const timeoutMs = budget?.timeoutMs ?? Infinity;
  const mark = (left: Work, right: Work, reason: string) => {
    report[left.key].unprobed.push(right.key);
    report[right.key].unprobed.push(left.key);
    if (unprobedReasons) unprobedReasons[[left.key, right.key].sort().join('|')] = reason;
  };
  const record = (left: Work, right: Work, files: string[]) => {
    report[left.key].conflicts.push({ key: right.key, files });
    report[right.key].conflicts.push({ key: left.key, files });
  };

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const left = candidates[i], right = candidates[j];

      // Pairs whose changed files cannot intersect are never probed and never reported
      const leftFiles = left.observation?.files ?? [];
      const rightFiles = right.observation?.files ?? [];
      if (leftFiles.length && rightFiles.length && !filesOverlap(leftFiles, rightFiles)) {
        continue;
      }

      // A pair the cache can answer is the report however far the budget is spent: only the
      // uncached remainder pays the budget check.
      const cached = budget?.peek?.(left.candidate!.sha, right.candidate!.sha);
      if (cached !== undefined) {
        if (cached === null) { mark(left, right, PROBE_FAILED_REASON); continue; }
        if (cached.length) record(left, right, cached);
        continue;
      }

      // The budget bounds the probing phase: the clock handed in measures from the budget's
      // opening, so work that ran before this loop — a fetch, a cache read — counts against it
      // too. Once it is spent the remaining overlapping pairs are named unprobed with the
      // reason, never as conflict-free
      if (budget?.elapsedMs && budget.elapsedMs() >= timeoutMs) {
        mark(left, right, BUDGET_EXHAUSTED_REASON);
        continue;
      }

      const files = probe(left.candidate!.sha, right.candidate!.sha);
      if (files === null) { mark(left, right, PROBE_FAILED_REASON); continue; }
      if (!files.length) continue;
      record(left, right, files);
    }
  }
  return report;
}
