import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
/** `null` when either head is unavailable locally; otherwise the conflicted paths (empty when the merge is clean). */
export type ConflictProbe = (a: string, b: string) => string[] | null;

export const openCandidates = (work: Work[]) => work.filter(item => item.stage !== 'done' && !!item.submission && !!item.candidate?.sha);

function filesOverlap(filesA: readonly string[], filesB: readonly string[]): boolean {
  const isDirPrefix = (path: string) => path.endsWith('/');
  const pathMatches = (pattern: string, path: string): boolean => {
    if (pattern === path) return true;
    if (isDirPrefix(pattern)) return path.startsWith(pattern);
    return false;
  };
  return filesA.some(fileA =>
    filesB.some(fileB =>
      pathMatches(fileA, fileB) || pathMatches(fileB, fileA)
    )
  );
}

export interface ProbeBudget { timeoutMs?: number; elapsedMs?: () => number }

function getCachePath(cacheDir: string, shaA: string, shaB: string): string {
  const key = [shaA, shaB].sort().join('-');
  return join(cacheDir, `${key}.json`);
}

async function readCache(cacheDir: string, shaA: string, shaB: string): Promise<string[] | null | undefined> {
  try {
    const cachePath = getCachePath(cacheDir, shaA, shaB);
    const data = await readFile(cachePath, 'utf8');
    const cached = JSON.parse(data);
    return cached.result;
  } catch {
    return undefined;
  }
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

export function candidateConflicts(work: Work[], probe: ConflictProbe, budget?: ProbeBudget): Record<string, ConflictReport> {
  const candidates = openCandidates(work);
  const report: Record<string, ConflictReport> = Object.fromEntries(candidates.map(item => [item.key, { conflicts: [], unprobed: [] }]));
  const startTime = budget?.elapsedMs?.() ?? 0;
  const timeoutMs = budget?.timeoutMs ?? Infinity;

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const left = candidates[i], right = candidates[j];

      // Skip pairs with no file overlap (always, regardless of budget)
      const leftFiles = left.plannedFiles ?? [];
      const rightFiles = right.plannedFiles ?? [];
      if (leftFiles.length && rightFiles.length && !filesOverlap(leftFiles, rightFiles)) {
        continue;
      }

      // Check budget after overlap check, so non-overlapping pairs never appear in unprobed
      if (budget?.elapsedMs) {
        const elapsed = budget.elapsedMs() - startTime;
        if (elapsed > timeoutMs) {
          report[left.key].unprobed.push(right.key);
          report[right.key].unprobed.push(left.key);
          continue;
        }
      }

      const files = probe(left.candidate!.sha, right.candidate!.sha);
      if (files === null) { report[left.key].unprobed.push(right.key); report[right.key].unprobed.push(left.key); continue; }
      if (!files.length) continue;
      report[left.key].conflicts.push({ key: right.key, files }); report[right.key].conflicts.push({ key: left.key, files });
    }
  }
  return report;
}

type Run = (command: string, args: string[]) => string;
const gitRun: Run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });

/**
 * Bring every open candidate head into this checkout. One fetch of the registered PR branches;
 * a head that is still missing afterwards (force-pushed, branch deleted, network down) is left
 * for the probe to report as unprobed. Nothing here writes a worktree or a local branch.
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
 * disk by its two head shas and reused until either head changes. A `null` result — a head that
 * was not present when probed — is held only in memory for this call and never persisted: the
 * head may arrive with the next fetch, and a persisted null would pin the pair as unprobed until
 * one of its heads changed.
 */
export async function probeCandidateConflictsWithBudget(root: string, work: Work[], dataDir: string, run: Run = gitRun, timeoutMs: number = 10_000) {
  const fetched = fetchCandidateHeads(root, work, run);
  const base = gitConflictProbe(root, run);
  const cache = new Map<string, string[] | null>();
  const getCacheKey = (a: string, b: string) => [a, b].sort().join('-');

  const cacheDir = join(dataDir, 'conflict-probes');
  try {
    await mkdir(cacheDir, { recursive: true });
  } catch {
    // Cache directory creation failure is non-fatal; caching is a best-effort optimization
  }

  const probeWithCache: ConflictProbe = (a, b) => {
    const key = getCacheKey(a, b);
    if (cache.has(key)) return cache.get(key)!;
    const result = base(a, b);
    cache.set(key, result);
    return result;
  };

  // Pre-populate cache from disk
  const candidates = openCandidates(work);
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const left = candidates[i], right = candidates[j];
      const key = getCacheKey(left.candidate!.sha, right.candidate!.sha);
      const cached = await readCache(cacheDir, left.candidate!.sha, right.candidate!.sha);
      if (cached !== undefined && cached !== null) {
        cache.set(key, cached);
      }
    }
  }

  const startTime = Date.now();
  const elapsedMs = () => Date.now() - startTime;

  const report = candidateConflicts(work, probeWithCache, { timeoutMs, elapsedMs });

  // Write cache to disk
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const left = candidates[i], right = candidates[j];
      const key = getCacheKey(left.candidate!.sha, right.candidate!.sha);
      const result = cache.get(key);
      if (result !== undefined && result !== null) {
        await writeCache(cacheDir, left.candidate!.sha, right.candidate!.sha, result);
      }
    }
  }

  return { report, available: fetched.fetched, reason: fetched.reason };
}
