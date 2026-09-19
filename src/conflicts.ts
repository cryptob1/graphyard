import { execFileSync } from 'node:child_process';
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

export function candidateConflicts(work: Work[], probe: ConflictProbe): Record<string, ConflictReport> {
  const candidates = openCandidates(work);
  const report: Record<string, ConflictReport> = Object.fromEntries(candidates.map(item => [item.key, { conflicts: [], unprobed: [] }]));
  for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
    const left = candidates[i], right = candidates[j];
    const files = probe(left.candidate!.sha, right.candidate!.sha);
    if (files === null) { report[left.key].unprobed.push(right.key); report[right.key].unprobed.push(left.key); continue; }
    if (!files.length) continue;
    report[left.key].conflicts.push({ key: right.key, files }); report[right.key].conflicts.push({ key: left.key, files });
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
