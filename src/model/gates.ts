import { ciPendingReason, conversationProtectionRefusal, requiredCheck, checkRerunStatus, tipValidation } from '../merge-queue.js';
import type { QueueEjection, QueueEntry, QueueHistoryEntry } from '../merge-queue.js';
import type { Gate, Stage, Work } from './work.js';
import { escalationRefusals } from './escalation.js';
import { ciCheckRefusal } from './ci-refusal.js';
import { leadHoldRefusal } from './delegation.js';
import { exactApproval, exhaustedReviewerProfiles, reviewProviderOf, reviewerProfileFor } from './review.js';
import { carriedApproval } from './carry.js';
import { placeInQueue, type MergeQueueSettings } from './queue.js';
import { evaluateLandability, landabilityAudit, landabilityRefusals } from './landability.js';

// Pure evaluation: neither worker assertions nor UI state can authorize progression.
declare module './work.js' {
  interface Observation {
    // GitHub has not computed mergeability yet (`pr.mergeable === null`): it recomputes lazily after
    // the base moves. Unknown is neither mergeable nor conflicting; it is re-read on the next
    // observation rather than refused as not mergeable (GY-548). Recorded by github.ts `observe`.
    mergeabilityUnknown?: boolean;
  }
}

/** The merge gate's refusal while GitHub has not computed a pull request's mergeability (GY-548). */
export const mergeabilityComputingRefusal = 'GitHub is computing mergeability against the current base; the next observation reads it again';

/**
 * The test-gate lift the merge queue's validation pays for (GY-332): a tip the queue accounts for
 * covers exactly the CI-pending refusals, so only those leave the test gate; any other refusal is
 * the candidate's own, stays, and keeps the gate failed. `null` lifts nothing: no validation
 * running, no refusals paid.
 */
export function settleTestGate(test: Gate, validating: string[] | null): void {
  if (!validating) return;
  test.reasons = test.reasons.filter(reason => !ciPendingReason(reason));
  test.passed = !test.reasons.length;
}

/**
 * `mergeQueue` names the settings the queue evaluates by: `batchSize`, the parallel-tip `parallelTips`
 * window (GY-498) and `optimistic` (GY-500). Without it the queue is validated batch by batch (GY-330),
 * as every caller that names no settings expects.
 */
export function evaluate(work: Work, all: Work[], now: Date, ciAppIds: number[], mergeQueue?: number | MergeQueueSettings): { stage: Stage; gates: Gate[]; violations: string[]; queue: QueueEntry | null; queueSequence: number; queueEjection: QueueEjection | null; queueHistory: QueueHistoryEntry[] } {
  const gates: Gate[] = [];
  const add = (name: string, reasons: string[]) => gates.push({ name, passed: reasons.length === 0, reasons });
  const dependencies = work.dependencies.filter(id => all.find(w => w.id === id)?.stage !== 'done');
  add('ready', [...(!work.ready ? ['Not released from backlog'] : []), ...dependencies.map(id => `Dependency ${all.find(w => w.id === id)?.key ?? id} is unfinished`), ...(work.blocker ? [work.blocker] : [])]);
  const candidate = work.candidate;
  const obs = work.observation;
  const current = !!candidate && !!obs && obs.candidate.sha === candidate.sha && obs.candidate.baseSha === candidate.baseSha;
  const fresh = current && now.getTime() - Date.parse(obs!.at) < 120_000;
  // Whether the candidate can land is one verdict (GY-878): the build and acceptance gates are its
  // two families, word for word, and the merge queue ejects only for a reason it gives. A candidate
  // that reverts, deletes or rewrites shipped files outside its planned scope, sits on a base the
  // control plane cannot merge in cleanly, waits for its branch restore after a predecessor's
  // ejection (GY-568), or failed a mechanical proof (GY-115) is refused by the build family; an
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
  // one Graphyard carried it to across its own authored tip (see carry.ts). Nothing else counts.
  const reviewPassed = !!exactApproval(work) || !!carriedApproval(work);
  const reviewRefusal = provider === 'codex' ? agentReview?.reason ?? 'Verified clean Codex review of the current commit is required'
    : provider === 'agent' ? !selectedProfile
      ? `Every configured reviewer profile is exhausted for this candidate (${exhaustedReviewerProfiles(work).join(', ') || 'none configured'}); add reviewer capacity or select another review provider`
      : agentReview?.reason ?? `Verified approval from reviewer profile ${selectedProfile.name} is required for the current commit`
    : work.formalReviewResetRequired ? 'A new independent GitHub approval after the requirement-review baseline is required' : 'Independent approval of the current commit is required';
  add('review', work.policy.review ? [
    ...(!reviewPassed ? [reviewRefusal] : []),
    ...(changesRequested ? ['Outstanding change requests must be resolved through a new review'] : []),
  ] : []);
  const checkReasons = work.policy.checks.filter(name => requiredCheck(work, name, ciAppIds)?.result !== 'success')
    .map(name => ciCheckRefusal(name, current ? checkRerunStatus(work, name) : ''));
  gates.push({ name: 'test', ciAppIds: [...ciAppIds], reasons: checkReasons, passed: checkReasons.length === 0 });
  family('acceptance');
  // The merge queue owns the last hop. A candidate that has proven itself enters the queue,
  // is validated against the speculative tip it will actually land, and merges in order.
  // A standing escalation or lead hold is a refusal to deliver, so such an item never
  // becomes queue-eligible and its own reason is reported alongside the queue's.
  // Unresolved review threads are the reviewer's inputs, not merge blockers: the review gate is the
  // configured reviewer's verdict on this exact head. Only a branch whose protection still requires
  // conversation resolution — drift from the desired protection — makes a merge GitHub will
  // refuse; that is named here, thread by thread, and kept out of the queue until the protection
  // is reconciled. An entry eligible for optimistic merge (GY-500, `mergeQueue.optimistic`) never
  // joins: its merge gate carries no queue reason and it merges head-bound on its own head.
  const delivery = [...escalationRefusals(work), ...(leadHoldRefusal(work) ? [leadHoldRefusal(work)!] : [])];
  const threads = current ? conversationProtectionRefusal(work) : null;
  const queueState = placeInQueue(work, all, now, ciAppIds, gates.every(g => g.passed) && !work.violations.length && !delivery.length && !threads && !!candidate && !obs?.merged, mergeQueue, verdict);
  // CI on a queued entry's own speculative tip is the merge step validating the combined result,
  // not the change going back to Test because the base moved (GY-292): its checks refuse the merge
  // gate, and the test gate, which judges the candidate's own change, stands. A batch member the
  // plan merges on its batch's passing combined tip needs no verdict on its own tip (GY-330). Under
  // a parallel-tip window (GY-498) the entry is validated by the tips it merges behind instead.
  //
  // Ordering (GY-332): the test gate is settled only after `placeInQueue` has run on the gates as
  // they stood, so an entry validating its tip was placed as ineligible. That is sound because
  // `eligible` decides only whether an unqueued candidate enters the queue and whether it is told it
  // has not; a queued entry leaves only by ejection, never for ineligibility, and `tipValidation`
  // answers only for a queued entry whose tip is its candidate. Only the CI-pending refusals the tip
  // accounts for are lifted; any other test-gate refusal stands.
  const test = gates.find(g => g.name === 'test')!;
  const validating = tipValidation(work, queueState.queue, test.reasons);
  settleTestGate(test, validating);
  // GitHub's `mergeable: null` is a computation it has not finished, not a refusal (GY-548): it is
  // named as such and read again on the next observation. A queued entry is not held on it at
  // all: what merges is its speculative tip, and that tip's own CI and merge decide.
  const mergeability = obs?.mergeable || obs?.merged ? null
    : obs?.mergeabilityUnknown ? (queueState.queue ? null : mergeabilityComputingRefusal)
      : 'Pull request is not mergeable against the current base';
  add('merge', [...(!fresh ? ['GitHub observation missing or older than two minutes'] : []), ...(!obs?.protected ? ['Required Graphyard check and merge-queue branch protection have not been verified'] : []), ...(mergeability ? [mergeability] : []), ...(threads ? [threads] : []), ...delivery, ...queueState.reasons, ...(validating ?? [])]);
  const first = gates.find(g => !g.passed);
  const violations = [...work.violations];
  let stage: Stage = !work.ready ? 'backlog' : !work.submission ? (work.lease && Date.parse(work.lease.expiresAt) > now.getTime() ? 'build' : 'ready') : (first?.name === 'ready' ? 'build' : first?.name as Stage ?? 'merge');
  // Delivery history stays complete; later observations cannot rewrite it.
  if (work.stage === 'done') stage = 'done';
  return { stage, gates, violations, queue: queueState.queue, queueSequence: queueState.queueSequence, queueEjection: queueState.ejection, queueHistory: queueState.history };
}
