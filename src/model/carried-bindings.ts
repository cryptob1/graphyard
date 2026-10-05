import type { Work } from './work.js';
import { carriedApproval, currentCarry, describeGround } from './carry.js';
import { currentEvidence } from './evidence.js';
import { exactApproval } from './review.js';
import { requiredProofs } from './bootstrap.js';

/**
 * The review and the proofs the current candidate holds by carry rather than by a fresh verdict on
 * this exact commit (GY-330), each with the ground the carry rested on. Status and the dashboard
 * show these as carried — the same verdict as before a Graphyard-authored base refresh, not a new
 * one — never as steps that passed afresh ahead of the one the item is at.
 */
export interface CarriedBinding { ground: string | null; reason: string; from: string }
export function carriedBindings(work: Work, all: Work[], now: Date): { review: CarriedBinding | null; proofs: (CarriedBinding & { proof: string; evidenceId?: string })[] } {
  const carry = currentCarry(work), candidate = work.candidate;
  if (!carry || !candidate) return { review: null, proofs: [] };
  const ground = describeGround(carry.ground), from = carry.from.sha;
  const approval = !exactApproval(work) ? carriedApproval(work) : null;
  const proofs = requiredProofs(work, all).flatMap(proof => {
    const current = currentEvidence(work, proof, now), decision = carry.evidence.find(entry => entry.proof === proof);
    if (!current || !decision?.carried || decision.evidenceId !== current.id || (current.sha === candidate.sha && current.baseSha === candidate.baseSha)) return [];
    return [{ proof, ground, reason: decision.reason, from, evidenceId: current.id }];
  });
  return { review: approval ? { ground, reason: approval.reason, from } : null, proofs };
}
