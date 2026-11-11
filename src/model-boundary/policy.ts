import { z } from 'zod';
import { proofSchema } from './proof.js';
import { deploySmokeProof } from '../model/proof.js';
import { postMergeProofRefusal, postDeployCriterionRefusal, postDeployOnlyRefusal } from '../model/post-merge-proofs.js';
import { reviewProviders } from '../model/review.js';
// Bootstrap mode: an operator may defer a criterion's proofs for the single change that
// introduces the harness those proofs depend on. The proof is never dropped. It becomes a
// standing obligation on the named contract paths, and the next change touching those paths
// inherits it as a required proof. Workers can never declare it.
export const bootstrapDeclarationSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
  contractPaths: z.array(z.string().trim().min(1).max(500)).min(1).max(20)
    .refine(paths => new Set(paths).size === paths.length, 'Bootstrap contract paths must be unique'),
}).strict();
export const criterionSchema = z.object({ id: z.string().regex(/^AC-\d+$/), text: z.string().min(1).max(2000), proofs: z.array(proofSchema).min(1).max(20), bootstrap: bootstrapDeclarationSchema.optional() }).strict()
  .refine(criterion => !criterion.proofs.includes(deploySmokeProof), `${deploySmokeProof} runs after delivery; require it with policy.deploySmoke instead of an acceptance criterion`)
  // Any other proof that can only pass after merge is refused the same way (GY-188).
  .superRefine((criterion, context) => { const refusal = postMergeProofRefusal(criterion); if (refusal) context.addIssue({ code: 'custom', message: refusal, path: ['proofs'] }); })
  // A live-install observation is accepted only when declared post-deploy (GY-1660), on every path a criterion is written by.
  .superRefine((criterion, context) => { const refusal = postDeployCriterionRefusal([criterion]); if (refusal) context.addIssue({ code: 'custom', message: refusal, path: ['proofs'] }); });
/** An item's criteria, on every path they are written by: at least one must be a criterion a head can show before merge (GY-1685). */
export const criteriaSchema = (max: number) => z.array(criterionSchema).min(1).max(max)
  .superRefine((criteria, context) => { const refusal = postDeployOnlyRefusal(criteria); if (refusal) context.addIssue({ code: 'custom', message: refusal }); });
export const policySchema = z.object({
  checks: z.array(z.string().min(1).max(200)).min(1).max(30).default(['test', 'typecheck']),
  /** Retired (GY-2876): every item follows the one review rule; kept so stored policies parse. */
  review: z.boolean().default(true),
  reviewProvider: z.enum(reviewProviders).optional(),
  // Optional second confidence layer after trunk: a trusted producer smoke-tests the live
  // deployment once it serves this item's merge commit. It never gates the merge itself.
  deploySmoke: z.boolean().optional(),
}).strict();
export const resourcesSchema = z.array(z.string().regex(/^[a-z0-9][a-z0-9._:/-]*$/).max(200)).max(30).refine(v => new Set(v).size === v.length, 'Resource names must be unique');

/** Only filing and storage admit a draft; requirements keep criteriaSchema. */
export const draftCriteriaSchema = (max: number) => z.union([z.array(criterionSchema).max(0), criteriaSchema(max)]);
