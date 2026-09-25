import type { Work } from './work.js';

// Kept free of Node built-ins: the coordination diagnostics read it, and they ship in the browser
// bundle. dispatch.ts re-exports it for its server-side readers.
const short = (sha: string) => sha.slice(0, 12);

/**
 * Why being behind the base withholds review and proofs of this head, or null when it does not.
 *
 * Being behind alone never does (GY-191). Main moves on every merge, so a rule that waited for a
 * head containing the tip stalled every candidate under load: nothing requested a review, and
 * nothing refreshed the head once its one refresh was spent. A candidate GitHub reports mergeable
 * against the current base is reviewed and proven as it stands; the merge queue integrates it with
 * the current base and re-tests the combined tip before anything merges (merge-queue.ts), so the
 * merge gate still requires a validated tip that contains the base. Only a head that does not
 * merge cleanly — GitHub reports a conflict, or has not yet computed mergeability — is withheld,
 * and that one goes back to its worker for a sync.
 */
export function behindBaseHold(work: Pick<Work, 'candidate' | 'observation' | 'baseRefresh' | 'policyRevision'>): string | null {
  const observation = work.observation, candidate = work.candidate;
  if (!observation || !candidate || observation.baseTipContained !== false) return null;
  // The control plane's own attempt to merge this tip in conflicted (merge-queue.ts baseRefreshConflict).
  const refresh = work.baseRefresh;
  if (refresh?.conflict && refresh.from.sha === candidate.sha && refresh.base === observation.baseTip && refresh.policyRevision === work.policyRevision)
    return `head ${short(candidate.sha)} does not contain the base tip ${short(observation.baseTip ?? '')} and cannot be brought onto it without resolving a conflict; it needs a sync before it can be reviewed`;
  if (observation.mergeable === true) return null;
  const why = observation.conflicting ? 'GitHub reports a merge conflict with that base' : 'GitHub does not report it mergeable against that base';
  return `head ${short(candidate.sha)} does not contain the base tip ${short(observation.baseTip ?? '')} and ${why}; it needs a sync before it can be reviewed`;
}
