import type { Work } from './work.js';
import type {} from './merge-ledger.js'; // Work.mergeLedger

/** The ground's name, as the binding of the rework the loop applies names it (`<head>:merge-writer-trial-failed`). */
export const mergeWriterTrialGround = 'merge-writer-trial-failed';
/**
 * How the merge writer's `merge.refused` reason opens when the trial of the head failed (a conflict,
 * a failed build step or failing tests), as against a push the base moved under (`base moved N
 * times`), which refuses nothing about the head and leaves it queued.
 */
export const trialFailurePrefix = 'trial failed';

/**
 * GY-1524. The ground a failed trial of the current head gives: the control plane's own merge
 * writer trial-merged exactly this candidate onto the base tip, built and ran its tests, and
 * recorded `merge.refused` naming what failed (model/merge-ledger.ts). Nothing but a new head can
 * pass that trial.
 * A refusal for another head, a revert refusal, or a `base moved` refusal grounds nothing.
 */
export function trialFailedGround(work: Pick<Work, 'candidate' | 'mergeLedger'>): string | null {
  const ledger = work.mergeLedger, candidate = work.candidate;
  if (!ledger || !candidate || ledger.state !== 'refused' || !ledger.refusal || ledger.refusal.kind !== 'merge') return null;
  if (ledger.head?.toLowerCase() !== candidate.sha.toLowerCase() || !ledger.refusal.reason.startsWith(trialFailurePrefix)) return null;
  return `the merge writer's trial of candidate ${candidate.sha.slice(0, 12)} failed (${ledger.refusal.reason})`;
}
