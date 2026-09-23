import type { Work } from './work.js';
import type { ProducerGroup, ReviewState } from './dispatch.js';
import { currentEvidence } from './evidence.js';
import { requiredProofs } from './bootstrap.js';

/**
 * Which required proofs a machine settles, and what the evidence bound to the head says of each
 * (GY-115). Kept free of Node built-ins: the build gate reads it, and the gates ship in the
 * browser bundle.
 */

const short = (sha: string) => sha.slice(0, 12);

/** A proof a launched producer session can run: every unit and integration proof, and a manual proof the item marks producer-runnable. */
export const automatableProof = (work: Pick<Work, 'producerProofs'>, proof: string) =>
  /^(unit|integration):/.test(proof) || proof.startsWith('manual:') && (work.producerProofs ?? []).includes(proof);
export const producerGroupOf = (proof: string): ProducerGroup => proof.slice(0, proof.indexOf(':')) as ProducerGroup;
/**
 * A proof a machine settles without judgment: every unit and integration proof. These run before a
 * reviewer is asked for anything (GY-115); a manual proof, even one a producer session runs, is
 * judgment and stays beside the review rather than ahead of it.
 */
export const mechanicalProof = (proof: string) => /^(unit|integration):/.test(proof);

export type ProofOutcome = 'proven' | 'unproven' | 'failed';
/** Every automatable required proof with what the trusted evidence bound to this head says about it. */
export function automatableOutcomes(work: Work, all: Work[], now: Date): { proof: string; group: ProducerGroup; outcome: ProofOutcome; producer?: string }[] {
  return requiredProofs(work, all).filter(proof => automatableProof(work, proof)).map(proof => {
    const evidence = currentEvidence(work, proof, now);
    const outcome: ProofOutcome = !evidence ? 'unproven' : evidence.result === 'pass' && evidence.executed > 0 && evidence.skipped === 0 ? 'proven' : 'failed';
    return { proof, group: producerGroupOf(proof), outcome, ...(evidence ? { producer: evidence.producer } : {}) };
  });
}

/** One mechanical proof of the head, read as the criteria that name it read it. */
export interface MechanicalVerdict { criteria: string[]; proof: string; outcome: ProofOutcome; producer?: string }
export function mechanicalVerdicts(work: Work, all: Work[], now: Date): MechanicalVerdict[] {
  const named = (proof: string) => work.criteria.filter(criterion => !criterion.bootstrap && criterion.proofs.includes(proof)).map(criterion => criterion.id);
  return automatableOutcomes(work, all, now).filter(entry => mechanicalProof(entry.proof))
    .map(entry => ({ criteria: named(entry.proof), proof: entry.proof, outcome: entry.outcome, ...(entry.producer ? { producer: entry.producer } : {}) }));
}
const criteriaOf = (verdict: MechanicalVerdict) => verdict.criteria.length ? verdict.criteria.join(', ') : 'an inherited obligation';
/**
 * The build-gate refusal that returns a head to its worker for one failed mechanical proof, naming
 * the criterion. Because the build gate refuses, no review request stands for the head.
 */
export const mechanicalFailure = (verdict: MechanicalVerdict, sha: string) =>
  `${criteriaOf(verdict)}: ${verdict.proof} failed on ${short(sha)} (trusted evidence from ${verdict.producer}); the head returns to its worker before review`;

/** Why no reviewer may be asked about this head yet, or null once every mechanical proof has passed on it. */
export function mechanicalHold(work: Work, all: Work[], now: Date): { needed: false; reason: string; state: ReviewState } | null {
  if (!work.candidate) return null;
  const verdicts = mechanicalVerdicts(work, all, now), sha = work.candidate.sha;
  const failed = verdicts.filter(verdict => verdict.outcome === 'failed');
  if (failed.length) return { needed: false, state: 'proof-failed', reason: failed.map(verdict => mechanicalFailure(verdict, sha)).join('; ') };
  const pending = verdicts.filter(verdict => verdict.outcome === 'unproven');
  if (pending.length) return { needed: false, state: 'proofs-pending', reason: `review follows the mechanical proofs: ${pending.map(verdict => `${criteriaOf(verdict)} ${verdict.proof}`).join(', ')} ${pending.length === 1 ? 'has' : 'have'} not passed on ${short(sha)} yet` };
  return null;
}
