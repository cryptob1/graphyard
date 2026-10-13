import { servingReleaseProof, type Work } from './work.js';

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
