import type { Observation, Work } from './model.js';

/**
 * A candidate whose head does not contain the base branch tip by ancestry (GY-145).
 *
 * GitHub compares commits, not trees: when the head does not have the base branch tip in its
 * history, GitHub recomputes the merge base on every merge attempt and may dismiss the approval
 * with "The merge-base changed after approval.". Master status names the missing ancestry beside
 * such a dismissal, so nobody reads it as a reviewer withdrawing a verdict.
 */
export interface MissingAncestry { head: string; baseTip: string; boundBase: string }

declare module './model/work.js' {
  interface Observation {
    /** The head contains the base branch tip by ancestry alone, as GitHub compared them; unset on observations recorded before GY-145. */
    baseTipAncestor?: boolean;
  }
}

const short = (sha: string) => sha.slice(0, 12);

/** The missing ancestry the current observation of this exact candidate reports, or null. */
export function missingBaseAncestry(work: Pick<Work, 'candidate' | 'observation'>): MissingAncestry | null {
  const candidate = work.candidate, observation = work.observation;
  if (!candidate || !observation || observation.merged || observation.prState === 'closed' || observation.candidate?.sha !== candidate.sha) return null;
  if (observation.baseTipAncestor !== false || !observation.baseTip) return null;
  return { head: candidate.sha, baseTip: observation.baseTip, boundBase: candidate.baseSha };
}

/** Why the head cannot merge as it stands, naming the three commits. */
export function missingAncestryReason(missing: MissingAncestry): string {
  return `head ${short(missing.head)} does not contain base branch tip ${short(missing.baseTip)} by ancestry (bound base ${short(missing.boundBase)} is not that commit, whatever its tree); GitHub compares commits, not trees, and dismisses the approval as a merge-base change on the merge attempt`;
}

/** An approval of the current head that GitHub dismissed with its merge-base reason, as the observation recorded it. */
export interface MergeBaseDismissal { reviewer: string; reviewId: number | null; sha: string; at: string | null; commit: string | null; baseTip: string | null; boundBase: string; ancestry: MissingAncestry | null }

export function mergeBaseDismissal(work: Pick<Work, 'candidate' | 'observation'>): MergeBaseDismissal | null {
  const candidate = work.candidate, observation = work.observation;
  if (!candidate || !observation || observation.merged || observation.candidate?.sha !== candidate.sha) return null;
  for (const review of (observation.reviews ?? []) as (Observation['reviews'][number] & { dismissal?: { mergeBase?: boolean; verdict?: string | null; at?: string | null; commit?: string | null } })[]) {
    const dismissal = review.dismissal;
    if (review.state !== 'DISMISSED' || review.sha !== candidate.sha || !dismissal?.mergeBase || (dismissal.verdict && dismissal.verdict !== 'approved')) continue;
    return { reviewer: review.reviewer, reviewId: review.id ?? null, sha: candidate.sha, at: dismissal.at ?? review.submittedAt ?? null, commit: dismissal.commit ?? null,
      baseTip: observation.baseTip ?? null, boundBase: candidate.baseSha, ancestry: missingBaseAncestry(work) };
  }
  return null;
}

/** The `master status` attention line for such a dismissal: when, which commits, and what happens next. */
export function mergeBaseDismissalAttention(key: string, dismissal: MergeBaseDismissal): string {
  const tip = dismissal.baseTip ? short(dismissal.baseTip) : 'unknown';
  return `${key}: GitHub dismissed ${dismissal.reviewer}'s approval of ${short(dismissal.sha)}${dismissal.reviewId !== null ? ` (review #${dismissal.reviewId})` : ''} at ${dismissal.at ?? 'an unrecorded time'} for a merge-base change${dismissal.commit ? ` attributed to commit ${short(dismissal.commit)}` : ''}; bound base ${short(dismissal.boundBase)}, base branch tip ${tip}. `
    + (dismissal.ancestry
      ? `The ${missingAncestryReason(dismissal.ancestry)}; a fresh review of the head is requested`
      : `The head contains ${tip}, so the approval is restored as the binding one`);
}
