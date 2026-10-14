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
type Reading = Work['evidence'][number];
type Observed = Pick<Work, 'systemDriven' | 'criteria' | 'evidence' | 'stage' | 'policyRevision' | 'description'> & { observationWindow?: ObservationWindow | null };
const newest = <T extends { at: string }>(entries: readonly T[]) => entries.reduce<T | null>((best, entry) => !best || Date.parse(entry.at) >= Date.parse(best.at) ? entry : best, null);

/**
 * GY-1779: the loop's newest own reading of `proof` on `release` (`reading`, recorded through the
 * coordinator's `reading` command): trusted, unrevoked, at the item's current policy revision. A
 * close that failed is retried on it without a second record, and a result it already gives is not
 * recorded twice; the hand path records the proof without one.
 */
export const loopReadingOn = (work: Pick<Work, 'evidence' | 'policyRevision'>, proof: string, release: string): Reading | undefined =>
  newest(work.evidence.filter(entry => entry.proof === proof && entry.trusted && !entry.revocation && !!entry.reading && entry.sha === release && entry.policyRevision === work.policyRevision)) ?? undefined;

/**
 * GY-1779: the recorded passing readings that end a loop-owned observation item's wait, one per
 * proof, and the release the newest was taken on — the release its `delivered-observation` closure
 * names and the loop closes it on — or null while the wait stands or for any other item. Only a
 * passing, unexpired, current-policy reading, as postDeployChecks reads it, counts: of the follow-up's
 * filed serving release or marked as the loop's own on the later release the control plane served,
 * bound to the parent delivery's merge, with nothing skipped, taken once its window opened. The
 * newest reading of a proof decides: a later failed or expired reading of the same proof withdraws an
 * earlier pass. A follow-up whose parent is not among `all` has no merge to bind a reading to.
 */
export function observationPass(work: Observed, now: Date, all: readonly Pick<Work, 'id' | 'delivery'>[] = []): { release: string; readings: Reading[] } | null {
  const proofs = loopObservationProofs(work);
  if (!proofs) return null;
  const window = work.observationWindow;
  const request = followUpRequest(work), parent = request && all.find(entry => entry.id === request.work)?.delivery;
  const bound = (entry: Reading) => !request || (!!parent && entry.baseSha === parent.mergeSha && (entry.sha === request.release || !!entry.reading));
  const readings: Reading[] = [];
  for (const proof of proofs) {
    const latest = newest(work.evidence.filter(entry => entry.proof === proof && entry.trusted && !entry.revocation && entry.policyRevision === work.policyRevision
      && bound(entry) && (!window || Date.parse(entry.at) >= Date.parse(window.notBefore))));
    if (!latest || !evidenceProves(proof, latest) || (latest.expiresAt && Date.parse(latest.expiresAt) <= now.getTime())) return null;
    readings.push(latest);
  }
  return { release: newest(readings)!.sha, readings };
}

/**
 * GY-1762: what a loop-owned observation item waits for, or null. A system-driven item whose every
 * criterion is a manual post-deploy proof (declared `manual:post-deploy/…` or a follow-up's
 * `…-on-serving-release`) has no code for a worker to write: its only work is the live reading the
 * loop records. It holds no worker while the reading is unrecorded: before its observation window
 * closes it waits for the instant (`due: false`); from then on, or with no window, the reading is
 * due (`due: true`): the loop's deployment-verification step records it (daemon/cycle-readings.ts,
 * GY-1779), never a dispatched worker and never an operator. Only a recorded trusted reading ends
 * the wait (`observationPass`); the loop then closes the item on that reading's release. With a code
 * criterion, or any other proof, it is dispatched as before.
 */
export function loopObservation(work: Observed, now: Date, all: readonly Pick<Work, 'id' | 'delivery'>[] = []): { waitingFor: string; due: boolean } | null {
  const proofs = loopObservationProofs(work);
  if (!proofs || observationPass(work, now, all)) return null;
  const window = work.observationWindow;
  const due = !window || Date.parse(window.notBefore) <= now.getTime();
  // GY-1779: a due reading is the loop's to record in its deployment-verification step, never owed to an operator.
  return { due, waitingFor: due ? `the loop's reading of ${proofs.join(', ')} on the serving release, which is due and which the loop records in its deployment-verification step` : `the loop's reading of ${proofs.join(', ')}, which can first exist at ${window!.notBefore} (${window!.detail})` };
}

/**
 * GY-1779: why `ref` cannot close this item as `delivered-observation`, or null. The kind is no
 * client-controlled lifecycle transition: it closes only a loop-owned observation item, and only on
 * the release its recorded passing reading was taken on, as `observationPass` reads the item; an item
 * with no reading, only a failed one, or a pass on another release is refused.
 */
export function deliveredObservationRefusal(work: Observed & Pick<Work, 'key'>, all: readonly Pick<Work, 'id' | 'delivery'>[], ref: string, now: Date): string | null {
  const proofs = loopObservationProofs(work);
  if (!proofs) return `${work.key} is not a loop-owned observation item; delivered-observation closes only an item whose every criterion is a post-deploy observation the loop reads`;
  const pass = observationPass(work, now, all);
  if (!pass) return `${work.key} carries no passing reading of ${proofs.join(', ')} as the loop reads one (trusted, unrevoked, at policy revision ${work.policyRevision}, bound to the parent delivery's merge, taken once its window opened and not withdrawn by a later fail); it is not closed as a delivered observation`;
  if (pass.release.toLowerCase() !== ref.toLowerCase()) return `${work.key}'s passing reading was taken on release ${pass.release.slice(0, 12)}, not ${ref.slice(0, 12)}; a delivered-observation closure names the release its reading was taken on`;
  return null;
}
