// Concern: which system-driven items only wait for the loop's own post-deploy reading (GY-1762).
import { servingReleaseProof, type ObservationWindow, type Work } from './work.js';
import { postDeployProof } from './post-merge-proofs.js';
import { followUpRequest } from './observation-window.js';
import { evidenceProves } from './mechanical-proofs.js';

/**
 * GY-1762: the proofs of a loop-owned observation item, or null for any other item. The class never
 * leaves worker dispatch, before or after its reading is recorded: a recorded reading ends the wait,
 * not the fact that there is no code for a worker to write.
 */
export function loopObservationProofs(work: Pick<Work, 'systemDriven' | 'criteria' | 'stage' | 'description'>): string[] | null {
  if (work.systemDriven !== true || work.stage === 'done' || !work.criteria.length) return null;
  const proofs = work.criteria.flatMap(criterion => criterion.proofs);
  // A `-on-serving-release` proof alone is not the class (createSchema admits it on a head-anchored code criterion): the item must carry the filer's structured `Post-deploy follow-up:` request identity, not wording a criterion can imitate.
  const observed = (criterion: { proofs: string[] }) => criterion.proofs.every(proof => postDeployProof(proof) || (servingReleaseProof(proof) && !!followUpRequest(work)));
  if (!proofs.length || work.criteria.some(criterion => !criterion.proofs.length || !observed(criterion))) return null;
  return proofs;
}
/**
 * GY-1762: what a loop-owned observation item waits for, or null. A system-driven item whose every
 * criterion is a manual post-deploy proof (declared `manual:post-deploy/…` or a follow-up's
 * `…-on-serving-release`) has no code for a worker to write: its only work is the live reading the
 * loop records. It holds no worker while the reading is unrecorded: before its observation window
 * closes it waits for the instant (`due: false`); from then on, or with no window, the reading is
 * due (`due: true`): the loop's deployment-verification step records it (daemon/cycle-readings.ts,
 * GY-1779), never a dispatched worker and never an operator. Only a recorded trusted reading ends
 * the wait. With a code criterion, or any other proof, it is dispatched as before.
 */
export function loopObservation(work: Pick<Work, 'systemDriven' | 'criteria' | 'evidence' | 'stage' | 'policyRevision' | 'description'> & { observationWindow?: ObservationWindow | null }, now: Date, all: readonly Pick<Work, 'id' | 'delivery'>[] = []): { waitingFor: string; due: boolean } | null {
  const proofs = loopObservationProofs(work);
  if (!proofs) return null;
  const window = work.observationWindow;
  // Only a passing, unexpired, current-policy reading, as postDeployChecks reads it, ends the wait: of the follow-up's full serving release, bound to the parent delivery's merge, with nothing skipped, taken once its window opened.
  // A follow-up whose parent is not among `all` has no merge to bind a reading to, so its wait stands.
  const request = followUpRequest(work), parent = request && all.find(entry => entry.id === request.work)?.delivery;
  // GY-1779: the loop's own reading (`reading`, recorded through the coordinator's `reading` command) is bound to the release the control plane observed serving the parent's merge when it was taken, which a plane that has moved past the follow-up's filing release serves instead.
  const bound = (entry: Work['evidence'][number]) => !request || (!!parent && entry.baseSha === parent.mergeSha && (entry.sha === request.release || !!entry.reading));
  // The newest such reading decides: a later failed or expired reading of the same proof and release withdraws an earlier pass.
  const recorded = (proof: string) => {
    const readings = work.evidence.filter(entry => entry.proof === proof && entry.trusted && !entry.revocation && entry.policyRevision === work.policyRevision
      && bound(entry) && (!window || Date.parse(entry.at) >= Date.parse(window.notBefore)));
    const latest = readings.reduce<typeof readings[number] | null>((best, entry) => !best || Date.parse(entry.at) >= Date.parse(best.at) ? entry : best, null);
    return !!latest && evidenceProves(proof, latest) && (!latest.expiresAt || Date.parse(latest.expiresAt) > now.getTime());
  };
  if (proofs.every(recorded)) return null;
  const due = !window || Date.parse(window.notBefore) <= now.getTime();
  // GY-1779: a due reading is the loop's to record in its deployment-verification step, never owed to an operator.
  return { due, waitingFor: due ? `the loop's reading of ${proofs.join(', ')} on the serving release, which is due and which the loop records in its deployment-verification step` : `the loop's reading of ${proofs.join(', ')}, which can first exist at ${window!.notBefore} (${window!.detail})` };
}
