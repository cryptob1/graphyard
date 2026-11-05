import type { MergeLedgerState } from './merge-ledger.js';
// Pure evaluation: neither worker assertions nor UI state can authorize progression.
declare module './work.js' {
  interface Observation {
    /** `control-plane`: built from the coordinator's object store by the merge writer's observeHead (GY-1523); unset on a pull-request-era observation. */
    source?: 'control-plane';
  }
}

/** The control-plane test gate's refusal until the merge ledger holds a passing trial of exactly this head on exactly this base tip. */
export const trialRefusal = (head: string, baseTip: string) => `merge writer has not trialled ${head.slice(0, 12)} on ${baseTip.slice(0, 12)}`;
/** The control-plane merge gate's refusal until the merge ledger records this head pushed and the push reconciled. */
export const pushRefusal = (head: string) => `merge writer has not pushed ${head.slice(0, 12)}`;
/** A required check's refusal on the candidate, with its rerun tail when one is recorded. */
export const ciCheckRefusalPattern = /^Required CI check (.+?) has not passed on the current candidate(?:; rerun: ([\s\S]*))?$/;
export const mergeWriterTrialPattern = /^merge writer has not trialled \S{1,12} on \S{1,12}$/;
export const mergeWriterPushPattern = /^merge writer has not pushed \S{1,12}$/;
/** Whether `refusal` of `gate` is one the merge writer itself answers (GY-2010). */
export const mergeWriterRefusal = (gate: string, refusal: string) => gate === 'test' ? mergeWriterTrialPattern.test(refusal) : gate === 'merge' && mergeWriterPushPattern.test(refusal);
/**
 * The two control-plane refusals for `candidate` (GY-1523), read from the item's folded merge
 * ledger (model/merge-ledger.ts, GY-1519) alone. The writer records `merge.intent` for a head only
 * after its trial merge onto the base tip built and passed the fast tests, so a ledger state naming
 * exactly this head on exactly this base tip and not refused is the passing trial. The merge gate
 * wants both `merge.pushed` and `merge.reconciled`: a state is `reconciled` with `pushedAt` null
 * when the fold met a reconciliation straight after the intent (an older writer, or a push the
 * ledger never saw), so the pushed event's own instant is required beside the reconciled state. An
 * absent ledger is no trial and no push.
 */
export function mergeLedgerRefusals(ledger: MergeLedgerState | null | undefined, candidate: { sha: string; baseSha: string }) {
  const trialled = !!ledger && ledger.head === candidate.sha && ledger.baseTip === candidate.baseSha && ledger.state !== 'refused';
  const pushed = trialled && ledger!.state === 'reconciled' && typeof ledger!.pushedAt === 'string' && Number.isFinite(Date.parse(ledger!.pushedAt));
  return { test: trialled ? [] : [trialRefusal(candidate.sha, candidate.baseSha)], merge: pushed ? [] : [pushRefusal(candidate.sha)] };
}

/** The test and merge gates' refusal until the merge writer has observed the candidate at exactly the current head and base tip. */
export const unobservedCandidateRefusal = 'The merge writer has not observed the current candidate';
