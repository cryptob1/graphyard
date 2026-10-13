// Concern: which system-driven items only wait for the loop's own post-deploy reading (GY-1762).
import { servingReleaseProof, type ObservationWindow, type Work } from './work.js';
import { postDeployProof } from './post-merge-proofs.js';

/**
 * GY-1762: the proofs of a loop-owned observation item, or null for any other item. The class never
 * leaves worker dispatch, before or after its reading is recorded: a recorded reading ends the wait,
 * not the fact that there is no code for a worker to write.
 */
const followUpReading = /^From this head against the serving release [0-9a-f]+ that carries /;
export function loopObservationProofs(work: Pick<Work, 'systemDriven' | 'criteria' | 'stage'>): string[] | null {
  if (work.systemDriven !== true || work.stage === 'done' || !work.criteria.length) return null;
  const proofs = work.criteria.flatMap(criterion => criterion.proofs);
  // A `-on-serving-release` proof alone is not the class (createSchema admits it on a head-anchored code criterion): the criterion must be the follow-up's own filed text.
  const observed = (criterion: { text: string; proofs: string[] }) => criterion.proofs.every(proof => postDeployProof(proof) || (servingReleaseProof(proof) && followUpReading.test(criterion.text)));
  if (!proofs.length || work.criteria.some(criterion => !criterion.proofs.length || !observed(criterion))) return null;
  return proofs;
}
/**
 * GY-1762: what a loop-owned observation item waits for, or null. A system-driven item whose every
 * criterion is a manual post-deploy proof (declared `manual:post-deploy/…` or a follow-up's
 * `…-on-serving-release`) has no code for a worker to write: its only work is the live reading the
 * loop records. It holds no worker while the reading is unrecorded: before its observation window
 * closes it waits for the instant (`due: false`); from then on, or with no window, the reading is
 * owed now (`due: true`) and the item is escalated for it, never dispatched. Only a recorded trusted
 * reading ends the wait. With a code criterion, or any other proof, it is dispatched as before.
 */
export function loopObservation(work: Pick<Work, 'systemDriven' | 'criteria' | 'evidence' | 'stage' | 'policyRevision'> & { observationWindow?: ObservationWindow | null }, now: Date): { waitingFor: string; due: boolean } | null {
  const proofs = loopObservationProofs(work);
  if (!proofs) return null;
  const window = work.observationWindow;
  // Only a passing, unexpired, current-policy reading of the serving release the follow-up names, taken once its window opened, ends the wait.
  const release = work.criteria.map(criterion => /serving release ([0-9a-f]{12})/.exec(criterion.text)?.[1]).find(Boolean);
  // The newest such reading decides: a later failed or expired reading of the same proof and release withdraws an earlier pass.
  const recorded = (proof: string) => {
    const readings = work.evidence.filter(entry => entry.proof === proof && entry.trusted && !entry.revocation && entry.policyRevision === work.policyRevision
      && (!release || entry.sha.startsWith(release)) && (!window || Date.parse(entry.at) >= Date.parse(window.notBefore)));
    const latest = readings.reduce<typeof readings[number] | null>((best, entry) => !best || Date.parse(entry.at) >= Date.parse(best.at) ? entry : best, null);
    return !!latest && latest.result === 'pass' && (!latest.expiresAt || Date.parse(latest.expiresAt) > now.getTime());
  };
  if (proofs.every(recorded)) return null;
  const due = !window || Date.parse(window.notBefore) <= now.getTime();
  return { due, waitingFor: due ? `the loop's reading of ${proofs.join(', ')} on the serving release, which is owed now` : `the loop's reading of ${proofs.join(', ')}, which can first exist at ${window!.notBefore} (${window!.detail})` };
}
