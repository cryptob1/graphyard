import type { Work } from './work.js';
import type { ActionWait } from './action-account.js';
import { automatableProof, dispatchIneligibility } from './mechanical-proofs.js';
import { currentEvidence } from './evidence.js';
import { inheritedObligations } from './bootstrap.js';

/**
 * The `manual:` proofs only the master's attestation satisfies (GY-521), or none: proofs no producer
 * session may run — not in `producerProofs`, and no producer request names it — when acceptance is
 * the first gate refusing a live, observed candidate with no violation and every one of its refusals
 * is such a proof with no evidence at all on this head. A proof whose attestation failed stays the
 * master's judgement.
 */
export function unproducedManualProofs(work: Work, all: Work[], now: Date): string[] {
  if (!work.candidate || work.violations.length || dispatchIneligibility(work)) return [];
  const failing = work.gates.find(gate => !gate.passed);
  if (failing?.name !== 'acceptance' || !failing.reasons.length) return [];
  const requested = new Set((work.autoDispatch?.producers ?? []).filter(request => request.state === 'requested').flatMap(request => request.proofs ?? []));
  // Every proof the item could be required to hold, its lane unapplied: the acceptance gate's own
  // refusals below decide which of them the lane requires, so a loop reading the item through a
  // view that carries no scope files (and would recompute another lane) asks for exactly those.
  const candidates = [...work.criteria.flatMap(criterion => criterion.bootstrap ? [] : criterion.proofs), ...inheritedObligations(work, all).map(obligation => obligation.proof)];
  const proofs = [...new Set(candidates)].filter(proof => loopAttested(work, proof, now) && !requested.has(proof));
  const named = (reason: string) => proofs.find(proof => reason.includes(`: ${proof} needs trusted passing evidence`));
  if (!failing.reasons.every(reason => named(reason))) return [];
  return proofs.filter(proof => failing.reasons.some(reason => named(reason) === proof));
}
/**
 * Whether the master, not a person, attests `proof` once it is the only refusal left: a `manual:` proof
 * no producer may run with no evidence on this head. The delivery step does not escalate one to an
 * operator while the rest of the candidate settles; a failed attestation is evidence, and stays theirs.
 */
export function loopAttested(work: Work, proof: string, now: Date): boolean {
  return proof.startsWith('manual:') && !automatableProof(work, proof) && !currentEvidence(work, proof, now);
}
/** Who owns the attestation of an unproduced `manual:` proof: the master, never a person. */
export const attestationOwner = 'master';
/** The wait an item holding only such proofs is in: the master's attestation, never a person's step. */
export function attestationWait(work: Work, all: Work[], now: Date): ActionWait | null {
  const proofs = unproducedManualProofs(work, all, now);
  return proofs.length ? { kind: 'session', on: attestationOwner, detail: `${work.key} waits on the master's attestation of ${proofs.join(', ')} on ${work.candidate!.sha.slice(0, 12)}: graphyard master attest ${work.key} ${proofs[0]} REASON once it verifies the criterion on that head` } : null;
}
