import { baseRefreshConflict, latestCheck } from '../merge-queue.js';
import type { QueueEjection, QueueEntry, QueueHistoryEntry } from '../merge-queue.js';
import type { Gate, Stage, Work } from './work.js';
import { escalationRefusals } from './escalation.js';
import { leadHoldRefusal } from './delegation.js';
import { currentEvidence, evidenceIndependenceRefusals } from './evidence.js';
import { inheritedObligations } from './bootstrap.js';
import { exactApproval, exhaustedReviewerProfiles, reviewProviderOf, reviewerProfileFor } from './review.js';
import { carriedApproval, evidenceBindsCandidate } from './carry.js';
import { placeInQueue } from './queue.js';
import { regressionRefusals } from '../regression-guard.js';

// Pure evaluation: neither worker assertions nor UI state can authorize progression.
export function evaluate(work: Work, all: Work[], now: Date, ciAppIds: number[]): { stage: Stage; gates: Gate[]; violations: string[]; queue: QueueEntry | null; queueSequence: number; queueEjection: QueueEjection | null; queueHistory: QueueHistoryEntry[] } {
  const gates: Gate[] = [];
  const add = (name: string, reasons: string[]) => gates.push({ name, passed: reasons.length === 0, reasons });
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
  const conflict = baseRefreshConflict(work);
  add('build', [...(!work.submission || work.reworkRequested ? ['Worker has not submitted implementation for this attempt'] : []), ...(!candidate ? ['Pull request has not been independently observed'] : []), ...(!work.workspaces.length ? ['No workspace registered'] : []),
    ...(conflict ? [conflict] : []), ...(current ? regressionRefusals(work, obs!, all) : [])]);
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
  add('test', work.policy.checks.filter(name => {
    const checks = current ? obs!.checks.filter(c => c.name === name && ciAppIds.includes(c.appId)) : [];
    return latestCheck(checks)?.result !== 'success';
  }).map(name => `Required CI check ${name} has not passed on the current candidate`));
  const reasons: string[] = [];
  const unproven = (proof: string) => {
    const evidence = currentEvidence(work, proof, now);
    return !evidence || evidence.result !== 'pass' || evidence.executed < 1 || evidence.skipped !== 0;
  };
  const demanded = (proof: string) => {
    const scenario = work.scenarioRequirements?.find(s => s.proof === proof);
    // Name an explicit revocation: an operator otherwise cannot tell a revoked
    // candidate apart from one that was never proven.
    const revoked = work.evidence.some(e => e.proof === proof && e.trusted && !!e.revocation && evidenceBindsCandidate(work, e) && e.policyRevision === work.policyRevision);
    return `${proof} needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy${scenario ? `; scenario v${scenario.revision} in ${scenario.environment}` : ''}${revoked && !currentEvidence(work, proof, now) ? '; previously accepted evidence was revoked' : ''}`;
  };
  // A bootstrap criterion's proofs are deferred here and required of the next change that
  // touches the same contract; review, CI and every other criterion still gate this one.
  for (const ac of work.criteria.filter(criterion => !criterion.bootstrap)) for (const proof of ac.proofs) {
    if (unproven(proof)) reasons.push(`${ac.id}: ${demanded(proof)}`);
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
  const delivery = [...escalationRefusals(work), ...(leadHoldRefusal(work) ? [leadHoldRefusal(work)!] : [])];
  const queueState = placeInQueue(work, all, now, ciAppIds, gates.every(g => g.passed) && !work.violations.length && !delivery.length && !!candidate && !obs?.merged);
  add('merge', [...(!fresh ? ['GitHub observation missing or older than two minutes'] : []), ...(!obs?.protected ? ['Required Graphyard check and merge-queue branch protection have not been verified'] : []), ...(!obs?.mergeable && !obs?.merged ? ['Pull request is not mergeable against the current base'] : []), ...delivery, ...queueState.reasons]);
  const first = gates.find(g => !g.passed);
  const violations = [...work.violations];
  let stage: Stage = !work.ready ? 'backlog' : !work.submission ? (work.lease && Date.parse(work.lease.expiresAt) > now.getTime() ? 'build' : 'ready') : (first?.name === 'ready' ? 'build' : first?.name as Stage ?? 'merge');
  // Delivery history stays complete; later observations cannot rewrite it.
  if (work.stage === 'done') stage = 'done';
  return { stage, gates, violations, queue: queueState.queue, queueSequence: queueState.queueSequence, queueEjection: queueState.ejection, queueHistory: queueState.history };
}
