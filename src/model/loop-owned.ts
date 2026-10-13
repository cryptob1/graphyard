import { servingReleaseProof, loopObservationProofs, type Work } from './work.js';

/**
 * GY-1760: the proofs only the master side of the house records. A throughput owner
 * (src/throughput.ts) owns the verification of GY-87's claim on the serving release, and the loop
 * records its proof from its own measurement. A follow-up whose proof observes the master checkout
 * itself (`manual:checkout-restore-…-on-serving-release`, GY-1696 and GY-1674) reads state only a
 * master-role identity holds — the coordinator checkout's `.graphyard/master.json`, a master
 * command — and a worker token holds no master role by design. Neither leaves anything a worker
 * can do; with no planned files there is no diff and no pull request to submit either, so a
 * released item of this class can only end in a worker's blocked report.
 */
export const loopRecordedProofs: readonly string[] = ['manual:throughput-claim-verified'];

/**
 * Whether a proof's reading is one only a master-role identity can take (GY-1761's master-role
 * class, met before dispatch instead of after a worker's blocked report): the proof names the
 * doctor-issued checkout-restore, a master-status reading, or the coordinator checkout's own
 * connection file. A report or rate reading (`manual:intervention-pattern-…-on-serving-release`,
 * `manual:post-deploy/…`) names none of them and stays a worker's — its loop still defers it
 * inside its observation window (GY-1740) and a producer session records the reading.
 */
export const masterRoleObservation = (proof: string) => /checkout-restore|master[.-](status|role)|\.graphyard\/master\.json/i.test(proof);

/** Whether nothing of the item is a worker's to do: it plans no files, and every proof it owes is recorded by the master side, so releasing it would only dispatch a worker that must block. An item with code work keeps its worker (GY-1762: an item with a code criterion is dispatched as before), and one criterion that a worker can serve keeps the whole item dispatchable. */
export const loopOwned = (work: Pick<Work, 'criteria' | 'plannedFiles'>) => {
  if ((work.plannedFiles ?? []).length) return false;
  const proofs = work.criteria.flatMap(criterion => criterion.proofs);
  return proofs.length > 0 && proofs.every(proof => loopRecordedProofs.includes(proof)
    || servingReleaseProof(proof) && masterRoleObservation(proof));
};

/** Why such an item is never released or dispatched, or null: the refusal names who closes it. */
export const loopOwnedRefusal = (work: Pick<Work, 'key' | 'criteria' | 'plannedFiles'>) => loopOwned(work)
  ? `${work.key} is loop-owned: it plans no files and every proof it owes is recorded by the master side (the loop's own throughput measurement, or a master-role session's observation of the master checkout), so a worker has nothing to build, no observation it can take, and no pull request to submit. It stays off the dispatch board; a master-role session records the observation and the item closes without a worker. Releasing or dispatching it would only end in a worker's blocked report`
  : null;

/**
 * GY-1768: whether an item with a standing worker blocker has nothing left for a worker: it is loop-owned (GY-1760) or only waits for the loop's own post-deploy reading (GY-1762), and no
 * attempt holds it. A `blocked` report recorded before those guards (or by an attempt already running when they shipped) says the reading cannot be taken from a sandbox, which is the very
 * reason the item is off the dispatch board; left standing it is an open escalation until a master unblocks it by hand. The loop clears it instead, and the item's own next action
 * (`escalate`, the loop's reading owed) names who records the reading. Only a blocker no routine class explains qualifies: a human's decision wait stays.
 */
export const loopHeldBlocker = (work: Pick<Work, 'systemDriven' | 'criteria' | 'plannedFiles' | 'stage' | 'description' | 'lease'>, blockerClass: string, now: number) =>
  (blockerClass === 'genuine' || blockerClass === 'master-role') && (!work.lease || Date.parse(work.lease.expiresAt) <= now) && (loopOwned(work) || !!loopObservationProofs(work));
