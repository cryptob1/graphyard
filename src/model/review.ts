import type { Work } from './work.js';
import type { ApprovalIdentity } from './carry.js';

export const reviewProviders = ['github'] as const;
export type ReviewProvider = typeof reviewProviders[number];
export const distinct = (values: unknown[]) => new Set(values.map(value => JSON.stringify(value))).size === values.length;

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
