import { z } from 'zod';
import { demand } from './refusal.js';
import type { Work } from './work.js';
import type { ApprovalIdentity } from './carry.js';

export const reviewProviders = ['github', 'codex', 'agent'] as const;
export type ReviewProvider = typeof reviewProviders[number];
const identifier = z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
// A runtime label is descriptive provenance (which agent produced the review), never authority.
const runtimeName = z.string().trim().regex(/^[a-z0-9][a-z0-9.+_-]{0,39}$/);
export const reviewerProfileSchema = z.object({
  name: identifier, runtime: runtimeName, reviewerApp: identifier,
  mention: z.string().regex(/^@[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/).optional(),
  timeoutSeconds: z.number().int().min(60).max(86_400).default(1800),
}).strict();
export type ReviewerProfile = z.infer<typeof reviewerProfileSchema>;
export const distinct = (values: unknown[]) => new Set(values.map(value => JSON.stringify(value))).size === values.length;

export interface ReviewRequest {
  commentId: number; sha: string; baseSha: string; policyRevision: number; body: string; createdAt: string;
  // Absent provider metadata identifies a legacy Codex request; agent requests name the
  // dispatched profile, its registered App identity, and the correlation marker.
  provider?: ReviewProvider; profile?: string; reviewerApp?: string; marker?: string;
}
export interface AgentReview {
  provider: 'codex' | 'agent'; sha: string; approved: boolean; reason: string;
  summaryId?: number; resultId?: number; requestId?: number; reactionId?: number; completedAt?: string;
  profile?: string; reviewerApp?: string; verdictId?: number;
  exhausted?: boolean; exhaustion?: 'usage-limit' | 'timeout';
  // `approved: false` is every state short of approval — not dispatched, waiting, retry, unready,
  // exhausted — and none of those is a verdict. This is set only where the reviewer itself asked
  // for changes on exactly `sha`, for the recorded request; nothing may infer it from `reason`.
  verdict?: 'changes-requested';
}
export interface ReviewFailover {
  profile: string; reviewerApp: string; runtime: string; exhaustion: 'usage-limit' | 'timeout'; reason: string;
  at: string; sha: string; baseSha: string; policyRevision: number; requestCommentId: number; nextProfile: string | null;
}

// `github` is the default provider: the reviewer session the loop launches, whose verdict the control plane records on the observation
// (server/review-verdict.ts). The identifier predates the control-plane merger and is kept so stored policies still read.
export const reviewProviderOf = (policy: Work['policy']): ReviewProvider => policy.reviewProvider ?? 'github';
export const nativeReviewRequired = (policy: Work['policy']) => reviewProviderOf(policy) === 'github';
// Failover is derived, never stored: the recorded exhaustion history for the exact
// candidate and policy selects the next untried reviewer profile in configured order.
export function exhaustedReviewerProfiles(work: Work): string[] {
  return (work.reviewFailovers ?? []).filter(failover => failover.sha === work.candidate?.sha
    && failover.baseSha === work.candidate?.baseSha && failover.policyRevision === work.policyRevision).map(failover => failover.profile);
}
export function reviewerProfileFor(work: Work): ReviewerProfile | null {
  if (reviewProviderOf(work.policy) !== 'agent') return null;
  const exhausted = new Set(exhaustedReviewerProfiles(work));
  return (work.policy.reviewerProfiles ?? []).find(profile => !exhausted.has(profile.name)) ?? null;
}

/**
 * The approval the review gate accepts for the exact current candidate, with the identity behind
 * it, or null. One rule for every provider: a reviewer session's approval of the head by someone other
 * than the author (after the requirement-review baseline when one is set), or the dispatched
 * provider's verdict for the exact recorded request and, for agent review, the profile Graphyard
 * currently dispatches to under the same registered App.
 */
export function exactApproval(work: Work): ApprovalIdentity | null {
  const candidate = work.candidate, obs = work.observation;
  if (!candidate || !obs || obs.candidate.sha !== candidate.sha || obs.candidate.baseSha !== candidate.baseSha) return null;
  const provider = reviewProviderOf(work.policy);
  if (provider === 'github') {
    const baseline = work.formalReviewBaseline;
    const review = (obs.reviews ?? []).find(r => r.sha === candidate.sha && r.state === 'APPROVED' && r.reviewer !== candidate.author
      && (!work.formalReviewResetRequired
        || (r.source === 'control-plane' && (!baseline || !baseline.reviewIds.includes(r.id!)))
        || (baseline?.pr === candidate.pr && baseline.policyRevision === work.policyRevision && Number.isSafeInteger(r.id) && r.id! > 0 && !baseline.reviewIds.includes(r.id!))));
    return review ? { provider, reviewer: review.reviewer, sha: candidate.sha, ...(review.id !== undefined ? { reviewId: review.id } : {}) } : null;
  }
  const verdict = obs.agentReview, request = work.reviewRequest;
  const dispatched = !!verdict?.approved && verdict.provider === provider && verdict.sha === candidate.sha && !!request && request.commentId === verdict.requestId
    && request.sha === candidate.sha && request.baseSha === candidate.baseSha && request.policyRevision === work.policyRevision;
  if (!dispatched) return null;
  if (provider === 'codex') return { provider, reviewer: 'codex', sha: candidate.sha, reviewId: verdict!.requestId };
  const selected = reviewerProfileFor(work);
  const identity = !!verdict!.profile && !!verdict!.reviewerApp && request!.provider === 'agent' && request!.profile === verdict!.profile
    && request!.reviewerApp === verdict!.reviewerApp && selected?.name === verdict!.profile && selected?.reviewerApp === verdict!.reviewerApp;
  return identity ? { provider, reviewer: verdict!.profile!, reviewerApp: verdict!.reviewerApp!, sha: candidate.sha, reviewId: verdict!.requestId } : null;
}
