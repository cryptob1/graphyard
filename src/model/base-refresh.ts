import type { Work } from './work.js';
import type { QueueCarry, TipMerge } from './carry.js';
import type { BaseBreak } from '../master/base-break-refresh.js';
import type { DocsSync } from './docs-sync.js';

/** The carry decisions on record that moved bindings onto `sha`, under the current policy: a base refresh's. */
export function onto(work: Pick<Work, 'baseRefresh' | 'policyRevision'>, sha: string): QueueCarry[] {
  const carry = work.baseRefresh?.carry;
  return carry && carry.to.sha === sha && carry.policyRevision === work.policyRevision ? [carry] : [];
}

/**
 * The record of the control plane bringing an in-flight candidate onto a base branch that moved
 * under it: the head it republished on the new base, or the conflict that stopped it. While a
 * candidate's head is unchanged it keeps the base it was bound to; the control plane merges the
 * new base into the candidate's branch and decides binding carry from the commit it produced
 * (model/carry.ts). A conflict is the one case that still belongs to the worker.
 */
export interface BaseRefresh {
  /** The head the refresh acted on and the base it was bound to when it did. */
  from: { sha: string; baseSha: string };
  /** The base-branch tip the candidate was brought onto, and that commit's tree. */
  base: string; baseTree: string;
  policyRevision: number; at: string;
  /** The republished head, or null when the merge conflicted and nothing was pushed. */
  head: string | null;
  /** Why the base could not be merged into the candidate, named for the worker; null on success. */
  conflict: string | null;
  /**
   * With a confirmed conflict (GY-566): the paths both the head and the base changed since their
   * merge base, which hold every conflicted path; null when neither side could be listed.
   * The loop routes a conflict confined to docs pages to a docs-sync session (model/docs-sync.ts).
   */
  conflictPaths?: string[] | null;
  /** Set when the head is a docs-sync of `from` onto `base` (GY-566): what the carry was decided from. */
  docsSync?: DocsSync | null;
  /** How Graphyard produced the head, as the merge commit reports it; null when nothing was merged. */
  merge?: TipMerge | null;
  /** Which bindings of the replaced head carried onto it, decided once when the refresh was bound. */
  carry?: QueueCarry | null;
  /** What made the control plane touch the branch (GY-375): a confirmed conflict, a coordinator's request, a docs sync or a base repair. */
  trigger?: RefreshTrigger;
  /** The coordinator's request this refresh answered (GY-528), when it was one; see `BaseRefreshRequest`. */
  requested?: { by: string; at: string; reason: string } | null;
  /** The base-branch breakage a `base breakage` refresh answered (GY-793): the failing tests, the base that broke them and the tip that fixed them. */
  baseBreak?: BaseBreak | null;
  /**
   * With a conflict (GY-1200): when a conflict was first recorded for this same head and policy
   * revision. A refresh onto each new base tip rewrites `at`, so on a base that moves often `at`
   * alone would keep restarting the bound an unhandled conflict is counted against (faults.ts
   * baseConflictInMotion). Absent on records that predate the rule, which read as `at`.
   */
  conflictSince?: string | null;
}
/**
 * GY-1200. When the conflict a refresh records was first found on this head: the earlier record's
 * own first conflict when it conflicted on the same head and policy revision, else the refresh's own time.
 */
export function conflictSince(previous: Pick<BaseRefresh, 'from' | 'policyRevision' | 'at' | 'conflict' | 'conflictSince'> | null | undefined, refresh: Pick<BaseRefresh, 'from' | 'policyRevision' | 'at' | 'conflict'>): string | null {
  if (!refresh.conflict) return null;
  const same = !!previous?.conflict && previous.from.sha === refresh.from.sha && previous.policyRevision === refresh.policyRevision;
  return same ? previous!.conflictSince ?? previous!.at : refresh.at;
}
/**
 * The coordinator's request that a base tip be merged into this head although no conflict is
 * reported (GY-528): the head carries a base failure the base has since repaired. Kept beside
 * `baseRefresh`, not in it, so an approval an earlier refresh carried onto the head still binds until this one runs.
 */
export interface BaseRefreshRequest { head: string; base: string; policyRevision: number; by: string; at: string; reason: string }
/** Why a branch was written by the control plane rather than by its worker (GY-375, GY-528, GY-793). */
export type RefreshTrigger = 'conflict confirmed' | 'docs sync' | 'base failure repaired' | 'base breakage';

/**
 * The refresh this candidate is waiting for, or null when it needs none (GY-292): only a candidate
 * observed conflicting with a base tip it does not contain, and only once per head, base tip and
 * policy revision, so neither a conflict nor a published head makes the reconciliation job spin.
 */
export function baseRefreshNeeded(work: Work): { head: string; boundBase: string; baseTip: string } | null {
  const candidate = work.candidate, observation = work.observation;
  if (!work.submission || work.reworkRequested || work.stage === 'done' || work.blocker) return null;
  if (!candidate || !observation || observation.merged || observation.prState === 'closed' || observation.draft) return null;
  if (observation.candidate.sha !== candidate.sha) return null;
  const baseTip = observation.baseTip;
  if (observation.baseTipContained !== false || !baseTip || baseTip === candidate.baseSha) return null;
  if (observation.conflicting !== true) return null;
  const refresh = work.baseRefresh;
  if (refresh && refresh.from.sha === candidate.sha && refresh.base === baseTip && refresh.policyRevision === work.policyRevision) return null;
  return { head: candidate.sha, boundBase: candidate.baseSha, baseTip };
}

/** The unresolved conflict a base refresh reported for exactly this candidate and branch head, or null. */
export function baseRefreshConflict(work: Pick<Work, 'candidate' | 'observation' | 'baseRefresh' | 'policyRevision'>): string | null {
  const refresh = work.baseRefresh, candidate = work.candidate, observation = work.observation;
  if (!refresh?.conflict || !candidate || !observation) return null;
  return refresh.from.sha === candidate.sha && refresh.base === observation.baseTip && refresh.policyRevision === work.policyRevision ? refresh.conflict : null;
}

/**
 * The base tip the control plane is bringing this candidate onto, when that is the only thing it
 * waits for. `master status` reads it to keep such an item out of the attention list: nobody is
 * waiting on a person, a review round, or a proof round for it.
 */
export function pendingBaseRefresh(work: Work): { baseTip: string; boundBase: string } | null {
  if (baseRefreshConflict(work)) return null;
  const needed = baseRefreshNeeded(work);
  return needed ? { baseTip: needed.baseTip, boundBase: needed.boundBase } : null;
}

/** The carry decision a base refresh made for exactly the current candidate, for status and diagnose. */
export function currentBaseRefreshCarry(work: Pick<Work, 'candidate' | 'baseRefresh' | 'policyRevision'>): QueueCarry | null {
  const refresh = work.baseRefresh, candidate = work.candidate, carry = refresh?.carry;
  if (!refresh || !carry || !candidate || refresh.head !== candidate.sha) return null;
  return carry.to.sha === candidate.sha && carry.to.baseSha === candidate.baseSha && carry.policyRevision === work.policyRevision ? carry : null;
}
