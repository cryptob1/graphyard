import type { Gate, Stage, Work } from './work.js';
import type { MergeLedgerState } from './merge-ledger.js';
import { leadHoldRefusal } from './delegation.js';
import { exactApproval, exhaustedReviewerProfiles, reviewProviderOf, reviewerProfileFor } from './review.js';
import { carriedApproval } from './carry.js';
import { mechanicalReviewHold } from '../mechanical-findings.js';
import { evaluateLandability, landabilityAudit, landabilityRefusals } from './landability.js';
import { isDelivered } from './closure.js';
import { reviewedBeforeMerge, riskOf } from './risk-class.js';
import { postMergeReviewMark, sensitiveReviewRefusal, type PostMergeReviewState } from './post-merge-review.js';

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

/**
 * The item's stage and gates, judged from the record alone. The merge writer merges each
 * candidate whose gates pass (docs/delivery.md); nothing here places it in a queue of Graphyard's own.
 */
export function evaluate(work: Work, all: Work[], now: Date): { stage: Stage; gates: Gate[]; violations: string[]; postMergeReview?: PostMergeReviewState | null } {
  const gates: Gate[] = [];
  const add = (name: string, reasons: string[]) => gates.push({ name, passed: reasons.length === 0, reasons });
  const dependencies = work.dependencies.filter(id => all.find(w => w.id === id)?.stage !== 'done');
  add('ready', [...(!work.ready ? ['Not released from backlog'] : []), ...dependencies.map(id => `Dependency ${all.find(w => w.id === id)?.key ?? id} is unfinished`),
    ...(work.blocker ? [work.blocker] : [])]);
  const candidate = work.candidate;
  const obs = work.observation;
  const current = !!candidate && !!obs && obs.candidate.sha === candidate.sha && obs.candidate.baseSha === candidate.baseSha;
  // Whether the candidate can land is one verdict (GY-878): the build and acceptance gates are its
  // two families, word for word. A candidate that reverts, deletes or rewrites shipped files
  // outside its planned scope, sits on a base the control plane cannot merge in cleanly, or
  // failed a mechanical proof (GY-115) is refused by the build family; an
  // unproven proof, inherited obligation or dependent producer by the acceptance family.
  const verdict = evaluateLandability(work, all, now);
  const family = (name: 'build' | 'acceptance') => {
    const reasons = landabilityRefusals(verdict, name);
    // A refusal records the verdict version and its inputs in the audit trail (the gate itself).
    gates.push({ name, passed: reasons.length === 0, reasons, ...(reasons.length ? { verdict: landabilityAudit(verdict) } : {}) });
  };
  family('build');
  const reviews = current ? obs!.reviews : [];
  const changesRequested = reviews.some(r => r.state === 'CHANGES_REQUESTED');
  const agentReview = current ? obs!.agentReview : undefined;
  const provider = reviewProviderOf(work.policy);
  const selectedProfile = reviewerProfileFor(work);
  // An approval binds the exact commit: the one the provider approved (see exactApproval), or the
  // one Graphyard carried it to across its own authored base refresh (see carry.ts). Nothing else counts.
  const reviewPassed = !!exactApproval(work) || !!carriedApproval(work);
  const reviewRefusal = provider === 'codex' ? agentReview?.reason ?? 'Verified clean Codex review of the current commit is required'
    : provider === 'agent' ? !selectedProfile
      ? `Every configured reviewer profile is exhausted for this candidate (${exhaustedReviewerProfiles(work).join(', ') || 'none configured'}); add reviewer capacity or select another review provider`
      : agentReview?.reason ?? `Verified approval from reviewer profile ${selectedProfile.name} is required for the current commit`
    : work.formalReviewResetRequired ? 'A new independent approval after the requirement-review baseline is required' : 'Independent approval of the current commit is required';
  // An approval naming mechanical nits waits for its worker-bot round before the merge writer may merge (GY-971).
  const mechanicalHold = reviewPassed ? mechanicalReviewHold(work, now.getTime()) : null;
  // The one merge rule (GY-1525): a head the merge writer observed is judged by the class of its
  // merge delta (model/risk-class.ts). A sensitive delta needs the exact-head approval before it
  // merges; any other passes here and owes one post-merge review (model/post-merge-review.ts), which
  // the evaluation marks on the item. A pull-request-era observation still needs its approval.
  const byRisk = current && obs!.source === 'control-plane' && work.policy.review ? riskOf(work) : null;
  const beforeMerge = byRisk ? reviewedBeforeMerge(byRisk.risk) : true;
  const riskRefusal = reviewPassed || !beforeMerge ? [] : byRisk?.risk === 'sensitive' ? [sensitiveReviewRefusal(byRisk.reasons)] : [reviewRefusal];
  const postMerge = byRisk ? postMergeReviewMark(work, beforeMerge ? 'sensitive' : byRisk.risk, reviewPassed) : {};
  // A change request holds only where the approval is needed before merge. A normal-risk change
  // request is attention for the post-merge pass, never a merge gate (GY-1525).
  const changeRequestHold = changesRequested && beforeMerge
    ? ['Outstanding change requests must be resolved through a new review'] : [];
  add('review', work.policy.review ? [
    ...riskRefusal,
    ...changeRequestHold,
    ...(mechanicalHold ? [mechanicalHold] : []),
  ] : []);
  // GY-2010: gates never read GitHub. The merge writer's ledger stands for the test and merge
  // gates for every observed candidate — including a document that still carries pull-request-era
  // checks, PR numbers and mergeability. Those fields load; they do not refuse progression.
  const ledger = current ? mergeLedgerRefusals(work.mergeLedger, obs!.candidate) : null;
  const checkReasons = ledger ? ledger.test : current ? [] : [unobservedCandidateRefusal];
  gates.push({ name: 'test', reasons: checkReasons, passed: checkReasons.length === 0 });
  // A lead hold is a refusal to deliver, and its own reason is reported.
  // Unresolved review threads are the reviewer's inputs, not merge blockers.
  const delivery = leadHoldRefusal(work) ? [leadHoldRefusal(work)!] : [];
  add('merge', [...(!current ? [unobservedCandidateRefusal] : []), ...(ledger ? ledger.merge : []), ...delivery]);
  const first = gates.find(g => !g.passed);
  const violations = [...work.violations];
  let stage: Stage = !work.ready ? 'backlog' : !work.submission ? (work.lease && Date.parse(work.lease.expiresAt) > now.getTime() ? 'build' : 'ready') : (first?.name === 'ready' ? 'build' : first?.name as Stage ?? 'merge');
  // Delivery history stays complete; later observations cannot rewrite it.
  if (work.stage === 'done') stage = 'done';
  return { stage, gates, violations, ...postMerge };
}
