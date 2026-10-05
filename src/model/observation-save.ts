import { stableJson } from './stable-json.js';
import type { Work } from './work.js';

/**
 * What a GitHub observation of an item is derived from (GY-1310): the GitHub adapter's `observe`
 * reads the submission and the workspace it names, the candidate and last observation it compares
 * against, the policy, planned files, review request and rework request, the base refresh that
 * holds a base, the queue's speculative tip, and whether the item is done. Everything else the
 * observation's save applies to the item as it stands when saved, and re-evaluates the gates on.
 */
function observationInputs(work: Work) {
  return stableJson({
    submission: work.submission ?? null, workspaces: work.workspaces, candidate: work.candidate ?? null, observation: work.observation ?? null,
    policy: work.policy, policyRevision: work.policyRevision, plannedFiles: work.plannedFiles ?? null, reviewRequest: work.reviewRequest ?? null,
    reworkRequested: work.reworkRequested ?? null, baseRefresh: work.baseRefresh ?? null, speculation: work.queue?.speculation ?? null, done: work.stage === 'done',
  });
}
/**
 * Whether an observation read from the item at one revision still stands on the item at a later
 * one (GY-1310): nothing the observation was derived from moved. A save that only moved what the
 * observation never read — a session, an escalation, a lease renewal, a dispatch, an evidence or
 * proof record, another item's queue bookkeeping — no longer discards the poll that observed the
 * change, so a gate claim waiting on an observation newer than itself is answered by that poll.
 * A resubmission, a new candidate, another observation saved first, a policy or queue-tip change
 * still refuses it: the observation was taken of something that is no longer the item.
 */
export function sameObservationInputs(read: Work, current: Work): boolean {
  return observationInputs(read) === observationInputs(current);
}

/** Consecutive observation finishes without a saved observation before the job escalates (GY-506, GY-1310). */
export const observationNoSaveLimit = 3;
/** The hot retry a concurrency refusal gets below the limit, and the poll cadence it falls back to at the limit. */
export const observationRetryMs = 2000, observationEscalatedRetryMs = 20_000;
/**
 * The bounded retry policy for an observation job whose run saved nothing because the save was
 * refused (GY-1310). `previous` is the job's consecutive no-save count before this run. Below the
 * limit the job retries within seconds; the run that reaches it escalates — the fault is recorded
 * on the item's ledger once, and master status raises the starved job — and from then on the job
 * retries at the poll cadence rather than every two seconds, until a run saves an observation and
 * resets the count. The count stops at the limit instead of counting up without bound. Every
 * reschedule names its cause and this policy.
 */
export function noSaveRetry(previous: number, cause: string) {
  const finishes = Math.min(Math.max(0, previous) + 1, observationNoSaveLimit);
  const escalated = finishes >= observationNoSaveLimit;
  const escalating = previous + 1 === observationNoSaveLimit;
  const delayMs = escalated ? observationEscalatedRetryMs : observationRetryMs;
  const policy = escalated
    ? `no observation saved ${observationNoSaveLimit} times in a row: escalated, retrying every ${delayMs / 1000} s until one saves`
    : `no observation saved ${finishes} of ${observationNoSaveLimit} times: retrying in ${delayMs / 1000} s, escalating at ${observationNoSaveLimit}`;
  return { finishes, escalated, escalating, delayMs, reason: `${cause} (${policy})` };
}
