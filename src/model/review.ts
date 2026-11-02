import { z } from 'zod';
import type { Work } from './work.js';
import type { ApprovalIdentity } from './carry.js';

export const reviewProviders = ['github'] as const;
export type ReviewProvider = typeof reviewProviders[number];
const identifier = z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
// A runtime label is descriptive provenance (which agent produced the review), never authority.
const runtimeName = z.string().trim().regex(/^[a-z0-9][a-z0-9.+_-]{0,39}$/);
// Registered reviewer identities are numeric GitHub App/bot identities, not display names.
export const reviewerAppSchema = z.object({
  id: identifier, runtime: runtimeName,
  appId: z.number().int().positive(), botUserId: z.number().int().positive(),
  displayName: z.string().trim().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]+$/).optional(),
}).strict();
export type ReviewerApp = z.infer<typeof reviewerAppSchema>;
export const distinct = (values: unknown[]) => new Set(values.map(value => JSON.stringify(value))).size === values.length;
export const reviewerAppsSchema = z.array(reviewerAppSchema).max(50)
  .refine(apps => distinct(apps.map(app => app.id)), 'Reviewer App identifiers must be unique')
  .refine(apps => distinct(apps.map(app => app.appId)), 'Reviewer GitHub App IDs must be unique')
  .refine(apps => distinct(apps.map(app => app.botUserId)), 'Reviewer bot user IDs must be unique');
export function parseReviewerApps(raw: string | undefined): ReviewerApp[] {
  return reviewerAppsSchema.parse(JSON.parse(raw?.trim() || '[]'));
}

// `github` is the default provider: the reviewer session the loop launches, whose verdict the control plane records on the observation
// (server/review-verdict.ts). The identifier predates the control-plane merger and is kept so stored policies still read.
export const reviewProviderOf = (policy: Work['policy']): ReviewProvider => policy.reviewProvider ?? 'github';
export const nativeReviewRequired = (policy: Work['policy']) => reviewProviderOf(policy) === 'github';
/** The independent approval of the exact current candidate, after any requirement-review baseline. */
export function exactApproval(work: Work): ApprovalIdentity | null {
  const candidate = work.candidate, obs = work.observation;
  if (!candidate || !obs || obs.candidate.sha !== candidate.sha || obs.candidate.baseSha !== candidate.baseSha) return null;
  const provider = reviewProviderOf(work.policy);
  const baseline = work.formalReviewBaseline;
  const review = (obs.reviews ?? []).find(r => r.sha === candidate.sha && r.state === 'APPROVED' && r.reviewer !== candidate.author
    && (!work.formalReviewResetRequired
      || (r.source === 'control-plane' && (!baseline || !baseline.reviewIds.includes(r.id!)))
      || (baseline?.pr === candidate.pr && baseline.policyRevision === work.policyRevision && Number.isSafeInteger(r.id) && r.id! > 0 && !baseline.reviewIds.includes(r.id!))));
  return review ? { provider, reviewer: review.reviewer, sha: candidate.sha, ...(review.id !== undefined ? { reviewId: review.id } : {}) } : null;
}
