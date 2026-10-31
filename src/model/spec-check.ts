// Concern: GY-2992 — the spec check a released feature owes before a worker starts on it. Nobody
// without the filer's context reads an item before a worker spends an attempt on it, so gaps in the
// description and criteria surface as rework. Adopting the core of Google's Elephant-Goldfish Model
// (github.com/google/elephant-goldfish-model, Apache-2.0): when a feature item is released, before
// dispatch, the loop launches one spec-check session (reviewer identity, fresh context) that reads
// only the item and the files and docs it names, and answers in one report — a paraphrase of what
// will be built and how each criterion will be proven (the EGM comprehension test), and the
// implementation-readiness gaps that would leave a worker making design decisions. `ready`
// dispatches; `gaps` holds the item at ready with the report until master requirements revises it,
// which runs one re-check; a second gaps verdict dispatches with the report attached. Bugs and
// chores skip it, as EGM itself advises for small clear fixes; every feature owes one.
import type { Work } from './work.js';

export const specVerdicts = ['ready', 'gaps'] as const;
export type SpecVerdict = typeof specVerdicts[number];

/** One spec check, bound to the policy revision it judged: a revision by master requirements makes it stale and runs one more. */
export interface SpecCheck {
  policyRevision: number;
  verdict: SpecVerdict;
  /** The comprehension test: the reviewer's paraphrase of what will be built and how each criterion is proven. */
  paraphrase: string;
  /** The implementation-readiness gaps: ambiguous criteria, a proof that cannot fail or run, a missing dependency, an unnamed file the change needs. */
  gaps: string[];
  reviewer: string;
  at: string;
  /** True on the one re-check that ran after master requirements answered an earlier gaps verdict: its own gaps verdict dispatches, with the report attached for the worker. */
  recheck?: boolean;
}

/** The one launch standing for an item's spec check: the loop launches no second session while it stands unexpired (a relaunch replaces it and withdraws its token). Its report judges the policy revision the session was handed, whatever master requirements revises meanwhile. */
export interface SpecCheckLaunch {
  id: string; reviewer: string; requester: string; tokenHash: string; at: string; expiresAt: string; policyRevision: number;
}

declare module './work.js' {
  interface Work {
    /** GY-2992: the standing spec check of a feature item, replaced by each fresh report; absent on records written before it existed. */
    specCheck?: SpecCheck | null;
    /** The launch whose report the control plane waits for; cleared when the report is recorded. */
    specCheckLaunch?: SpecCheckLaunch | null;
  }
}

/** How long a spec-check launch stands: its token's life, after which the loop closes the session and launches again. */
export const specCheckLaunchMs = 3_600_000;

/** Who owes one: every feature item — a "No user-facing change" feature too; bugs and chores skip it, as EGM skips small clear fixes. */
export const needsSpecCheck = (work: Pick<Work, 'type'>): boolean => work.type === 'feature';

/** The check that judged the item's current requirements, or null: master requirements bumped the revision, so one more check runs before dispatch. */
export const specCheckCurrent = (work: Pick<Work, 'specCheck' | 'policyRevision'>): SpecCheck | null =>
  work.specCheck && work.specCheck.policyRevision === work.policyRevision ? work.specCheck : null;

/** Whether a launch still stands for this item's spec check at `now`: the loop launches no second session while it does. */
export const specCheckLaunchLive = (work: Pick<Work, 'specCheckLaunch'>, now: number): boolean =>
  !!work.specCheckLaunch && Date.parse(work.specCheckLaunch.expiresAt) > now;

/** Whether a report on `policyRevision` is the one re-check: a gaps verdict stands on an earlier revision, which master requirements revised since. A second report on the same revision is no re-check. */
export const isRecheck = (standing: SpecCheck | null | undefined, policyRevision: number): boolean =>
  !!standing && standing.verdict === 'gaps' && standing.policyRevision < policyRevision;

/**
 * Why the item is not dispatched to a worker yet, or null. A feature whose check has not reported
 * is held (one whose requirements master revised waits for the one re-check); a first gaps verdict
 * holds the item at ready with its report until master requirements answers it; a ready verdict and
 * a second gaps verdict dispatch — the second with the report attached for the worker.
 */
export function specCheckRefusal(work: Work): string | null {
  if (!needsSpecCheck(work)) return null;
  const check = specCheckCurrent(work);
  if (!check) return work.specCheck
    ? 'Spec check of the revised requirements has not reported; the item is held until it does'
    : 'Spec check before dispatch has not reported; the item is held until it does';
  if (check.verdict === 'ready') return null;
  return check.recheck ? null
    : `Spec check named gaps: ${check.gaps.join('; ')}; master requirements revises the item, then the check runs once more`;
}
