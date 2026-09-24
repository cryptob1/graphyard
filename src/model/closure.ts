import { z } from 'zod';
import type { Stage, Work } from './work.js';
import { holdsMergeExecution } from './escalation.js';

// ---------------------------------------------------------------------------
// Closing a work item that will never be delivered: a duplicate, work another change already
// shipped, or work nobody wants any more. A closed item takes the terminal `done` stage — so
// every reader that treats `done` as "no longer open, immutable" keeps working unchanged — and
// carries a `closure` record that says it was closed, not delivered. Every reader that counts
// deliveries asks `isDelivered()` (or requires `work.delivery`, which a closed item never has).
// ---------------------------------------------------------------------------

export const closureKinds = ['duplicate', 'superseded', 'obsolete'] as const;
export type ClosureKind = typeof closureKinds[number];
export interface Closure {
  kind: ClosureKind; reason: string;
  /** The duplicate item's key, or the superseding commit or item key; null for `obsolete`. */
  ref: string | null;
  by: string; at: string;
  /** The stage the item held when it was closed. */
  from: Stage;
}

export const closeSchema = z.object({
  kind: z.enum(closureKinds),
  reason: z.string().trim().min(1).max(2000),
  ref: z.string().trim().min(1).max(200).nullable().optional(),
}).strict().superRefine((data, context) => {
  if (data.kind === 'obsolete' && data.ref) context.addIssue({ code: 'custom', message: 'An obsolete closure names no other item or commit', path: ['ref'] });
  if (data.kind !== 'obsolete' && !data.ref) context.addIssue({ code: 'custom', message: `A ${data.kind} closure names the ${data.kind === 'duplicate' ? 'item it duplicates' : 'commit or item that superseded it'}`, path: ['ref'] });
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
export function closeRefusal(work: Work, now: number): string | null {
  if (work.closure) return `${work.key} is already closed as ${work.closure.kind}`;
  if (work.stage === 'done') return `${work.key} is delivered; delivered work is immutable`;
  if (work.observation?.merged) return `${work.key}'s pull request is merged; reconciliation records its delivery`;
  if (work.lease && Date.parse(work.lease.expiresAt) > now) return `${work.key} has a live worker lease (${work.lease.owner}, epoch ${work.lease.epoch}); release it or let it lapse before closing`;
  if (holdsMergeExecution(work, now)) return `${work.key} has a merge execution in flight; retry after it completes or expires`;
  return null;
}

/** Why `ref` cannot stand for this closure against the graph, or null. Commit ancestry is judged by the caller. */
export function closureRefRefusal(work: Work, all: readonly Work[], kind: ClosureKind, ref: string | null): string | null {
  if (kind === 'obsolete') return null;
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

/** The closed items, newest first and bounded: the history `master status` shows apart from open work. */
export function closedHistory(work: readonly Work[], limit = 20) {
  return work.filter(isClosed).sort((a, b) => b.closure!.at.localeCompare(a.closure!.at)).slice(0, limit)
    .map(item => ({ key: item.key, title: item.title, kind: item.closure!.kind, ref: item.closure!.ref, reason: item.closure!.reason, by: item.closure!.by, at: item.closure!.at }));
}
