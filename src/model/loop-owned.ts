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
 * GY-1768: the words a worker's blocked report uses when its cause is only that a worker cannot take the reading the item owes — the proof's authority is not a worker's, the step needs a
 * master-role session or a browser sign-in, or a credential no worker holds. Exactly such a report is moot on an item held for the loop: the item is off the dispatch board and its own
 * next action names who records the reading. Any other cause on the same item is actionable — an unrelated failure, or a fault a named remedy could answer (a configuration missing and
 * owed its restore) — so its blocker stands for whoever can act on it, however the item is shaped.
 */
const workerCannotServe = /\bnot a worker(?:'s)?(?=\s*(?:[(,;:]|\.(?:\s|$)|$|to\b|reading\b|observation\b|proof\b|authority\b))|\bcannot\b[^.\n]{0,80}\bby a worker\b|\bworker token holds no master role\b|\bfrom a worker session\b|\bobtainable from this sandbox\b|\bneeds? a master(?:-role)?\b|\bmaster-role session\b|\ba worker does not hold\b|\bbrowser sign-in\b|\boperator-supplied\b/i;

/**
 * GY-1768: whether an item with a standing worker blocker has nothing left for a worker: it is loop-owned (GY-1760) or only waits for the loop's own post-deploy reading (GY-1762), no
 * attempt holds it, and the report's cause is the worker's inability to take the reading it owes (workerCannotServe) — a `blocked` report recorded before those guards, or by an attempt
 * already running when they shipped, saying the reading cannot be taken from a sandbox: the very reason the item is off the dispatch board. Left standing it is an open escalation until
 * a master unblocks it by hand; the loop clears it instead, and the item's own next action (`escalate`, the loop's reading owed) names who records the reading. Only such a report on
 * such an item qualifies: a human's decision wait stays, and so does any actionable fault the item's shape does not make moot.
 */
export const loopHeldBlocker = (work: Pick<Work, 'systemDriven' | 'criteria' | 'plannedFiles' | 'stage' | 'description' | 'lease'>, blocker: string, blockerClass: string, now: number) =>
  (blockerClass === 'genuine' || blockerClass === 'master-role') && workerCannotServe.test(blocker) && (!work.lease || Date.parse(work.lease.expiresAt) <= now)
  && (loopOwned(work) || !!loopObservationProofs(work));
