import { baseRefreshConflict } from '../merge-queue.js';
import type { Work } from './work.js';
import { currentEvidence, evidenceIndependenceRefusals } from './evidence.js';
import { inheritedObligations, requiredProofs } from './bootstrap.js';
import { evidenceBindsCandidate } from './carry.js';
import { mechanicalFailure, mechanicalVerdicts, evidenceProves, attestedProof } from './mechanical-proofs.js';
import { regressionRefusals } from '../regression-guard.js';
import { itemLane, laneRequiresProof } from './policy.js';

/**
 * GY-878. One landability verdict. `evaluateLandability` is the single authority on whether a
 * candidate can land: the build and acceptance gates are its two families, word for word.
 *
 * The verdict is pure and deterministic: it is computed on demand from the live facts keyed by the
 * candidate SHA and policy revision (observation, evidence, peers, `now`), never stored and never
 * read back — a stored verdict would go stale exactly as GY-710's did. What is recorded is the
 * audit of a refusal (`version` and `inputs`) on the gate.
 */
export const LANDABILITY_VERSION = 1;

export type LandabilityGate = 'build' | 'acceptance';
export interface LandabilityReason {
  gate: LandabilityGate;
  reason: string;
}
/** What the verdict was computed from: the candidate identity, the policy revision and the evidence it read. */
export interface LandabilityInputs {
  key: string; sha: string | null; baseSha: string | null; policyRevision: number;
  observed: { sha: string; baseSha: string } | null; landingBase: string | null; evidence: string[];
}
export interface LandabilityAudit { version: number; inputs: LandabilityInputs }
export type LandabilityVerdict =
  | ({ verdict: 'landable' } & LandabilityAudit)
  | ({ verdict: 'refused'; reasons: LandabilityReason[] } & LandabilityAudit);

declare module './work.js' {
  interface Gate {
    /** GY-878: the landability verdict's version and inputs, recorded on a refused build or acceptance gate. */
    verdict?: LandabilityAudit;
  }
}
function inputsOf(work: Work): LandabilityInputs {
  const obs = work.observation;
  return {
    key: work.key, sha: work.candidate?.sha ?? null, baseSha: work.candidate?.baseSha ?? null, policyRevision: work.policyRevision,
    observed: obs ? { sha: obs.candidate.sha, baseSha: obs.candidate.baseSha } : null, landingBase: obs?.landing?.base ?? null,
    evidence: work.evidence.filter(entry => entry.policyRevision === work.policyRevision && evidenceBindsCandidate(work, entry)).map(entry => entry.id).sort(),
  };
}

/** The build family: exactly the build gate's refusals, in its order. */
function buildFamily(work: Work, all: Work[], now: Date): LandabilityReason[] {
  const candidate = work.candidate, obs = work.observation;
  const current = !!candidate && !!obs && obs.candidate.sha === candidate.sha && obs.candidate.baseSha === candidate.baseSha;
  const conflict = baseRefreshConflict(work);
  // Mechanical verification precedes review (GY-115).
  const mechanical = current && work.submission && !work.reworkRequested
    ? mechanicalVerdicts(work, all, now).filter(verdict => verdict.outcome === 'failed').map(verdict => mechanicalFailure(verdict, candidate!.sha)) : [];
  const regressions = current ? regressionRefusals(work, obs!, all) : [];
  const reasons: LandabilityReason[] = [
    ...(!work.submission || work.reworkRequested ? ['Worker has not submitted implementation for this attempt'] : []),
    ...(!candidate ? ['Pull request has not been independently observed'] : []),
    ...(!work.workspaces.length ? ['No workspace registered'] : []),
    ...(conflict ? [conflict] : []),
  ].map(reason => ({ gate: 'build' as const, reason }));
  reasons.push(...regressions.map(reason => ({ gate: 'build' as const, reason })), ...mechanical.map(reason => ({ gate: 'build' as const, reason })));
  return reasons;
}

/** The acceptance family: exactly the acceptance gate's refusals, each tagged with the proof it demands. */
function acceptanceFamily(work: Work, all: Work[], now: Date): (LandabilityReason & { proof?: string })[] {
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
  // The item's risk lane is an input to this verdict (GY-883): it decides which of the criteria's
  // proofs are required — low none of their producer-run or manual ones, medium no manual one,
  // high all — while an e2e proof and an inherited obligation are required in every lane.
  const lane = itemLane(work);
  for (const ac of work.criteria.filter(criterion => !criterion.bootstrap)) for (const proof of ac.proofs) {
    if (laneRequiresProof(lane, proof) && unproven(proof)) reasons.push({ gate: 'acceptance', reason: `${ac.id}: ${demanded(proof)}`, proof });
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
 * A judged failure of a proof no criterion or obligation requires is still a failure of the change
 * (GY-868): the build family refuses it, returning the head to its worker. One failing record is no
 * conclusion: a trusted `manual:` proof whose executed is 0 judged nothing — the unexercised finding
 * answered by an attestation the loop requests for a proof a criterion of this item names (GY-875,
 * GY-910) — so it refuses nothing here.
 */
function strayProofFailure(work: Work, all: Work[], now: Date, acceptance: (LandabilityReason & { proof?: string })[], judged: boolean): LandabilityReason | null {
  const candidate = work.candidate;
  if (!candidate || !judged) return null;
  const refused = new Set(acceptance.flatMap(entry => entry.proof ? [entry.proof] : []));
  const required = new Set(requiredProofs(work, all));
  const stray = (proof: string) => !required.has(proof) && !refused.has(proof) && !(currentEvidence(work, proof, now) && evidenceProves(proof, currentEvidence(work, proof, now)!));
  const failed = work.evidence.find(item => item.trusted && evidenceBindsCandidate(work, item) && item.policyRevision === work.policyRevision && item.result === 'fail' && stray(item.proof)
    && !(item.proof.startsWith('manual:') && item.executed === 0 && work.criteria.some(criterion => criterion.proofs.includes(item.proof))));
  return failed ? { gate: 'build', reason: `${failed.proof}, which no criterion requires, failed on ${candidate.sha.slice(0, 12)} (trusted evidence from ${failed.producer}); the head returns to its worker before review` } : null;
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
  const stray = strayProofFailure(work, all, now, tagged, judged);
  if (stray) build.push(stray);
  const reasons = [...build, ...tagged.map(({ proof: _proof, ...entry }) => entry)];
  const audit = { version: LANDABILITY_VERSION, inputs: inputsOf(work) };
  return reasons.length ? { verdict: 'refused', reasons, ...audit } : { verdict: 'landable', ...audit };
}

/** The refusal reasons of one gate family, as the gate words them. */
export function landabilityRefusals(verdict: LandabilityVerdict, gate: LandabilityGate): string[] {
  return verdict.verdict === 'refused' ? verdict.reasons.filter(entry => entry.gate === gate).map(entry => entry.reason) : [];
}

/** The audit a refusal records: the verdict version and its inputs. */
export const landabilityAudit = (verdict: LandabilityVerdict): LandabilityAudit => ({ version: verdict.version, inputs: verdict.inputs });

