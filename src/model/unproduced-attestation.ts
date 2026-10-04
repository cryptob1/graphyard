import type { Work } from './work.js';
import type { ActionWait } from './action-account.js';
import { automatableProof, dispatchIneligibility } from './mechanical-proofs.js';
import { currentEvidence } from './evidence.js';

/**
 * The `manual:` proofs the loop puts to a two-party attestation itself (GY-521), or none. A proof
 * no producer session may run — not in `producerProofs`, and no producer request names it — is
 * satisfied only by an attestation decision an independent approver judges. GY-374 and GY-393 sat
 * in acceptance for two hours with an approved review and passing CI, logged every cycle as a
 * human step while nobody requested anything. So when acceptance is the first gate refusing a
 * live, observed candidate with no violation, and every one of its refusals is such a proof with
 * no evidence at all on this head, the loop requests one attest decision per proof, exactly as it
 * requests a merge decision. A proof whose attestation failed stays the operator's judgement.
 *
 * Only the item's own criteria offer a proof here (GY-1051): the control plane refuses an attest
 * whose proof no criterion of the item requires (`decisionPrecondition`, src/model/approval.ts), so
 * an inherited bootstrap obligation would fail its request on every retry while the delivery step,
 * taking it for the loop's, no longer escalated it. Such a proof stays the operator's.
 */
export function unproducedManualProofs(work: Work, _all: Work[], now: Date): string[] {
  if (!work.candidate || work.violations.length || dispatchIneligibility(work)) return [];
  const failing = work.gates.find(gate => !gate.passed);
  if (failing?.name !== 'acceptance' || !failing.reasons.length) return [];
  const requested = new Set((work.autoDispatch?.producers ?? []).filter(request => request.state === 'requested').flatMap(request => request.proofs ?? []));
  // Every proof the item's own criteria could require, its lane unapplied: the acceptance gate's own
  // refusals below decide which of them the lane requires, so a loop reading the item through a
  // view that carries no scope files (and would recompute another lane) asks for exactly those.
  const proofs = [...new Set(work.criteria.flatMap(criterion => criterion.bootstrap ? [] : criterion.proofs))].filter(proof => loopAttested(work, proof, now) && !requested.has(proof));
  const named = (reason: string) => proofs.find(proof => reason.includes(`: ${proof} needs trusted passing evidence`));
  if (!failing.reasons.every(reason => named(reason))) return [];
  return proofs.filter(proof => failing.reasons.some(reason => named(reason) === proof));
}
/**
 * Whether the loop, not a person, attests `proof` once it is the only refusal left: a `manual:` proof
 * one of the item's own criteria requires, no producer may run, with no evidence on this head. The
 * delivery step does not escalate one to an operator while the rest of the candidate settles; a
 * failed attestation is evidence, and stays theirs, as does an inherited bootstrap obligation the
 * control plane would refuse to take an attest decision for.
 */
export function loopAttested(work: Work, proof: string, now: Date): boolean {
  return proof.startsWith('manual:') && work.criteria.some(criterion => !criterion.bootstrap && criterion.proofs.includes(proof))
    && !automatableProof(work, proof) && !currentEvidence(work, proof, now);
}
/** Who owns the attestation of an unproduced `manual:` proof: the loop's decisions step, never a person. */
export const attestationOwner = 'graphyard';
/** The wait an item holding only such proofs is in: the loop's attestation request, never a person's step. */
export function attestationWait(work: Work, all: Work[], now: Date): ActionWait | null {
  const proofs = unproducedManualProofs(work, all, now);
  return proofs.length ? { kind: 'session', on: attestationOwner, detail: `${work.key} waits on the loop's two-party attestation request for ${proofs.join(', ')} on ${work.candidate!.sha.slice(0, 12)}: master run requests one attest decision per proof and launches an independent approver for it` } : null;
}
