import type { Work, Observation } from './work.js';
import { regressionRefusals, queuedRegressions, staleTipRegressions } from '../regression-guard.js';
import { currentEvidence, evidenceIndependenceRefusals } from './evidence.js';
import { inheritedObligations } from './bootstrap.js';
import { evidenceBindsCandidate } from './carry.js';
import { stableJson } from './stable-json.js';

export const LANDABILITY_VERSION = 1;

export interface LandabilityVerdictRefusal {
  gate: 'build' | 'acceptance';
  reason: string;
  adverse?: boolean;
}

export type LandabilityVerdict =
  | { verdict: 'landable' }
  | { verdict: 'refused'; reasons: LandabilityVerdictRefusal[] };

/**
 * Pure evaluation of whether a candidate can land based on regression and acceptance families.
 *
 * Computed once from the same inputs the gates use today, never read from a stored or cached verdict.
 * Returns LANDABLE when the candidate passes the regression and acceptance criteria,
 * or REFUSED with the specific gate, reason, and whether it's an adverse conclusion (failure)
 * or unexercised (not yet attempted).
 *
 * This is the single authority for landability that build gate, acceptance checks,
 * merge queue, and landing guard all consume.
 */
export function evaluateLandability(work: Work, all: Work[], now: Date): LandabilityVerdict {
  const candidate = work.candidate;
  const obs = work.observation;
  const current = !!candidate && !!obs && obs.candidate.sha === candidate.sha && obs.candidate.baseSha === candidate.baseSha;

  const reasons: LandabilityVerdictRefusal[] = [];
  const add = (gate: 'build' | 'acceptance', refusals: Array<{ reason: string; adverse?: boolean }>) => {
    for (const r of refusals) {
      reasons.push({ gate, reason: r.reason, adverse: r.adverse });
    }
  };

  // If there's no candidate or observation, cannot evaluate regression family
  if (!candidate || !obs) {
    if (!candidate) {
      add('build', [{ reason: 'Pull request has not been independently observed' }]);
    }
    // Return early with just the build refusal - acceptance needs observation for scope context
    return { verdict: 'refused', reasons };
  }

  // If observation doesn't match the candidate, it's stale
  if (!current) {
    add('build', [{ reason: 'Candidate observation is stale' }]);
    return { verdict: 'refused', reasons };
  }

  // Build gate: regression family
  const regressions = regressionRefusals(work, obs, all)
    .map(reason => ({ reason }));
  add('build', regressions);

  // Acceptance gate: evidence family
  const unproven = (proof: string) => {
    const evidence = currentEvidence(work, proof, now);
    return !evidence || evidence.result !== 'pass' || evidence.executed < 1 || evidence.skipped !== 0;
  };

  const demanded = (proof: string) => {
    const scenario = work.scenarioRequirements?.find(s => s.proof === proof);
    const revoked = work.evidence.some(e =>
      e.proof === proof && e.trusted && !!e.revocation &&
      evidenceBindsCandidate(work, e) &&
      e.policyRevision === work.policyRevision
    );
    return `${proof} needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy${
      scenario ? `; scenario v${scenario.revision} in ${scenario.environment}` : ''
    }${
      revoked && !currentEvidence(work, proof, now) ? '; previously accepted evidence was revoked' : ''
    }`;
  };

  const acceptanceReasons: Array<{ reason: string; adverse?: boolean }> = [];

  // Check required proofs from criteria
  for (const ac of work.criteria.filter(criterion => !criterion.bootstrap)) {
    for (const proof of ac.proofs) {
      if (unproven(proof)) {
        acceptanceReasons.push({ reason: `${ac.id}: ${demanded(proof)}` });
      }
    }
  }

  // Check inherited bootstrap obligations
  for (const obligation of inheritedObligations(work, all)) {
    if (unproven(obligation.proof)) {
      acceptanceReasons.push({ reason: `Bootstrap obligation inherited from ${obligation.key} ${obligation.criterionId}: ${demanded(obligation.proof)}` });
    }
  }

  // Check evidence independence
  acceptanceReasons.push(...evidenceIndependenceRefusals(work, now).map(reason => ({ reason })));

  add('acceptance', acceptanceReasons);

  return reasons.length ? { verdict: 'refused', reasons } : { verdict: 'landable' };
}
