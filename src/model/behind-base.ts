import type { Work } from './work.js';

// Kept free of Node built-ins: the coordination diagnostics read it, and they ship in the browser
// bundle. dispatch.ts re-exports it for its server-side readers.
const short = (sha: string) => sha.slice(0, 12);

type Held = Pick<Work, 'candidate' | 'observation' | 'baseRefresh' | 'policyRevision'>;
/** The control plane's own test merge of the current head onto the observed base tip, when it conflicted (model/base-refresh.ts baseRefreshConflict); else null. */
function confirmedConflict(work: Held) {
  const refresh = work.baseRefresh, candidate = work.candidate, observation = work.observation;
  return refresh?.conflict && candidate && observation && refresh.from.sha === candidate.sha && refresh.base === observation.baseTip && refresh.policyRevision === work.policyRevision ? refresh : null;
}

/**
 * Why being behind the base withholds review and proofs of this head, or null when it does not.
 *
 * Being behind alone never does (GY-191). Main moves on every merge, so a rule that waited for a
 * head containing the tip stalled every candidate under load: nothing requested a review, and
 * nothing refreshed the head once its one refresh was spent. A candidate GitHub reports mergeable
 * against the current base is reviewed and proven as it stands, and GitHub integrates it with the
 * current base when it merges. Only a head that does not
 * merge cleanly — GitHub reports a conflict, or has not yet computed mergeability — is withheld,
 * and that one goes back to its worker for a sync.
 */
export function behindBaseHold(work: Held): string | null {
  const observation = work.observation, candidate = work.candidate;
  if (!observation || !candidate || observation.baseTipContained !== false) return null;
  if (confirmedConflict(work))
    return `head ${short(candidate.sha)} does not contain the base tip ${short(observation.baseTip ?? '')} and cannot be brought onto it without resolving a conflict; it needs a sync before it can be reviewed`;
  if (observation.mergeable === true) return null;
  const why = observation.conflicting ? 'GitHub reports a merge conflict with that base' : 'GitHub does not report it mergeable against that base';
  return `head ${short(candidate.sha)} does not contain the base tip ${short(observation.baseTip ?? '')} and ${why}; it needs a sync before it can be reviewed`;
}

/**
 * When the hold on the candidate's current head was first sighted (GY-1557): set by the observation
 * write at the first observation that reads the head withheld (behindBaseHold), kept while the hold
 * stands on that head — a base that moves again under a conflicting head rewrites the observation's
 * tip, not the sighting — and cleared by an observation that reads the hold gone. A hold on a new
 * head is a new sighting.
 */
export interface BaseHold { sha: string; at: string }
declare module './work.js' { interface Work { baseHold?: BaseHold | null } }
export function observeBaseHold(work: Work, at: string) {
  const candidate = work.candidate;
  if (!candidate || !behindBaseHold(work)) { if (work.baseHold) work.baseHold = null; return; }
  if (work.baseHold?.sha !== candidate.sha) work.baseHold = { sha: candidate.sha, at };
}
