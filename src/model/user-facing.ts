// Concern: GY-3037 — every item owes an end-to-end proof, bound to a case the merge trial runs.
import { repositoryPolicy } from './repository-policy.js';
import { projectDelivery } from '../project-applications.js';

/** The case file an `e2e:NAME` proof binds to, on the head. */
export const e2eCasePath = (name: string) => `e2e/cases/${name}.json`;

/**
 * Why create or requirements refuses an item's criteria, or null: every item, of every type, must
 * carry at least one criterion with an `e2e:` proof — a new case or an existing one, which the
 * merge writer's trial runs against the served head. There is no chore exemption and no opt-out
 * sentence: a description never changes the rule.
 */
export function e2eProofRefusal(input: { type: string; description?: string | null; criteria: readonly { proofs: readonly string[] }[] }): string | null {
  if (input.criteria.some(criterion => criterion.proofs.some(proof => proof.startsWith('e2e:')))) return null;
  return `a ${input.type} item owes an end-to-end proof: give a criterion an e2e:NAME proof bound to its case e2e/cases/NAME.json — a new case or an existing one`;
}

/**
 * Why the filing rules in force refuse an item's criteria, or null: the validation `create` runs
 * (GY-3037) — the per-item e2e proof, then the serve declaration an `e2e:` proof needs. The ready
 * gate re-runs it against an item the upgrade predates (GY-2981), so it reads the install's
 * current policy and delivery: today's rules, judged against the item's criteria as they stand.
 */
export function filingRefusal(input: { type: string; description?: string | null; criteria: readonly { proofs: readonly string[] }[] }): string | null {
  const policy = repositoryPolicy();
  const delivery = projectDelivery();
  return e2eProofRefusal(input) ?? e2eServeRefusal({
    criteria: input.criteria,
    serve: !!policy.e2e.serve,
    previewable: !!delivery.delivery && delivery.delivery.previews !== 'off' && delivery.delivery.applications.length > 0,
  });
}

/** The sentences the filing validation words, so a reader can tell one from any other refusal. */
const filingRefusals = (['feature', 'bug', 'chore'] as const)
  .map(type => e2eProofRefusal({ type, description: null, criteria: [] }))
  .concat([e2eServeRefusal({ criteria: [{ proofs: ['e2e:name'] }], serve: false, previewable: false })])
  .filter((refusal): refusal is string => refusal !== null);
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
