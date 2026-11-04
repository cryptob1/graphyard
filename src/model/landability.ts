import type { Work } from './work.js';
import { evidenceBindsCandidate } from './carry.js';
import { baseRefreshConflict } from './base-refresh.js';
import { mechanicalVerdicts, mechanicalFailure, evidenceProves } from './mechanical-proofs.js';
import { requiredProofs } from './bootstrap.js';
import { postDeployProof } from './post-merge-proofs.js';
import { currentEvidence } from './evidence.js';
import type {  } from './merge-ledger.js';
// Work.mergeLedger

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
export function inputsOf(work: Work): LandabilityInputs {
  const obs = work.observation;
  return {
    key: work.key, sha: work.candidate?.sha ?? null, baseSha: work.candidate?.baseSha ?? null, policyRevision: work.policyRevision,
    observed: obs ? { sha: obs.candidate.sha, baseSha: obs.candidate.baseSha } : null, landingBase: obs?.landing?.base ?? null,
    evidence: work.evidence.filter(entry => entry.policyRevision === work.policyRevision && evidenceBindsCandidate(work, entry)).map(entry => entry.id).sort(),
  };
}

/** The build family: exactly the build gate's refusals, in its order. */
export function buildFamily(work: Work, all: Work[], now: Date): LandabilityReason[] {
  const candidate = work.candidate, obs = work.observation;
  const current = !!candidate && !!obs && obs.candidate.sha === candidate.sha && obs.candidate.baseSha === candidate.baseSha;
  const conflict = baseRefreshConflict(work);
  // Mechanical verification precedes review (GY-115). It is producer evidence, which a
  // control-plane candidate ignores (GY-1528): the merge writer's trial judges its tests.
  const mechanical = current && work.submission && !work.reworkRequested && !controlPlaneObserved(work)
    ? mechanicalVerdicts(work, all, now).filter(verdict => verdict.outcome === 'failed').map(verdict => mechanicalFailure(verdict, candidate!.sha)) : [];
  const reasons: LandabilityReason[] = [
    ...(!work.submission || work.reworkRequested ? ['Worker has not submitted implementation for this attempt'] : []),
    ...(!candidate ? ['Pull request has not been independently observed'] : []),
    ...(!work.workspaces.length ? ['No workspace registered'] : []),
    ...(conflict ? [conflict] : []),
  ].map(reason => ({ gate: 'build' as const, reason }));
  reasons.push(...mechanical.map(reason => ({ gate: 'build' as const, reason })));
  return reasons;
}

/** Whether the candidate is the control plane's own observation (GY-1523): the retired gates are off for it (GY-1528). */
export const controlPlaneObserved = (work: Pick<Work, 'observation'>) => work.observation?.source === 'control-plane';

/**
 * A judged failure of a proof no criterion or obligation requires is still a failure of the change
 * (GY-868): the build family refuses it, returning the head to its worker. One failing record is no
 * conclusion: a trusted `manual:` proof whose executed is 0 judged nothing — the unexercised finding
 * answered by an attestation the loop requests for a proof a criterion of this item names (GY-875,
 * GY-910) — so it refuses nothing here.
 */
export function strayProofFailure(work: Work, all: Work[], now: Date, acceptance: (LandabilityReason & { proof?: string })[], judged: boolean): LandabilityReason | null {
  const candidate = work.candidate;
  if (!candidate || !judged) return null;
  const refused = new Set(acceptance.flatMap(entry => entry.proof ? [entry.proof] : []));
  const required = new Set(requiredProofs(work, all));
  const stray = (proof: string) => !postDeployProof(proof) && !required.has(proof) && !refused.has(proof) && !(currentEvidence(work, proof, now) && evidenceProves(proof, currentEvidence(work, proof, now)!));
  const failed = work.evidence.find(item => item.trusted && evidenceBindsCandidate(work, item) && item.policyRevision === work.policyRevision && item.result === 'fail' && stray(item.proof)
    && !(item.proof.startsWith('manual:') && item.executed === 0 && work.criteria.some(criterion => criterion.proofs.includes(item.proof))));
  return failed ? { gate: 'build', reason: `${failed.proof}, which no criterion requires, failed on ${candidate.sha.slice(0, 12)} (trusted evidence from ${failed.producer}); the head returns to its worker before review` } : null;
}

/** The refusal reasons of one gate family, as the gate words them. */
export function landabilityRefusals(verdict: LandabilityVerdict, gate: LandabilityGate): string[] {
  return verdict.verdict === 'refused' ? verdict.reasons.filter(entry => entry.gate === gate).map(entry => entry.reason) : [];
}

/** The audit a refusal records: the verdict version and its inputs. */
export const landabilityAudit = (verdict: LandabilityVerdict): LandabilityAudit => ({ version: verdict.version, inputs: verdict.inputs });
