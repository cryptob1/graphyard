import { baseRefreshConflict } from '../merge-queue.js';
import type { Work } from './work.js';

/**
 * GY-1434. The bound within which the loop's decisions step requests the rework a recorded base
 * conflict calls for on a system-driven item: one decision cycle after the conflict grounds are
 * recorded, at most ten minutes. The request is the loop's alone (a hand rework of it is refused),
 * so nothing it does first may outlast the bound: a docs-sync session that has not moved the head
 * by then gives the conflict up, and past it `master status` names the step as stalled. On 7
 * October 2026 GY-1419's candidate 69dcd419da45 conflicted on three successive base tips while a
 * docs-sync session held it for its whole 30-minute bound and no rework was requested for 35 minutes.
 */
export const conflictReworkBoundMs = 10 * 60_000;
export interface ConflictReworkDue {
  /** The grounds binding the loop requests the round under (`${sha}:conflict`). */
  binding: string;
  /** When the conflict was first recorded on this head (`conflictSince`), standing on every base tip since. */
  since: string; dueAt: string;
  /** How far past the bound the round is; 0 while it is still due. */
  overdueMs: number;
}
/** The loop-owned conflict rework a system-driven item is owed and when it falls due, or null when none is owed. */
export function conflictReworkDue(work: Pick<Work, 'stage' | 'systemDriven' | 'reworkRequested' | 'candidate' | 'observation' | 'baseRefresh' | 'policyRevision'>, now: number): ConflictReworkDue | null {
  if (work.stage === 'done' || work.systemDriven !== true || work.reworkRequested || !baseRefreshConflict(work)) return null;
  const since = work.baseRefresh!.conflictSince ?? work.baseRefresh!.at, at = Date.parse(since);
  if (!Number.isFinite(at)) return null;
  const due = at + conflictReworkBoundMs;
  return { binding: `${work.candidate!.sha}:conflict`, since, dueAt: new Date(due).toISOString(), overdueMs: Math.max(0, now - due) };
}
