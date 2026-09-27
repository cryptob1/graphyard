import { baseRefreshConflict, conversationProtectionRefusal, latestCheck, staleSpeculativeTip, holdingCheckRerun } from '../merge-queue.js';
import type { Work } from './work.js';
import { regressionRefusals, queuedRegressions, staleTipRegressions } from '../regression-guard.js';
import { mechanicalFailure, mechanicalVerdicts } from './mechanical-proofs.js';
import { escalationRefusals } from './escalation.js';
import { leadHoldRefusal } from './delegation.js';
import { currentEvidence, evidenceIndependenceRefusals } from './evidence.js';
import { inheritedObligations } from './bootstrap.js';
import { exactApproval, exhaustedReviewerProfiles, reviewProviderOf, reviewerProfileFor } from './review.js';
import { carriedApproval, evidenceBindsCandidate } from './carry.js';

const failedConclusions = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale', 'neutral']);

export interface LandabilityVerdictRefusal {
  gate: string;
  reason: string;
}

export type LandabilityVerdict =
  | { verdict: 'landable' }
  | { verdict: 'refused'; reasons: LandabilityVerdictRefusal[] };

/**
 * Pure evaluation of whether a candidate can land: computed once from the same inputs
 * the gates use today, never read from a stored or cached verdict.
 *
 * Returns LANDABLE when a candidate passes all criteria that would be required at merge time,
 * or REFUSED with the specific gates and reasons why it cannot merge.
 *
 * This is the single authority for landability that the build gate, acceptance checks,
 * merge queue, and landing guard all consume.
 */
export function evaluateLandability(work: Work, all: Work[], now: Date, ciAppIds: number[] = []): LandabilityVerdict {
  const candidate = work.candidate;
  const obs = work.observation;
  const current = !!candidate && !!obs && obs.candidate.sha === candidate.sha && obs.candidate.baseSha === candidate.baseSha;

  const reasons: LandabilityVerdictRefusal[] = [];
  const add = (gate: string, refusals: string[]) => {
    for (const reason of refusals) {
      reasons.push({ gate, reason });
    }
  };

  // If there's no candidate or observation, nothing can land.
  if (!candidate || !obs) {
    add('ready', !candidate ? ['Pull request has not been independently observed'] : []);
    return { verdict: 'refused', reasons };
  }

  // Check if the observation matches the candidate (SHA and base must align).
  if (obs.candidate.sha !== candidate.sha || obs.candidate.baseSha !== candidate.baseSha) {
    return { verdict: 'refused', reasons: [{ gate: 'ready', reason: 'Candidate observation is stale' }] };
  }

  // Mechanical verification: a unit or integration proof that failed returns a refusal.
  if (current && work.submission && !work.reworkRequested) {
    const mechanical = mechanicalVerdicts(work, all, now)
      .filter(verdict => verdict.outcome === 'failed')
      .map(verdict => mechanicalFailure(verdict, candidate.sha));
    add('build', mechanical);
  }

  // Regression checks: scope and file ownership issues.
  if (current) {
    const regressions = regressionRefusals(work, obs, all);
    add('build', regressions);
  }

  // Base refresh conflict: a base the control plane cannot merge in cleanly.
  const conflict = baseRefreshConflict(work);
  if (conflict) {
    add('build', [conflict]);
  }

  // Review checks: approval status.
  const provider = reviewProviderOf(work.policy);
  const selectedProfile = reviewerProfileFor(work);
  const reviewPassed = !!exactApproval(work) || !!carriedApproval(work);
  const reviewRefusal = provider === 'codex'
    ? obs.agentReview?.reason ?? 'Verified clean Codex review of the current commit is required'
    : provider === 'agent'
      ? !selectedProfile
        ? `Every configured reviewer profile is exhausted for this candidate (${exhaustedReviewerProfiles(work).join(', ') || 'none configured'}); add reviewer capacity or select another review provider`
        : obs.agentReview?.reason ?? `Verified approval from reviewer profile ${selectedProfile.name} is required for the current commit`
      : work.formalReviewResetRequired
        ? 'A new independent GitHub approval after the requirement-review baseline is required'
        : 'Independent approval of the current commit is required';

  if (work.policy.review && !reviewPassed) {
    add('review', [reviewRefusal]);
  }

  const changesRequested = obs.reviews?.some(r => r.state === 'CHANGES_REQUESTED');
  if (work.policy.review && changesRequested) {
    add('review', ['Outstanding change requests must be resolved through a new review']);
  }

  // Test checks: required CI checks passing.
  const failedChecks = work.policy.checks.filter(name => {
    const checks = obs.checks?.filter(c => c.name === name && ciAppIds.includes(c.appId)) ?? [];
    const latestCheck = checks.sort((a, b) => (b.attempt ?? 0) - (a.attempt ?? 0))[0];
    return !latestCheck || latestCheck.result !== 'success';
  });
  add('test', failedChecks.map(name => `Required CI check ${name} has not passed on the current candidate`));

  // Acceptance checks: evidence and proofs.
  const acceptanceReasons: string[] = [];
  const unproven = (proof: string) => {
    const evidence = currentEvidence(work, proof, now);
    return !evidence || evidence.result !== 'pass' || evidence.executed < 1 || evidence.skipped !== 0;
  };
  const demanded = (proof: string) => {
    const scenario = work.scenarioRequirements?.find(s => s.proof === proof);
    const revoked = work.evidence.some(e => e.proof === proof && e.trusted && !!e.revocation && evidenceBindsCandidate(work, e) && e.policyRevision === work.policyRevision);
    return `${proof} needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy${scenario ? `; scenario v${scenario.revision} in ${scenario.environment}` : ''}${revoked && !currentEvidence(work, proof, now) ? '; previously accepted evidence was revoked' : ''}`;
  };

  for (const ac of work.criteria.filter(criterion => !criterion.bootstrap)) {
    for (const proof of ac.proofs) {
      if (unproven(proof)) acceptanceReasons.push(`${ac.id}: ${demanded(proof)}`);
    }
  }

  for (const obligation of inheritedObligations(work, all)) {
    if (unproven(obligation.proof)) {
      acceptanceReasons.push(`Bootstrap obligation inherited from ${obligation.key} ${obligation.criterionId}: ${demanded(obligation.proof)}`);
    }
  }

  acceptanceReasons.push(...evidenceIndependenceRefusals(work, now));
  add('acceptance', acceptanceReasons);

  // Delivery checks: escalations and holds.
  add('delivery', [...escalationRefusals(work), ...(leadHoldRefusal(work) ? [leadHoldRefusal(work)!] : [])]);

  // Merge checks: mergeability and protection status.
  if (!obs.merged && !obs.mergeable && !obs.mergeabilityUnknown) {
    add('merge', ['Pull request is not mergeable against the current base']);
  }

  const threads = conversationProtectionRefusal(work);
  if (threads) {
    add('merge', [threads]);
  }

  // Queue-specific checks: apply when evaluating a queued entry.
  if (work.queue) {
    if (!work.submission || work.reworkRequested) {
      add('queue', ['Implementation returned to the worker for a new attempt']);
    } else if (work.policyRevision !== work.queue.policyRevision) {
      add('queue', [`Policy revision changed from ${work.queue.policyRevision} to ${work.policyRevision} after this entry was queued`]);
    } else if (work.blocker) {
      add('queue', [`Queued work was blocked: ${work.blocker}`]);
    } else if (work.violations.length) {
      add('queue', [`Queued work has an open violation: ${work.violations[0]}`]);
    }

    // PR state checks.
    if (obs.prState === 'closed') {
      add('queue', ['Pull request was closed without merging']);
    }

    // Stale tip regressions (GY-568).
    const unexcused = staleTipRegressions(work, obs, all);
    if (unexcused.length) {
      const stale = staleSpeculativeTip(work, all);
      if (stale) {
        add('queue', [`Speculative tip was built behind ${stale.departed.join(', ')}, which left the merge queue without landing; landing it would carry their unlanded work, so the branch needs restoration`]);
      }
    }

    // Queued regressions.
    const regressions = queuedRegressions(work, obs, all);
    if (regressions.length) {
      add('queue', [`Landing speculative tip would revert work outside its planned files: ${regressions.map(entry => entry.text).join('; ')}`]);
    }

    // Failed required checks on the speculative tip.
    const failedCheck = (work.policy?.checks ?? []).find(name => {
      const run = latestCheck((obs.checks ?? []).filter(entry => entry.name === name && ciAppIds.includes(entry.appId)));
      return !!run && failedConclusions.has(run.result) && !holdingCheckRerun(work, obs.candidate.sha, name, run);
    });
    if (failedCheck) {
      add('queue', [`Required CI check ${failedCheck} did not pass on speculative tip`]);
    }

    // Failed or revoked proofs.
    const failedProof = work.evidence.find(item => item.trusted && item.result === 'fail' && evidenceBindsCandidate(work, item) && item.policyRevision === work.policyRevision);
    if (failedProof) {
      add('queue', [`Proof ${failedProof.proof} failed on speculative tip`]);
    }

    const revokedProof = work.evidence.find(item => item.trusted && !!item.revocation && evidenceBindsCandidate(work, item) && item.policyRevision === work.policyRevision);
    if (revokedProof) {
      add('queue', [`Proof ${revokedProof.proof} was revoked: ${revokedProof.revocation!.reason}`]);
    }
  }

  return reasons.length ? { verdict: 'refused', reasons } : { verdict: 'landable' };
}
