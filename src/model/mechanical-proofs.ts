import type { Work } from './work.js';
import type { DispatchRequest, ReviewState } from './dispatch.js';
import { currentEvidence } from './evidence.js';
import { evidenceBindsCandidate } from './carry.js';
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

/**
 * Which proofs are judged as attestations rather than counted from titles (GY-895): only the
 * `manual:` family. Every other family — `unit:`, `integration:`, `e2e:` — keeps the title rule,
 * so the exception never widens past the family the attestation rule was written for.
 */
export const attestedProof = (proof: string) => proof.startsWith('manual:');

/**
 * Whether one proof's trusted record reads as a pass (GY-895). A proof outside `manual:` keeps
 * the title rule: executed counts the test cases whose titles carry the proof id, so a pass with
 * none executed judged nothing. A `manual:` proof is judged as an independent attestation, never
 * counted from titles, so its trusted pass proves it whatever it executed — the rule the producer
 * prompts already state, which the scoring now applies too.
 */
export const evidenceProves = (proof: string, evidence: { result: string; executed: number; skipped: number }) =>
  evidence.result === 'pass' && evidence.skipped === 0 && (attestedProof(proof) || evidence.executed > 0);

export type ProofOutcome = 'proven' | 'unproven' | 'failed';
/**
 * Every automatable required proof with what the trusted evidence bound to this head says about
 * it. GY-883: `requiredProofs` applies the item's risk lane, so a low item's producer-run proofs
 * and a low or medium item's manual attestations are neither tracked here nor dispatched, and no
 * review is held for them. An inherited obligation is tracked in every lane.
 */
export function automatableOutcomes(work: Work, all: Work[], now: Date): { proof: string; group: ProducerGroup; outcome: ProofOutcome; producer?: string }[] {
  return requiredProofs(work, all).filter(proof => automatableProof(work, proof)).map(proof => {
    const evidence = currentEvidence(work, proof, now);
    const outcome: ProofOutcome = !evidence ? 'unproven' : evidenceProves(proof, evidence) ? 'proven' : 'failed';
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
/**
 * GY-868: the trusted `manual:` proofs a producer session may run that failed with cases executed
 * on the head. Such a record is a judgement about the change, so it is the worker's to fix exactly
 * like a mechanical one — proofRework sends the head back, and no operator escalation stands. A
 * record with executed = 0 judged nothing and is an unexercised finding instead (see
 * `unexercisedFindings`); a manual proof no producer may run is the operator-witnessed escalation
 * cycle-delivery records. Neither appears here.
 */
export function producerManualFailures(work: Work, all: Work[], now: Date): MechanicalVerdict[] {
  const named = (proof: string) => work.criteria.filter(criterion => !criterion.bootstrap && criterion.proofs.includes(proof)).map(criterion => criterion.id);
  return automatableOutcomes(work, all, now).filter(entry => !mechanicalProof(entry.proof) && entry.outcome === 'failed'
    && (currentEvidence(work, entry.proof, now)?.executed ?? 0) > 0)
    .map(entry => ({ criteria: named(entry.proof), proof: entry.proof, outcome: entry.outcome, ...(entry.producer ? { producer: entry.producer } : {}) }));
}
/** One producer-run manual failure as the rework names it: judged with cases executed, so the worker fixes the change. */
export const producerManualFailure = (verdict: MechanicalVerdict, sha: string) =>
  `${criteriaOf(verdict)}: ${verdict.proof} failed on ${short(sha)} (trusted evidence from ${verdict.producer}); the producer judged the change and found it inadequate, so the head returns to its worker`;

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

/**
 * The producer's finding that a proof on this head does not exercise its criterion (GY-135): the
 * pass also held with the change removed. Such evidence is the worker's to fix, so the request is
 * never launched again for the head and the loop requests the rework instead (GY-193 AC-3). Each
 * finding carries the criteria the run was held to and the behaviour whose removal — the mutation —
 * left the proof passing, so the planner's rework names all three (GY-817).
 *
 * GY-868: a trusted `manual:` record whose executed is 0 is a finding of the same kind, whatever
 * its result reads: executed counts the cases and checks the producer ran to judge the criterion,
 * so executed = 0 records a judgement never made, not a failure of the change. The loop answers it
 * through attestationDecision (GY-523) — never through rework or an operator escalation. GY-875:
 * a record the carry decision bound to the current candidate is a finding of the candidate too,
 * exactly as the merge queue's ejection check reads it; otherwise a carried record held a queue
 * entry for an attestation nothing could name.
 */
export interface UnexercisedFinding { proof: string; finding: string; criteria: string[]; behaviour: string | null }
/** What a `manual:` record with no case executed is: a judgement never made (GY-868). */
export const unexecutedManualFinding = (proof: string) => `the record carries executed = 0: no test case or check ran, so the criterion was never judged and there is no failure of the change to fix`;
export function unexercisedFindings(work: Work, sha: string | undefined = work.candidate?.sha, proofs?: readonly string[]): UnexercisedFinding[] {
  if (!sha) return [];
  const findings = new Map<string, UnexercisedFinding>();
  for (const entry of work.evidence ?? []) {
    // GY-875: a record carried onto the current candidate by a Graphyard-authored tip is bound to
    // it exactly as an exact-sha record is (evidenceBindsCandidate) — the queue's ejection check
    // reads carried evidence the same way, so a carried unexercised manual record holds the entry
    // only while attestationDecision can see it and request the wait the hold names. Carry binds
    // only the current candidate, so an explicitly named sha keeps the exact rule.
    if (entry.sha !== sha && !(sha === work.candidate?.sha && evidenceBindsCandidate(work, entry))) continue;
    if (entry.policyRevision !== work.policyRevision || (proofs && !proofs.includes(entry.proof))) continue;
    const criteria = entry.exercise?.criterion ? [entry.exercise.criterion] : work.criteria.filter(criterion => criterion.proofs.includes(entry.proof)).map(criterion => criterion.id);
    if (entry.unexercised) findings.set(entry.proof, { proof: entry.proof, finding: entry.unexercised, criteria, behaviour: entry.exercise?.behaviour ?? null });
    else if (entry.trusted && !entry.revocation && entry.proof.startsWith('manual:') && entry.executed === 0)
      findings.set(entry.proof, { proof: entry.proof, finding: `${entry.proof} ${unexecutedManualFinding(entry.proof)}`, criteria, behaviour: entry.exercise?.behaviour ?? null });
  }
  // A trusted pass recorded since answers the finding: the proof is proven on this head after all.
  return [...findings.values()].filter(({ proof }) => !(sha === work.candidate?.sha && currentEvidence(work, proof)?.result === 'pass'));
}
/** One finding as a rework names it: the proof, the criterion, and the mutation that survived. */
export const unexercisedDetail = (entry: UnexercisedFinding, sha: string) =>
  `${entry.proof} was recorded as not exercising ${entry.criteria.length ? entry.criteria.join(', ') : 'its criterion'} on ${short(sha)}: ${entry.behaviour ? `the mutation removing "${entry.behaviour}" survived` : 'no surviving-mutation run was recorded'} — ${entry.finding.length > 400 ? `${entry.finding.slice(0, 399)}…` : entry.finding}`;

/**
 * The rework detail for a head one of whose unit or integration groups has nothing left but proofs
 * the producer recorded as not exercising their criterion, or null (GY-817). Such a group's request
 * is never launched again for the head (auto-dispatch.ts); on 2026-09-26 GY-421 was named a proof
 * dispatch nobody would run for 51 minutes, until a master requested the rework by hand.
 */
export function unexercisedRework(work: Work, decisions: ProducerGroupDecision[]): string | null {
  if (!work.candidate) return null;
  const findings = unexercisedFindings(work).filter(entry => mechanicalProof(entry.proof));
  const groups = decisions.filter(decision => decision.state === 'request' && decision.group !== 'manual' && decision.unproven.length
    && decision.unproven.every(proof => findings.some(entry => entry.proof === proof)));
  if (!groups.length) return null;
  return findings.filter(entry => groups.some(decision => decision.unproven.includes(entry.proof))).map(entry => unexercisedDetail(entry, work.candidate!.sha)).join('; ');
}

/** The live producer request bound to the current head for one group, or null. */
export function openProducerRequest(work: Work, group: ProducerGroup): DispatchRequest | null {
  return (work.autoDispatch?.producers ?? []).find(request => request.group === group && request.state === 'requested' && !!work.candidate
    && request.sha === work.candidate.sha && request.baseSha === work.candidate.baseSha && request.policyRevision === work.policyRevision) ?? null;
}
