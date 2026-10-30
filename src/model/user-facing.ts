// Concern: GY-2965 — every user-facing item owes an end-to-end proof, bound to a case the merge trial runs.
import { repositoryPolicy } from './repository-policy.js';
import { projectDelivery } from '../project-applications.js';

/** The opt-out sentence: a description opening with it, followed by a reason, owes no e2e proof. */
export const noUserFacingChange = 'No user-facing change:';
/** The case file an `e2e:NAME` proof binds to, on the head. */
export const e2eCasePath = (name: string) => `e2e/cases/${name}.json`;

/** Whether the description opts the item out of the e2e requirement: it opens with `No user-facing change:` and gives a reason. */
export const optsOutOfE2e = (description: string | null | undefined) => {
  const text = (description ?? '').trim();
  return text.startsWith(noUserFacingChange) && text.slice(noUserFacingChange.length).trim().length > 0;
};

/**
 * Why create or requirements refuses a user-facing item's criteria, or null: an item of type
 * feature or bug must carry at least one criterion with an `e2e:` proof — the case the merge
 * writer's trial runs against the served head — unless the description opens with the opt-out
 * sentence and a reason (refactors, docs, headless-only and control-plane-internal work). Items of
 * other types are unaffected.
 */
export function userFacingProofRefusal(input: { type: string; description?: string | null; criteria: readonly { proofs: readonly string[] }[] }): string | null {
  if (input.type !== 'feature' && input.type !== 'bug') return null;
  if (input.criteria.some(criterion => criterion.proofs.some(proof => proof.startsWith('e2e:')))) return null;
  if (optsOutOfE2e(input.description)) return null;
  return `a ${input.type} item a user can see owes an end-to-end proof: give a criterion an e2e:NAME proof bound to its case e2e/cases/NAME.json (docs/validation.md), or open the description with "${noUserFacingChange} <reason>" to opt out`;
}

/**
 * Why the filing rules in force refuse an item's criteria, or null: the validation `create` runs
 * (GY-2965) — the per-item e2e proof, then the serve declaration an `e2e:` proof needs. The ready
 * gate re-runs it against an item the upgrade predates (GY-2981), so it reads the install's
 * current policy and delivery: today's rules, judged against the item's criteria as they stand.
 */
export function filingRefusal(input: { type: string; description?: string | null; criteria: readonly { proofs: readonly string[] }[] }): string | null {
  const policy = repositoryPolicy();
  const delivery = projectDelivery();
  return userFacingProofRefusal(input) ?? e2eServeRefusal({
    criteria: input.criteria,
    serve: !!policy.e2e.serve,
    previewable: !!delivery.delivery && delivery.delivery.previews !== 'off' && delivery.delivery.applications.length > 0,
  });
}

/** The three sentences the filing validation words, so a reader can tell one from any other refusal. */
const filingRefusals = [
  userFacingProofRefusal({ type: 'feature', description: null, criteria: [] }),
  userFacingProofRefusal({ type: 'bug', description: null, criteria: [] }),
  e2eServeRefusal({ criteria: [{ proofs: ['e2e:name'] }], serve: false, previewable: false }),
].filter((refusal): refusal is string => refusal !== null);
/** Whether a refusal is the filing validation's, so the attention that carries it names its one answer. */
export const isFilingRefusal = (refusal: string): boolean => filingRefusals.includes(refusal);

/**
 * Why create refuses an item whose criteria carry `e2e:` proofs in a repository with no way to
 * serve a head for them, or null: the repository's policy must declare `e2e.serve { command, url,
 * readySeconds }`, or a previewable application (`delivery.applications`), which the trial serves
 * the way a preview does.
 */
export function e2eServeRefusal(input: { criteria: readonly { proofs: readonly string[] }[]; serve: boolean; previewable: boolean }): string | null {
  const proofs = [...new Set(input.criteria.flatMap(criterion => criterion.proofs.filter(proof => proof.startsWith('e2e:'))))];
  if (!proofs.length || input.serve || input.previewable) return null;
  return `${proofs[0]} has no way to serve a head: declare "e2e": { "serve": { "command", "url", "readySeconds" } } in graphyard.json, or declare a previewable application in delivery.applications`;
}
