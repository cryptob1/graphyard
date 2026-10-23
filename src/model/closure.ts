import { z } from 'zod';
import type { Stage, Work } from './work.js';

// ---------------------------------------------------------------------------
// Closing a work item that will never be delivered: a duplicate, work another change already
// shipped, or work nobody wants any more. A closed item takes the terminal `done` stage — so
// every reader that treats `done` as "no longer open, immutable" keeps working unchanged — and
// carries a `closure` record that says it was closed, not delivered. Every reader that counts
// deliveries asks `isDelivered()` (or requires `work.delivery`, which a closed item never has).
// ---------------------------------------------------------------------------

// GY-1779: `delivered-observation` closes a loop-owned observation item on the loop's own passing
// reading of the serving release (model/loop-observation.ts); `ref` names that release.
export const closureKinds = ['duplicate', 'superseded', 'obsolete', 'delivered-observation'] as const;
export type ClosureKind = typeof closureKinds[number];
export interface Closure {
  kind: ClosureKind; reason: string;
  /** The duplicate item's key, the superseding commit or item key, or the release a delivered observation was read on; null for `obsolete`. */
  ref: string | null;
  by: string; at: string;
  /** The stage the item held when it was closed. */
  from: Stage;
  /**
   * GY-1779: the open pull request a `delivered-observation` closure supersedes (a worker's unsubmitted
   * candidate from before the loop held the item, GY-1725 #1172). Recorded `owed` in the closure's own
   * transaction, before GitHub is touched; the close on GitHub follows the commit, and its outcome is
   * recorded when it lands. One still `owed` is closed on the next close call for the item.
   */
  pullRequest?: { pr: number; outcome: 'owed' | 'closed' | 'already-closed' } | null;
}

/** A close that names no kind (GY-1923: a case settling its change with only a reason) is `obsolete`, the one kind that names no other item or commit. */
export const closeSchema = z.object({
  kind: z.enum(closureKinds).default('obsolete'),
  reason: z.string().trim().min(1).max(2000),
  ref: z.string().trim().min(1).max(200).nullable().optional(),
}).strict().superRefine((data, context) => {
  if (data.kind === 'obsolete' && data.ref) context.addIssue({ code: 'custom', message: 'An obsolete closure names no other item or commit', path: ['ref'] });
  if (data.kind !== 'obsolete' && !data.ref) context.addIssue({ code: 'custom', message: `A ${data.kind} closure names the ${data.kind === 'duplicate' ? 'item it duplicates' : data.kind === 'delivered-observation' ? 'release its reading was taken on' : 'commit or item that superseded it'}`, path: ['ref'] });
});
export type CloseInput = z.infer<typeof closeSchema>;

type Terminal = Pick<Work, 'stage'> & { closure?: Closure | null };
/** Closed: terminal without having been delivered. */
export const isClosed = (work: Terminal) => work.stage === 'done' && !!work.closure;
/** Delivered: terminal because it merged. A closed item is never delivered. */
export const isDelivered = (work: Terminal) => work.stage === 'done' && !work.closure;

export const commitRef = /^[0-9a-f]{7,40}$/i;
export const itemRef = /^GY-\d+$/;

/** Why this item may not be closed now, or null. Pure over the item and the clock. */
export function closeRefusal(work: Work): string | null {
  if (work.closure) return `${work.key} is already closed as ${work.closure.kind}`;
  if (work.stage === 'done') return `${work.key} is delivered; delivered work is immutable`;
  if (work.observation?.merged) return `${work.key}'s pull request is merged; reconciliation records its delivery`;
  return null;
}

/**
 * Why `ref` cannot stand for this closure against the graph, or null. Commit ancestry is judged by
 * the caller, and so is a `delivered-observation` closure's reading (`deliveredObservationRefusal`
 * in loop-observation.ts, which this module cannot import without a cycle): the kind is no
 * client-controlled lifecycle transition, so the close route refuses it on any item that is not a
 * loop-owned observation item with a recorded passing reading taken on `ref`.
 */
export function closureRefRefusal(work: Work, all: readonly Work[], kind: ClosureKind, ref: string | null): string | null {
  if (kind === 'obsolete') return null;
  if (kind === 'delivered-observation') return commitRef.test(ref ?? '') ? null : `A delivered-observation closure names the release commit its reading was taken on, not ${ref}`;
  if (itemRef.test(ref ?? '')) {
    const other = all.find(item => item.key === ref);
    if (!other) return `${ref} is not an existing work item`;
    if (other.id === work.id) return `${work.key} cannot be closed as a ${kind} of itself`;
    if (kind === 'superseded' && !isDelivered(other)) return `${ref} is not delivered, so it has not superseded ${work.key}`;
    return null;
  }
  if (kind === 'duplicate') return `--duplicate-of names a work item (GY-N), not ${ref}`;
  return commitRef.test(ref ?? '') ? null : `--superseded-by names a commit SHA or a work item (GY-N), not ${ref}`;
}
