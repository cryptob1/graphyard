import type { Work } from './work.js';

/**
 * GY-1760: the proofs only the master loop records. A throughput owner (src/throughput.ts) owns the
 * verification of GY-87's claim on the serving release; it has nothing to build, so no worker can
 * satisfy its criterion, and the loop closes it itself.
 */
export const loopRecordedProofs: readonly string[] = ['manual:throughput-claim-verified'];

/** Whether every proof of the item is one only the loop records, so a released item would only be dispatched to a worker with nothing to do. */
export const loopOwned = (work: Pick<Work, 'criteria'>) => {
  const proofs = work.criteria.flatMap(criterion => criterion.proofs);
  return proofs.length > 0 && proofs.every(proof => loopRecordedProofs.includes(proof));
};

/** Why such an item is never released, or null: the refusal names who closes it. */
export const loopOwnedRefusal = (work: Pick<Work, 'key' | 'criteria'>) => loopOwned(work)
  ? `${work.key} is loop-owned: its only proof is recorded by the master loop's own measurement, so there is nothing for a worker to build. It stays in the backlog and the loop closes it once the measurement verifies or its needs-decision is answered; releasing it would only dispatch a worker that must block`
  : null;
