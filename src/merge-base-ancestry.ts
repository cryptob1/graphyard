import type { Work } from './model.js';

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

/** The missing ancestry the current observation of this exact candidate reports, or null. */
export function missingBaseAncestry(work: Pick<Work, 'candidate' | 'observation'>): MissingAncestry | null {
  const candidate = work.candidate, observation = work.observation;
  if (!candidate || !observation || observation.merged || observation.prState === 'closed' || observation.candidate?.sha !== candidate.sha) return null;
  if (observation.baseTipAncestor !== false || !observation.baseTip) return null;
  return { head: candidate.sha, baseTip: observation.baseTip, boundBase: candidate.baseSha };
}
