import type { Work } from '../model/work.js';
import { type LandabilityReason, controlPlaneObserved, type LandabilityVerdict, buildFamily, strayProofFailure, LANDABILITY_VERSION, inputsOf } from '../model/landability.js';
import { postDeployProof } from '../model/post-merge-proofs.js';
import { currentEvidence, evidenceIndependenceRefusals } from '../model/evidence.js';
import { evidenceProves, attestedProof } from '../model/mechanical-proofs.js';
import { inheritedObligations } from '../model/bootstrap.js';
import { evidenceBindsCandidate } from '../model/carry.js';
import type {  } from './merge-ledger.js';
/**
 * GY-1528. The acceptance family of a control-plane candidate. The merge writer's trial is the
 * judge of the tests, not a producer: each criterion's `unit:`/`integration:`/`e2e:` proof needs
 * executed > 0 and failed = 0 in `work.mergeLedger.trial.proofs` for the current head (GY-2965: an
 * `e2e:` proof's counts are its bound case's run against the served head; a missing or failing case
 * refuses the head at the trial itself); a declared merge-time `manual:` attestation is always required; and producer evidence is ignored, so no independence refusal is read.
 */
function controlPlaneAcceptance(work: Work, all: Work[], now: Date): (LandabilityReason & { proof?: string })[] {
  const head = work.candidate?.sha.toLowerCase() ?? null, trial = work.mergeLedger?.trial ?? null;
  const tried = !!head && trial?.head.toLowerCase() === head ? trial : null;
  const refusal = (proof: string): string | null => {
    // A declared post-deploy proof (GY-1660) is observed on the serving release after delivery, never gating the merge.
    if (postDeployProof(proof)) return null;
    const family = proof.slice(0, Math.max(0, proof.indexOf(':')));
    if (family === 'unit' || family === 'integration' || family === 'e2e') {
      const counts = tried?.proofs[proof];
      if (counts && counts.executed > 0 && counts.failed === 0) return null;
      const seen = !head ? 'there is no candidate' : !tried ? `the merge writer has not trialled ${head.slice(0, 12)}` : !counts ? 'the trial counted none of its cases' : `the trial ran ${counts.executed} and ${counts.failed} failed`;
      return `${proof} needs executed > 0 and failed = 0 in the merge writer's trial of this candidate; ${seen}`;
    }
    if (family === 'manual') {
      const evidence = currentEvidence(work, proof, now);
      return evidence && evidenceProves(proof, evidence) ? null : `${proof} needs a trusted passing attestation for this candidate and policy`;
    }
    // `e2e:` runs in release validation; any other family was a producer's, whose evidence this mode ignores.
    return null;
  };
  const reasons: (LandabilityReason & { proof?: string })[] = [];
  for (const ac of work.criteria.filter(criterion => !criterion.bootstrap)) for (const proof of ac.proofs) {
    const reason = refusal(proof);
    if (reason) reasons.push({ gate: 'acceptance', reason: `${ac.id}: ${reason}`, proof });
  }
  for (const obligation of inheritedObligations(work, all)) {
    const reason = refusal(obligation.proof);
    if (reason) reasons.push({ gate: 'acceptance', reason: `Bootstrap obligation inherited from ${obligation.key} ${obligation.criterionId}: ${reason}`, proof: obligation.proof });
  }
  return reasons;
}

/** The acceptance family: exactly the acceptance gate's refusals, each tagged with the proof it demands. */
function acceptanceFamily(work: Work, all: Work[], now: Date): (LandabilityReason & { proof?: string })[] {
  if (controlPlaneObserved(work)) return controlPlaneAcceptance(work, all, now);
  // GY-895: the pass rule is per family — a manual: proof is judged as an attestation, so its
  // trusted pass proves it whatever it executed, while every other proof keeps the title-count rule.
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
  const reasons: (LandabilityReason & { proof?: string })[] = [];
  // A bootstrap criterion's proofs are deferred here and required of the next change that
  // touches the same contract; review, CI and every other criterion still gate this one.
  // A declared post-deploy proof (GY-1660) is observed on the serving release, never before the merge.
  for (const ac of work.criteria.filter(criterion => !criterion.bootstrap)) for (const proof of ac.proofs) {
    if (!postDeployProof(proof) && unproven(proof)) reasons.push({ gate: 'acceptance', reason: `${ac.id}: ${demanded(proof)}`, proof });
  }
  for (const obligation of inheritedObligations(work, all)) {
    if (unproven(obligation.proof)) reasons.push({ gate: 'acceptance', reason: `Bootstrap obligation inherited from ${obligation.key} ${obligation.criterionId}: ${demanded(obligation.proof)}`, proof: obligation.proof });
  }
  // Independence is re-decided on every evaluation, so evidence minted before its
  // producer joined the implementer set refuses acceptance with a named reason.
  reasons.push(...evidenceIndependenceRefusals(work, now).map(reason => ({ gate: 'acceptance' as const, reason })));
  return reasons;
}

/**
 * The single landability verdict for a work item's current candidate under its current policy:
 * `landable`, or `refused` with every reason, each naming the gate it refuses. Pure: the same
 * item, peers and instant always give the same verdict, and nothing stored is consulted.
 */
export function evaluateLandability(work: Work, all: Work[], now: Date): LandabilityVerdict {
  const build = buildFamily(work, all, now);
  // A stray judged failure is read where the build family reads the tree: on the observed candidate
  // of a submitted attempt.
  const candidate = work.candidate, obs = work.observation;
  const judged = !!candidate && !!obs && obs.candidate.sha === candidate.sha && obs.candidate.baseSha === candidate.baseSha
    && !!work.submission && !work.reworkRequested;
  const tagged = acceptanceFamily(work, all, now);
  // A producer's judged failure is producer evidence, which a control-plane candidate ignores (GY-1528).
  const stray = controlPlaneObserved(work) ? null : strayProofFailure(work, all, now, tagged, judged);
  if (stray) build.push(stray);
  const reasons = [...build, ...tagged.map(({ proof: _proof, ...entry }) => entry)];
  const audit = { version: LANDABILITY_VERSION, inputs: inputsOf(work) };
  return reasons.length ? { verdict: 'refused', reasons, ...audit } : { verdict: 'landable', ...audit };
}
