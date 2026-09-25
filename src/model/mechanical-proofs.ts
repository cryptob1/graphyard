import type { Work } from './work.js';
import type { DispatchRequest, ReviewState } from './dispatch.js';
import { currentEvidence } from './evidence.js';
import { requiredProofs } from './bootstrap.js';

/**
 * Which required proofs a machine settles, and what the evidence bound to the head says of each
 * (GY-115). Kept free of Node built-ins: the build gate reads it, and the gates ship in the
 * browser bundle.
 */

const short = (sha: string) => sha.slice(0, 12);

/** One producer session runs one group: every automatable proof of one kind, on one head. */
export const producerGroups = ['unit', 'integration', 'manual'] as const;
export type ProducerGroup = typeof producerGroups[number];

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

/** Why no request may stand for the candidate right now, or null when the head is a live, observed, buildable candidate. */
export function dispatchIneligibility(work: Work): string | null {
  if (work.stage === 'done') return 'the work is delivered';
  if (work.observation?.merged) return 'the pull request is merged';
  if (!work.submission) return 'no candidate is submitted';
  if (work.reworkRequested) return 'rework was requested; the next submitted candidate is requested afresh';
  const candidate = work.candidate, observation = work.observation;
  if (!candidate || !observation || observation.candidate.sha !== candidate.sha || observation.candidate.baseSha !== candidate.baseSha) return 'the candidate has not been independently observed';
  if (observation.prState === 'closed') return 'the pull request is closed';
  if (observation.draft) return 'the pull request is a draft';
  const build = work.gates.find(gate => gate.name === 'build');
  if (build && !build.passed) return `the build gate refuses: ${build.reasons[0]}`;
  return null;
}

/**
 * What the control plane decides for one proof group of the head, and the one predicate both of
 * its readers use (GY-188). `reconcileAutoDispatch` opens a producer request for a group exactly
 * when it is `request`; the next-action planner names a proof dispatch only for a group that is
 * `request` *and* already holds that open request. The planner once asked for a producer for any
 * group with an unproven proof — including a group a sibling proof of which had already failed,
 * and a head no request may stand for — while the reconciler refused both, so the executor threw
 * "no open producer request" at the same row for a day and more.
 *
 * - `failed` — trusted evidence failed for a proof of the group. Nothing is asked for this head;
 *   the next head is requested afresh.
 * - `ineligible` — no request may stand for the head at all (`dispatchIneligibility`).
 * - `proven` — trusted passing evidence binds every proof of the group.
 * - `request` — something is left to prove and nothing refuses asking for it.
 */
export type ProducerGroupState = 'request' | 'failed' | 'proven' | 'ineligible';
export interface ProducerGroupDecision {
  group: ProducerGroup; state: ProducerGroupState;
  /** The group's proofs no evidence binds yet: what a request for it asks for. */
  unproven: string[];
  /** The group's proofs trusted evidence failed, with the producer that reported each. */
  failed: { proof: string; producer?: string }[];
  reason: string;
}
export function producerGroupDecisions(work: Work, all: Work[], now: Date, outcomes = automatableOutcomes(work, all, now)): ProducerGroupDecision[] {
  const ineligible = dispatchIneligibility(work);
  const sha = work.candidate ? short(work.candidate.sha) : 'no candidate';
  return producerGroups.flatMap(group => {
    const mine = outcomes.filter(entry => entry.group === group);
    if (!mine.length) return [];
    const unproven = mine.filter(entry => entry.outcome === 'unproven').map(entry => entry.proof);
    const failed = mine.filter(entry => entry.outcome === 'failed').map(entry => ({ proof: entry.proof, ...(entry.producer ? { producer: entry.producer } : {}) }));
    const decision = (state: ProducerGroupState, reason: string): ProducerGroupDecision => ({ group, state, unproven, failed, reason });
    if (failed.length) return [decision('failed', `trusted evidence failed on ${sha} for ${failed.map(entry => `${entry.proof} (${entry.producer ?? 'unknown producer'})`).join(', ')}; the next head is requested afresh`)];
    if (!unproven.length) return [decision('proven', `trusted passing evidence binds every ${group} proof on ${sha}`)];
    if (ineligible) return [decision('ineligible', `no producer request may stand for ${sha}: ${ineligible}`)];
    return [decision('request', `no trusted evidence binds ${sha} for ${unproven.join(', ')}`)];
  });
}

/** The live producer request bound to the current head for one group, or null. */
export function openProducerRequest(work: Work, group: ProducerGroup): DispatchRequest | null {
  return (work.autoDispatch?.producers ?? []).find(request => request.group === group && request.state === 'requested' && !!work.candidate
    && request.sha === work.candidate.sha && request.baseSha === work.candidate.baseSha && request.policyRevision === work.policyRevision) ?? null;
}
