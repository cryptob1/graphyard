import { baseRefreshConflict, ciPendingReason, conversationProtectionRefusal, requiredCheck, checkRerunStatus, restoringAfterEjection, tipValidation } from '../merge-queue.js';
import type { QueueEjection, QueueEntry, QueueHistoryEntry } from '../merge-queue.js';
import type { Gate, Stage, Work } from './work.js';
import { escalationRefusals } from './escalation.js';
import { ciCheckRefusal } from './ci-refusal.js';
import { leadHoldRefusal } from './delegation.js';
import { currentEvidence, evidenceIndependenceRefusals } from './evidence.js';
import { inheritedObligations } from './bootstrap.js';
import { exactApproval, exhaustedReviewerProfiles, reviewProviderOf, reviewerProfileFor } from './review.js';
import { carriedApproval, evidenceBindsCandidate } from './carry.js';
import { placeInQueue, type MergeQueueSettings } from './queue.js';
import { regressionRefusals } from '../regression-guard.js';
import { mechanicalFailure, mechanicalVerdicts, evidenceProves, attestedProof } from './mechanical-proofs.js';
import { itemLane, laneRequiresProof, laneRequirements, laneSpeedTargets, type Lane } from './policy.js';

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

// ---- Risk lanes (GY-883) -------------------------------------------------------------------------

// The per-lane required set lives with the path policy it scales (model/policy.ts); the verdict
// here is one of its readers.
export { laneRequirements };

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
export function evaluate(work: Work, all: Work[], now: Date, ciAppIds: number[], mergeQueue?: number | MergeQueueSettings): { stage: Stage; gates: Gate[]; violations: string[]; lane: Lane; speedTarget: number; queue: QueueEntry | null; queueSequence: number; queueEjection: QueueEjection | null; queueHistory: QueueHistoryEntry[] } {
  const gates: Gate[] = [];
  const add = (name: string, reasons: string[]) => gates.push({ name, passed: reasons.length === 0, reasons });
  // The lane rides the one landability verdict, not beside it (GY-883 AC-3): the evaluation takes
  // the item's lane, decides which facts it requires, and reports the lane with its speed target.
  const lane = itemLane(work);
  const speedTarget = laneSpeedTargets[lane];
  const dependencies = work.dependencies.filter(id => all.find(w => w.id === id)?.stage !== 'done');
  add('ready', [...(!work.ready ? ['Not released from backlog'] : []), ...dependencies.map(id => `Dependency ${all.find(w => w.id === id)?.key ?? id} is unfinished`), ...(work.blocker ? [work.blocker] : [])]);
  const candidate = work.candidate;
  const obs = work.observation;
  const current = !!candidate && !!obs && obs.candidate.sha === candidate.sha && obs.candidate.baseSha === candidate.baseSha;
  const fresh = current && now.getTime() - Date.parse(obs!.at) < 120_000;
  // A candidate that reverts, deletes or rewrites shipped files outside its planned scope never
  // reaches review: the refusal names every file and is re-derived from each new observation.
  // A base the control plane cannot merge in cleanly is the other thing only the worker can fix:
  // the conflict is named here, the attempt returns to build, and nothing carries across it.
  // A speculative tip built behind an entry that left the queue unlanded holds that entry's work
  // (GY-568): nothing its tree shows is this item's, so no tree-dependent refusal is read from it —
  // it waits for the control plane's restore and an observation of the restored head instead.
  const restoring = restoringAfterEjection(work, all);
  const conflict = restoring ? null : baseRefreshConflict(work);
  // Mechanical verification precedes review (GY-115): a unit or integration proof that failed on
  // this head returns it to its worker here, naming the criterion, so no review request stands for
  // it and no reviewer session is spent on what a test already answered.
  const mechanical = current && work.submission && !work.reworkRequested && !restoring
    ? mechanicalVerdicts(work, all, now).filter(verdict => verdict.outcome === 'failed').map(verdict => mechanicalFailure(verdict, candidate!.sha)) : [];
  add('build', [...(!work.submission || work.reworkRequested ? ['Worker has not submitted implementation for this attempt'] : []), ...(!candidate ? ['Pull request has not been independently observed'] : []), ...(!work.workspaces.length ? ['No workspace registered'] : []),
    ...(restoring ? [restoring] : []), ...(conflict ? [conflict] : []), ...(current && !restoring ? regressionRefusals(work, obs!, all) : []), ...mechanical]);
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
  const reasons: string[] = [];
  // GY-895: the pass rule is per family — a manual: proof is judged as an attestation, so its
  // trusted pass proves it whatever it executed, while every other proof keeps the title-count
  // rule (executed counts the cases whose titles carry the proof id), e2e included.
  const unproven = (proof: string) => {
    const evidence = currentEvidence(work, proof, now);
    return !evidence || !evidenceProves(proof, evidence);
  };
  const demanded = (proof: string) => {
    const scenario = work.scenarioRequirements?.find(s => s.proof === proof);
    // Name an explicit revocation: an operator otherwise cannot tell a revoked
    // candidate apart from one that was never proven.
    const revoked = work.evidence.some(e => e.proof === proof && e.trusted && !!e.revocation && evidenceBindsCandidate(work, e) && e.policyRevision === work.policyRevision);
    return `${proof} needs trusted passing evidence, with${attestedProof(proof) ? '' : ' executed > 0 and'} skipped = 0, for this candidate and policy${scenario ? `; scenario v${scenario.revision} in ${scenario.environment}` : ''}${revoked && !currentEvidence(work, proof, now) ? '; previously accepted evidence was revoked' : ''}`;
  };
  // A bootstrap criterion's proofs are deferred here and required of the next change that
  // touches the same contract; review, CI and every other criterion still gate this one.
  // The lane decides which of the criteria's facts the verdict requires (GY-883 AC-2, AC-3): low
  // requires none of their producer-run proofs or manual attestations — it lands on its required
  // CI checks and one approving review — medium requires the producer-run proofs, high every
  // family. An e2e proof is required in every lane, and so is an inherited obligation below.
  for (const ac of work.criteria.filter(criterion => !criterion.bootstrap)) for (const proof of ac.proofs) {
    if (laneRequiresProof(lane, proof) && unproven(proof)) reasons.push(`${ac.id}: ${demanded(proof)}`);
  }
  for (const obligation of inheritedObligations(work, all)) {
    if (unproven(obligation.proof)) reasons.push(`Bootstrap obligation inherited from ${obligation.key} ${obligation.criterionId}: ${demanded(obligation.proof)}`);
  }
  // Independence is re-decided on every evaluation, so evidence minted before its
  // producer joined the implementer set refuses acceptance with a named reason.
  reasons.push(...evidenceIndependenceRefusals(work, now));
  add('acceptance', reasons);
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
  const queueState = placeInQueue(work, all, now, ciAppIds, gates.every(g => g.passed) && !work.violations.length && !delivery.length && !threads && !!candidate && !obs?.merged, mergeQueue);
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
  return { stage, gates, violations, lane, speedTarget, queue: queueState.queue, queueSequence: queueState.queueSequence, queueEjection: queueState.ejection, queueHistory: queueState.history };
}
