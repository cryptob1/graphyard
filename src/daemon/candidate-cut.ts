// Concern: when the loop cuts the next release candidate itself (GY-1526) — at a count of merges since the newest cut, or at one merge left waiting.
import { candidateSettings } from '../master/merge-writer-settings.js';

/**
 * The cut rule for control-plane mode, where no workflow cron cuts candidates (GY-1526). A
 * candidate is due at `everyMerges` first-parent merges after the newest cut — the workflow's own
 * cap (GY-1491), so a candidate never implicates more changes than that — or as soon as one merge
 * after it has waited `idleMinutes`, so a lone merge on a quiet main reaches UAT within a quarter
 * of an hour rather than waiting for nine more. The rule is pure: the promotion ledger (the newest
 * candidates, newest first) and main's first-parent history (newest first, each commit with the
 * time it reached the branch) are read by the caller, which also decides whether a cut may run at
 * all (the promotion gap, the main watch's freeze, a candidate still under validation).
 */
export interface CutLedger { candidates?: readonly { id: string; sha: string; cutAt: string }[] | null }
export interface CutCommit { sha: string; at: string }
export type CutSettings = ReturnType<typeof candidateSettings>;
export interface CutAssessment {
  due: boolean;
  /** First-parent merges on main after the newest cut (every one, when nothing was cut yet). */
  merges: number;
  /** The oldest of those merges, by commit time, which is the one that has waited longest. */
  oldest: CutCommit | null;
  /** The newest cut the count starts after, or null when the ledger holds none. */
  since: { id: string; sha: string } | null;
  reason: string;
}

/** `run.candidates` with its defaults: the two thresholds the rule reads. */
export { candidateSettings } from '../master/merge-writer-settings.js';

const minutes = (ms: number) => Math.floor(ms / 60_000);
const age = (commit: CutCommit, now: number) => { const at = Date.parse(commit.at); return Number.isFinite(at) ? now - at : 0; };

/**
 * Pure: the merges after the newest cut and whether they make a candidate due at `now`. The newest
 * cut is the ledger's first candidate; the merges counted are main's first-parent commits ahead of
 * its SHA — all of the history when no cut is recorded or its SHA lies past the history read. A
 * merge is "old" by its commit time, the moment it reached main, never by when the loop looked.
 */
export function assessCut(ledger: CutLedger, mainHistory: readonly CutCommit[], now: number, settings: CutSettings): CutAssessment {
  const newest = ledger.candidates?.[0] ?? null;
  const since = newest ? { id: newest.id, sha: newest.sha.toLowerCase() } : null;
  const index = since ? mainHistory.findIndex(commit => commit.sha.toLowerCase() === since.sha) : -1;
  const merges = index >= 0 ? mainHistory.slice(0, index) : mainHistory;
  const oldest = merges.reduce<CutCommit | null>((top, commit) => !top || age(commit, now) > age(top, now) ? commit : top, null);
  const after = since ? `after candidate ${since.id}` : 'with no candidate cut yet';
  if (!merges.length) return { due: false, merges: 0, oldest: null, since, reason: `No merge has landed on main ${after}; nothing to cut` };
  const idleMs = settings.idleMinutes * 60_000, waited = oldest ? age(oldest, now) : 0;
  if (merges.length >= settings.everyMerges) return { due: true, merges: merges.length, oldest, since, reason: `${merges.length} merge(s) landed on main ${after}, at or past the ${settings.everyMerges}-merge cut` };
  if (waited >= idleMs) return { due: true, merges: merges.length, oldest, since, reason: `${merges.length} merge(s) landed on main ${after}; ${oldest!.sha.slice(0, 12)} has waited ${minutes(waited)} minute(s), at or past the ${settings.idleMinutes}-minute idle cut` };
  return { due: false, merges: merges.length, oldest, since, reason: `${merges.length} merge(s) landed on main ${after}; the next candidate is cut at ${settings.everyMerges} merges or once one has waited ${settings.idleMinutes} minutes (the oldest, ${oldest!.sha.slice(0, 12)}, has waited ${minutes(waited)})` };
}

/**
 * True when a candidate is due: `everyMerges` or more first-parent merges after the newest cut, or
 * at least one merge whose commit is `idleMinutes` or more old with no cut since (AC-1).
 */
export const cutDue = (ledger: CutLedger, mainHistory: readonly CutCommit[], now: number, settings: CutSettings) => assessCut(ledger, mainHistory, now, settings).due;
