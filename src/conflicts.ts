import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
/** The probe ran only overlapping pairs, within its wall-clock budget; each pair it did not reach is named with its reason. */
export interface ConflictProbeResult {
  report: Record<string, ConflictReport>;
  available: boolean;
  reason: string | null;
  budgetMs: number;
  unprobedReasons: UnprobedReasons;
}
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

function getCachePath(cacheDir: string, shaA: string, shaB: string): string {
  const key = [shaA, shaB].sort().join('-');
  return join(cacheDir, `${key}.json`);
}

async function writeCache(cacheDir: string, shaA: string, shaB: string, result: string[] | null): Promise<void> {
  try {
    await mkdir(cacheDir, { recursive: true });
    const cachePath = getCachePath(cacheDir, shaA, shaB);
    await writeFile(cachePath, JSON.stringify({ result, at: new Date().toISOString() }), 'utf8');
  } catch {
    // Cache write failures are non-fatal
  }
}

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

      // Pairs whose planned or changed files cannot intersect are never probed and never reported
      const leftFiles = left.plannedFiles ?? [];
      const rightFiles = right.plannedFiles ?? [];
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

type Run = (command: string, args: string[], timeoutMs?: number) => string;
const gitRun: Run = (command, args, timeoutMs) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs ?? 60_000 });

/**
 * Bring every open candidate head into this checkout. One fetch of the registered PR branches;
 * a head that is still missing afterwards (force-pushed, branch deleted, network down) is left
 * for the probe to report as unprobed. Nothing here writes a worktree or a local branch. Within
 * the budgeted probe the run handed in is bounded, so the fetch — a network call — takes only
 * what the budget still has and a fetch the deadline kills is reported, never retried here.
 */
export function fetchCandidateHeads(root: string, work: Work[], run: Run = gitRun): { fetched: boolean; reason: string | null } {
  const branches = [...new Set(openCandidates(work).map(item => item.candidate!.branch).filter(Boolean))];
  if (!branches.length) return { fetched: true, reason: null };
  try { run('git', ['-C', root, 'fetch', '--quiet', '--no-tags', 'origin', ...branches.map(branch => `+refs/heads/${branch}:refs/remotes/origin/${branch}`)]); return { fetched: true, reason: null }; }
  catch (error) { return { fetched: false, reason: `Candidate heads could not be fetched: ${error instanceof Error ? error.message.split('\n')[0] : 'git fetch failed'}` }; }
}

/** The in-memory merge probe over this checkout's object store. */
export function gitConflictProbe(root: string, run: Run = gitRun): ConflictProbe {
  const present = (sha: string) => { try { run('git', ['-C', root, 'cat-file', '-e', `${sha}^{commit}`]); return true; } catch { return false; } };
  return (a, b) => {
    if (!present(a) || !present(b)) return null;
    try { run('git', ['-C', root, 'merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', a, b]); return []; }
    catch (error: any) {
      // Exit 1 is git's "merged with conflicts"; its stdout is the tree id followed by the
      // conflicted paths, NUL-separated. Anything else is a probe failure, not a clean merge.
      if (error?.status !== 1 || typeof error.stdout !== 'string') return null;
      return error.stdout.split('\0').slice(1).filter(Boolean);
    }
  };
}

/**
 * What `master status` reports: the conflict sets probed in memory over the fetched PR heads; an
 * unfetchable head is unprobed, never conflict-free. Each overlapping pair's result is cached on
 * disk by its two head shas and reused until either head changes; only overlapping pairs are read
 * back or written, so neither pass grows with the backlog beyond the pairs the budget can reach.
 * A `null` result — a head that was not present when probed — is held only in memory for this call
 * and never persisted: the head may arrive with the next fetch, and a persisted null would pin the
 * pair as unprobed until one of its heads changed. The whole call answers inside its budget: the
 * clock opens before any work, the candidate-head fetch is a network git call like any other and
 * is killed at the deadline, and every pair left unprobed is named with its reason. The disk
 * cache is read before the fetch — the reads are local and stop once the budget is spent — so a
 * pair it can answer is reported even when the fetch has eaten the rest of the budget.
 */
export async function probeCandidateConflictsWithBudget(root: string, work: Work[], dataDir: string, run: Run = gitRun, timeoutMs: number = 10_000): Promise<ConflictProbeResult> {
  // The budget opens before anything runs, the fetch included: every git call this function makes
  // is handed only the time the budget still has, so no single call — the fetch above all — can
  // hold the report past it.
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const spent = () => Date.now() - startedAt > timeoutMs;
  const boundedRun: Run = (command, args) => {
    // A call that would outlive the deadline is killed at it, so one slow git invocation cannot
    // hold the report past the budget; the killed call lands in unprobed with its reason.
    return run(command, args, Math.max(1, deadline - Date.now()));
  };

  const cache = new Map<string, string[] | null>();
  const getCacheKey = (a: string, b: string) => [a, b].sort().join('-');

  const cacheDir = join(dataDir, 'conflict-probes');
  try {
    await mkdir(cacheDir, { recursive: true });
  } catch {
    // Cache directory creation failure is non-fatal; caching is a best-effort optimization
  }

  const readCached = (a: string, b: string): string[] | null | undefined => {
    try {
      return JSON.parse(readFileSync(getCachePath(cacheDir, a, b), 'utf8')).result;
    } catch {
      return undefined;
    }
  };

  // Pre-populate the in-memory cache from disk for the pairs the probe can reach: the ones whose
  // planned or changed files overlap. The reads are local and stop once the budget is spent; the
  // pairs this loop answers stay answerable however far the budget is spent afterwards, the fetch
  // included.
  const candidates = openCandidates(work);
  overlap: for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const left = candidates[i], right = candidates[j];
      const leftFiles = left.plannedFiles ?? [], rightFiles = right.plannedFiles ?? [];
      if (leftFiles.length && rightFiles.length && !filesOverlap(leftFiles, rightFiles)) continue;
      if (spent()) break overlap;
      const cached = readCached(left.candidate!.sha, right.candidate!.sha);
      if (cached !== undefined && cached !== null) cache.set(getCacheKey(left.candidate!.sha, right.candidate!.sha), cached);
    }
  }

  // The heads come in second, on the time the cache reads have left: a fetch the deadline kills
  // leaves its heads absent, and the probe reports those pairs unprobed rather than conflict-free.
  const fetched = fetchCandidateHeads(root, work, boundedRun);

  const base = gitConflictProbe(root, boundedRun);

  const writes: Array<[string, string]> = [];
  const probeWithCache: ConflictProbe = (a, b) => {
    const key = getCacheKey(a, b);
    if (cache.has(key)) return cache.get(key)!;
    writes.push([a, b]);
    const result = base(a, b);
    cache.set(key, result);
    return result;
  };
  const peekCached: CachedProbe = (a, b) => {
    const key = getCacheKey(a, b);
    return cache.has(key) ? cache.get(key)! : undefined;
  };

  const unprobedReasons: UnprobedReasons = {};
  const report = candidateConflicts(work, probeWithCache, { timeoutMs, elapsedMs: () => Date.now() - startedAt, peek: peekCached }, unprobedReasons);

  // Write cache to disk; a null result is never persisted (see above).
  for (const [a, b] of writes) {
    const result = cache.get(getCacheKey(a, b));
    if (result !== undefined && result !== null) {
      await writeCache(cacheDir, a, b, result);
    }
  }

  return { report, available: fetched.fetched, reason: fetched.reason, budgetMs: timeoutMs, unprobedReasons };
}
