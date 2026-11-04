import { servingReleaseProof, type Principal, type Work } from './work.js';
import { namedPaths } from './documentation-glob.js';

/**
 * GY-1760: a follow-up whose proof observes the master checkout itself
 * (`manual:checkout-restore-…-on-serving-release`, GY-1696 and GY-1674) reads state only a
 * master-role identity holds — the coordinator checkout's `.graphyard/master.json`, a master
 * command — and a worker token holds no master role by design, so a released item of this class
 * can only end in a worker's blocked report.
 *
 * Whether a proof's reading is one only a master-role identity can take (GY-1761's master-role
 * class, met before dispatch instead of after a worker's blocked report): the proof names the
 * doctor-issued checkout-restore, a master-status reading, or the coordinator checkout's own
 * connection file. A report or rate reading (`manual:intervention-pattern-…-on-serving-release`,
 * `manual:post-deploy/…`) names none of them and stays a worker's — its loop still defers it
 * inside its observation window (GY-1740) and a producer session records the reading.
 */
export const masterRoleObservation = (proof: string) => /checkout-restore|master[.-](status|role)|\.graphyard\/master\.json/i.test(proof);

/** Whether nothing of the item is a worker's to do: no criterion names a file to change, and every proof it owes is recorded by the master side, so releasing it would only dispatch a worker that must block. An item with code work keeps its worker (GY-1762), and one criterion that a worker can serve keeps the whole item dispatchable. */
export const loopOwned = (work: Pick<Work, 'criteria'>) => {
  if (work.criteria.some(criterion => namedPaths(criterion.text).length)) return false;
  const proofs = work.criteria.flatMap(criterion => criterion.proofs);
  return proofs.length > 0 && proofs.every(proof => servingReleaseProof(proof) && masterRoleObservation(proof));
};

/** Why such an item is never released or dispatched, or null: the refusal names who closes it. */
export const loopOwnedRefusal = (work: Pick<Work, 'key' | 'criteria'>) => loopOwned(work)
  ? `${work.key} is loop-owned: no criterion names a file to change and every proof it owes is a master-role session's observation of the master checkout, so a worker has nothing to build, no observation it can take, and no pull request to submit. It stays off the dispatch board; a master-role session records the observation and the item closes without a worker. Releasing or dispatching it would only end in a worker's blocked report`
  : null;

/**
 * GY-2605: an item whose own record reserves its release to the owner (GY-1857): an `Owner hold:` title,
 * a description or criterion saying it leaves the backlog only when the owner releases it, or a manual
 * proof that records the owner scheduling it. Only the owner, a declared human admin session, releases it,
 * or anyone once the item carries an owner's provided answer (GY-2606).
 */
const ownerHoldWording = /\b(?:leaves the backlog only when|stays in the backlog until) the owner releases it\b/i;
export const ownerHeld = (work: Pick<Work, 'title' | 'description' | 'criteria'>) => /^owner hold:/i.test(work.title)
  || ownerHoldWording.test([work.description ?? '', ...work.criteria.map(criterion => criterion.text)].join('\n'))
  || work.criteria.some(criterion => criterion.proofs.some(proof => proof.startsWith('manual:owner-schedules')));
const ownerAnswered = (work: Pick<Work, 'humanRequest' | 'humanRequests'>) =>
  [work.humanRequest, ...work.humanRequests ?? []].some(request => request?.answer?.outcome === 'provided');
export const ownerHoldRefusal = (work: Pick<Work, 'key' | 'title' | 'description' | 'criteria' | 'humanRequest' | 'humanRequests'>, actor?: Pick<Principal, 'id' | 'role' | 'sessionKind'>) =>
  !ownerHeld(work) || ownerAnswered(work) || (actor?.role === 'admin' && actor.sessionKind === 'human') ? null
    : `${work.key} is under an owner hold: its record reserves the release to the owner, so ${actor?.id ?? 'an agent'} may not release it. It stays in the backlog until the owner releases it with their own human admin session`;
