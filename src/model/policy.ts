import { z } from 'zod';
import { deploySmokeProof, proofSchema } from './proof.js';
import { postMergeProofRefusal } from './post-merge-proofs.js';
import { distinct, reviewProviders, reviewerProfileSchema } from './review.js';

export type Lane = 'low' | 'medium' | 'high';

export function determineLane(paths: string[]): Lane {
  if (!paths.length) return 'medium';

  const highRiskPatterns = [
    /^migrations\/schema/,
    /^auth\/credentials/,
    /^deploy\/install/,
    /^src\/server\/routes/,
  ];

  const lowRiskPatterns = [
    /^tests\//,
    /^docs\//,
  ];

  const highRiskPaths = paths.filter(p => highRiskPatterns.some(pattern => pattern.test(p)));

  // If any high-risk path is touched, it's high lane
  if (highRiskPaths.length > 0) return 'high';

  // If only docs or tests are changed, it's low lane
  if (paths.every(p => lowRiskPatterns.some(pattern => pattern.test(p)))) return 'low';

  // Single-module changes: all paths share common leading directory parts
  // e.g., all in src/model/ or all in src/cli/ are single-module
  if (paths.length > 0) {
    const parts = paths.map(p => p.split('/'));
    let commonDepth = 0;
    for (let i = 0; i < Math.min(...parts.map(p => p.length)); i++) {
      if (parts.every(p => p[i] === parts[0][i])) commonDepth = i + 1;
      else break;
    }
    // If all paths share at least 2 directory levels (e.g., src/model/) it's single-module low-risk
    if (commonDepth >= 2) return 'low';
  }

  // Everything else is medium
  return 'medium';
}

// Bootstrap mode: an operator may defer a criterion's proofs for the single change that
// introduces the harness those proofs depend on. The proof is never dropped. It becomes a
// standing obligation on the named contract paths, and the next change touching those paths
// inherits it as a required proof. Workers can never declare it.
export const bootstrapDeclarationSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
  contractPaths: z.array(z.string().trim().min(1).max(500)).min(1).max(20)
    .refine(paths => new Set(paths).size === paths.length, 'Bootstrap contract paths must be unique'),
}).strict();
export type BootstrapDeclaration = z.infer<typeof bootstrapDeclarationSchema>;
export const criterionSchema = z.object({ id: z.string().regex(/^AC-\d+$/), text: z.string().min(1).max(2000), proofs: z.array(proofSchema).min(1).max(20), bootstrap: bootstrapDeclarationSchema.optional() }).strict()
  .refine(criterion => !criterion.proofs.includes(deploySmokeProof), `${deploySmokeProof} runs after delivery; require it with policy.deploySmoke instead of an acceptance criterion`)
  // Any other proof that can only pass after merge is refused the same way (GY-188).
  .superRefine((criterion, context) => { const refusal = postMergeProofRefusal(criterion); if (refusal) context.addIssue({ code: 'custom', message: refusal, path: ['proofs'] }); });
/** Stored declaration. The audit fields are stamped by the control plane, never by the client. */
export interface BootstrapMode extends BootstrapDeclaration { declaredBy: string; declaredAt: string; policyRevision: number }
export interface Criterion { id: string; text: string; proofs: string[]; bootstrap?: BootstrapMode }
export const policySchema = z.object({
  checks: z.array(z.string().min(1).max(200)).min(1).max(30).default(['test', 'typecheck']),
  review: z.boolean().default(true),
  reviewProvider: z.enum(reviewProviders).optional(),
  reviewerProfiles: z.array(reviewerProfileSchema).min(1).max(10).optional(),
  // Optional second confidence layer after trunk: a trusted producer smoke-tests the live
  // deployment once it serves this item's merge commit. It never gates the merge itself.
  deploySmoke: z.boolean().optional(),
}).strict().superRefine((policy, context) => {
  if (policy.reviewProvider !== 'agent') {
    if (policy.reviewerProfiles) context.addIssue({ code: 'custom', message: 'Reviewer profiles require reviewProvider "agent"', path: ['reviewerProfiles'] });
    return;
  }
  if (!policy.review) context.addIssue({ code: 'custom', message: 'Agent review requires review: true', path: ['review'] });
  const profiles = policy.reviewerProfiles ?? [];
  if (!profiles.length) context.addIssue({ code: 'custom', message: 'Agent review requires at least one reviewer profile', path: ['reviewerProfiles'] });
  if (!distinct(profiles.map(profile => profile.name))) context.addIssue({ code: 'custom', message: 'Reviewer profile names must be unique', path: ['reviewerProfiles'] });
  // One identity per profile keeps a verdict attributable to exactly one profile.
  if (!distinct(profiles.map(profile => profile.reviewerApp))) context.addIssue({ code: 'custom', message: 'Each reviewer profile must name a distinct registered reviewer App', path: ['reviewerProfiles'] });
});
export const resourcesSchema = z.array(z.string().regex(/^[a-z0-9][a-z0-9._:/-]*$/).max(200)).max(30).refine(v => new Set(v).size === v.length, 'Resource names must be unique');
