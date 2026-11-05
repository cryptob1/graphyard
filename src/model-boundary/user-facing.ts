import { repositoryPolicy } from './repository-policy.js';
import { projectDelivery } from './project-applications.js';
import { e2eProofRefusal, e2eServeRefusal } from '../model/user-facing.js';
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
