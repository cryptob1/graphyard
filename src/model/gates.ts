import { conversationProtectionRefusal, failedCheckResults, requiredCheck, requiredCheckPassed, requiredCheckRun, requiredChecksOf, checkRerunStatus } from '../merge-queue.js';
import type { Gate, Stage, Work } from './work.js';
import type { MergeLedgerState } from './merge-ledger.js';
import { escalationRefusals } from './escalation.js';
import { ciCheckRefusal } from './ci-refusal.js';
import { requiredCheckFailure } from './required-check-refusal.js';
import { leadHoldRefusal } from './delegation.js';
import { exactApproval, exhaustedReviewerProfiles, reviewProviderOf, reviewerProfileFor } from './review.js';
import { carriedApproval } from './carry.js';
import { mechanicalReviewHold } from '../mechanical-findings.js';
import { evaluateLandability, landabilityAudit, landabilityRefusals } from './landability.js';
import { itemLane, laneRequirements, laneSpeedTargets, type Lane } from './policy.js';
import { isDelivered } from './closure.js';
import { riskOf } from './risk-class.js';
import { postMergeReviewMark, sensitiveReviewRefusal, type PostMergeReviewState } from './post-merge-review.js';

// Pure evaluation: neither worker assertions nor UI state can authorize progression.
declare module './work.js' {
  interface Observation {
    // GitHub has not computed mergeability yet (`pr.mergeable === null`): it recomputes lazily after
    // the base moves. Unknown is neither mergeable nor conflicting; it is re-read on the next
    // observation rather than refused as not mergeable (GY-548). Recorded by github.ts `observe`.
    mergeabilityUnknown?: boolean;
    /** `control-plane`: built from the coordinator's object store by the merge writer's observeHead (GY-1523); unset on an observation GitHub supplied. */
    source?: 'control-plane';
  }
}

/** The control-plane test gate's refusal until the merge ledger holds a passing trial of exactly this head on exactly this base tip. */
export const trialRefusal = (head: string, baseTip: string) => `merge writer has not trialled ${head.slice(0, 12)} on ${baseTip.slice(0, 12)}`;
/** The control-plane merge gate's refusal until the merge ledger records this head pushed and the push reconciled. */
export const pushRefusal = (head: string) => `merge writer has not pushed ${head.slice(0, 12)}`;
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

/** The merge gate's refusal until GitHub has been read at exactly the current candidate. */
export const githubUnobservedRefusal = 'GitHub has not been observed at the current candidate';
/** The merge gate's refusal while GitHub has not computed a pull request's mergeability (GY-548). */
export const mergeabilityComputingRefusal = 'GitHub is computing mergeability against the current base; the next observation reads it again';

// ---- Risk lanes (GY-883) -------------------------------------------------------------------------

// The per-lane required set lives with the path policy it scales (model/policy.ts); the verdict
// here is one of its readers.
export { laneRequirements };

/**
 * The item's stage, gates and lane, judged from the record alone. GitHub merges each candidate
 * whose gates pass (docs/delivery.md); nothing here places it in a queue of Graphyard's own.
 */
export function evaluate(work: Work, all: Work[], now: Date, ciAppIds: number[]): { stage: Stage; gates: Gate[]; violations: string[]; lane: Lane; speedTarget: number; postMergeReview?: PostMergeReviewState | null } {
  const gates: Gate[] = [];
  const add = (name: string, reasons: string[]) => gates.push({ name, passed: reasons.length === 0, reasons });
  // The lane rides the one landability verdict, not beside it (GY-883 AC-3): the verdict
  // (model/landability.ts) takes the item's lane and decides which facts it requires; the
  // evaluation reports the lane with its speed target.
  const lane = itemLane(work);
  const speedTarget = laneSpeedTargets[lane];
  const dependencies = work.dependencies.filter(id => all.find(w => w.id === id)?.stage !== 'done');
  // A split parent (GY-1126) is never dispatched itself: it waits until every child is delivered, which delivers it (src/decomposition.ts).
  const children = (work.children ?? []).filter(key => !all.some(w => w.key === key && isDelivered(w)));
  add('ready', [...(!work.ready ? ['Not released from backlog'] : []), ...dependencies.map(id => `Dependency ${all.find(w => w.id === id)?.key ?? id} is unfinished`),
    ...children.map(key => `Split into child items: ${key} is not delivered`), ...(work.blocker ? [work.blocker] : [])]);
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
    : work.formalReviewResetRequired ? 'A new independent GitHub approval after the requirement-review baseline is required' : 'Independent approval of the current commit is required';
  // An approval naming mechanical nits waits for its worker-bot round before GitHub may merge (GY-971).
  const mechanicalHold = reviewPassed ? mechanicalReviewHold(work, now.getTime()) : null;
  // Review by risk (GY-1525): a head the control plane observed itself is judged by the class of its
  // merge delta (model/risk-class.ts), not by the path lane. A sensitive delta needs the exact-head
  // approval before it merges; a normal one passes here and owes one post-merge review
  // (model/post-merge-review.ts), which the evaluation marks on the item. GitHub mode is untouched.
  const byRisk = current && obs!.source === 'control-plane' && work.policy.review ? riskOf(work) : null;
  const riskRefusal = byRisk ? byRisk.risk === 'sensitive' && !reviewPassed ? [sensitiveReviewRefusal(byRisk.reasons)] : [] : !reviewPassed ? [reviewRefusal] : [];
  const postMerge = byRisk ? postMergeReviewMark(work, byRisk.risk, reviewPassed) : {};
  add('review', work.policy.review ? [
    ...riskRefusal,
    ...(changesRequested ? ['Outstanding change requests must be resolved through a new review'] : []),
    ...(mechanicalHold ? [mechanicalHold] : []),
  ] : []);
  // The policy's checks and every other check the base branch's protection requires (GY-430):
  // GitHub refuses the merge while any of them has not passed, so none is left for it to find.
  // A head the control plane observed itself (GY-1523) has no GitHub checks and no GitHub
  // mergeability: the merge writer's ledger stands in for both, and only for that source.
  const ledger = obs?.source === 'control-plane' ? mergeLedgerRefusals(work.mergeLedger, obs!.candidate) : null;
  const checkReasons = ledger ? ledger.test : requiredChecksOf(work).flatMap(check => {
    const run = check.policy ? requiredCheck(work, check.name, ciAppIds) : current ? requiredCheckRun(check, obs!.checks, ciAppIds) : undefined;
    if (requiredCheckPassed(check, run)) return [];
    return [!check.policy && run && failedCheckResults.includes(run.result)
      ? requiredCheckFailure(check.name)
      : ciCheckRefusal(check.name, current ? checkRerunStatus(work, check.name) : '')];
  });
  gates.push({ name: 'test', ciAppIds: [...ciAppIds], reasons: checkReasons, passed: checkReasons.length === 0 });
  // GitHub merges (docs/delivery.md): a candidate whose build, review and required checks pass on
  // its head is GitHub's to merge on its own branch protection. Proofs are no merge gate — unit
  // tests run in CI and end-to-end ones in UAT before promotion — and nothing here queues the
  // candidate, reads the observation's age or asks for a merge authorization.
  // A standing escalation or lead hold is a refusal to deliver, and its own reason is reported.
  // Unresolved review threads are the reviewer's inputs, not merge blockers: the review gate is the
  // configured reviewer's verdict on this exact head. Only a branch whose protection still requires
  // conversation resolution — drift from the desired protection — makes a merge GitHub will
  // refuse; that is named here, thread by thread.
  const delivery = [...escalationRefusals(work), ...(leadHoldRefusal(work) ? [leadHoldRefusal(work)!] : [])];
  const threads = current ? conversationProtectionRefusal(work) : null;
  // GitHub's `mergeable: null` is a computation it has not finished, not a refusal (GY-548): it is
  // named as such and read again on the next observation.
  const mergeability = obs?.mergeable || obs?.merged ? null
    : obs?.mergeabilityUnknown ? mergeabilityComputingRefusal
      : 'Pull request is not mergeable against the current base';
  add('merge', ledger ? [...(!current ? [githubUnobservedRefusal] : []), ...ledger.merge, ...delivery]
    : [...(!current ? [githubUnobservedRefusal] : []), ...(mergeability ? [mergeability] : []), ...(threads ? [threads] : []), ...delivery]);
  const first = gates.find(g => !g.passed);
  const violations = [...work.violations];
  let stage: Stage = !work.ready ? 'backlog' : !work.submission ? (work.lease && Date.parse(work.lease.expiresAt) > now.getTime() ? 'build' : 'ready') : (first?.name === 'ready' ? 'build' : first?.name as Stage ?? 'merge');
  // Delivery history stays complete; later observations cannot rewrite it.
  if (work.stage === 'done') stage = 'done';
  return { stage, gates, violations, lane, speedTarget, ...postMerge };
}
