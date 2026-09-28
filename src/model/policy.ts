import { z } from 'zod';
import { deploySmokeProof, proofSchema } from './proof.js';
import { postMergeProofRefusal } from './post-merge-proofs.js';
import { distinct, reviewProviders, reviewerProfileSchema } from './review.js';

// ---- Risk lanes (GY-883) -------------------------------------------------------------------------

/**
 * The ceremony an item runs is decided by the risk of what it changes, not by one high-ceremony
 * path for everything. `low` lands with its required CI checks green and one approving review —
 * catch-and-revert suits it; `medium` adds its producer-run proofs; `high` keeps the full path,
 * producer proofs, manual attestations and approver decisions alike.
 */
export const lanes = ['low', 'medium', 'high'] as const;
export type Lane = typeof lanes[number];

/**
 * The shipped high-risk path policy: any changed path under one of these makes the change high.
 * The installation and deployment surfaces are the repository's own: installation changes go
 * through `src/install/` and deployment through the `deploy/` tree, the Dockerfile and
 * compose.yaml, beside the schema, credential and public-API paths.
 */
export const highRiskPaths = [
  /^migrations\/schema/, /^auth\/credentials/, /^src\/server\/routes/,
  /^src\/install\//, /^deploy\//, /^Dockerfile(\.|$)/, /^compose\.ya?ml$/,
] as const;

/** The shipped low-risk path policy: a change only of tests or of docs is low. */
export const testOnlyPaths = /(^|\/)(tests?|__tests__)\/|\.test\.[A-Za-z]+$|\.spec\.[A-Za-z]+$/;
export const docsOnlyPaths = /^docs\/|(^|\/)README\.md$|^AGENTS\.md$|\.mdx?$/;

/**
 * The lane one change rides in, from the shipped path policy: any high-risk path makes the change
 * high; a change only of tests or only of docs is low; a change kept inside one module — every
 * path sharing the same leading segments, such as `src/model/` — is low; everything else is
 * medium. An unknown change (no paths at all) is medium: the default lane asks for proofs until
 * the policy can see the change is small. The shared prefix counts only up to the first segment
 * where the paths diverge: `src/model/index.ts` and `src/cli/index.ts` share `src/` and nothing
 * past it, so they are two modules, not one.
 */
export function determineLane(paths: readonly string[]): Lane {
  const changed = [...new Set(paths)];
  if (!changed.length) return 'medium';
  if (changed.some(path => highRiskPaths.some(pattern => pattern.test(path)))) return 'high';
  if (changed.every(path => testOnlyPaths.test(path) || docsOnlyPaths.test(path))) return 'low';
  const segments = changed.map(path => path.split('/').filter(Boolean));
  const first = segments[0];
  let shared = 0;
  while (shared < first.length && segments.every(parts => parts[shared] === first[shared])) shared++;
  return shared >= 2 ? 'low' : 'medium';
}

/**
 * The shipped per-lane speed targets: the submit→merge p50 each lane is expected to meet, in
 * milliseconds, reported beside its lane. They split the pipeline target (GY-54) by lane: the
 * smaller the change, the faster it is expected to land.
 */
export const laneSpeedTargets: Record<Lane, number> = { low: 30 * 60_000, medium: 60 * 60_000, high: 4 * 60 * 60_000 };

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
