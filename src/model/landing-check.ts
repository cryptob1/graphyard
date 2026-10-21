import type { ScopeFile } from './work.js';

/**
 * What landing a candidate would do to the base branch, judged where it lands (GY-97).
 *
 * The regression guard compares a candidate with the base it is bound to, and a binding is held
 * on purpose while a head is unchanged: the base moving under it is neither a new head nor a new
 * submission. So a head that was clean when it was submitted could later delete what somebody else
 * shipped in the meantime. Every observation of an open candidate therefore records this check as
 * well, against the commit the merge would actually land on, the live base-branch tip:
 *
 * - `files`: the head's changes since its merge base with the landing commit, each outside the
 *   planned scope judged by the three-way merge result of the head onto that commit (GY-863).
 *   Present when the landing tree differs from the bound base.
 * - `carried`: other items' unlanded candidates whose commits this head has in its history, while
 *   its tree holds their files as the landing commit does (how GY-93's merge took GY-84's delivery).
 */
export interface CarriedCandidate {
  key: string; pr: number; head: string;
  /** The owning item's files this head does not hold, each with how it holds them instead. */
  dropped: { path: string; detail: string }[];
  /** The lookup budget ran out before every file was compared; never a pass, never an ejection. */
  unverified?: boolean;
}
/** Another item whose unlanded commits this head's history carries; see `LandingCheck.foreign`. */
export interface ForeignCandidate { key: string; pr: number; head: string }
export interface LandingCheck {
  base: string;
  files?: ScopeFile[];
  carried?: CarriedCandidate[];
  /** Every open candidate whose head is in this head's history (GY-127): a branch holding a neighbour's unlanded commits can neither be kept nor landed. */
  foreign?: ForeignCandidate[];
  /** The open candidates `carried` and `foreign` were decided against, as `KEY@heads`, so an unchanged answer is not asked for again. */
  examined?: string[];
}
/**
 * A merged change whose content the base branch does not hold: each file stands on the base tip
 * as it stood before the merge (or is absent), and `removedBy` is the merge that did it.
 */
export interface RevertedDelivery {
  base: string;
  files: { path: string; detail: string }[];
  removedBy: { key: string | null; pr: number; mergeSha: string | null; commit: string | null } | null;
  /** The lookup budget ran out: more files may be missing than are listed. */
  partial?: boolean;
}
