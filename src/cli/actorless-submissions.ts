import { agentOwner, type AttentionItem } from '../master.js';
import { reviewNeed, type ReviewState } from '../model/dispatch.js';
import { pendingBaseRefresh } from '../merge-queue.js';
import { standingEscalations } from '../model/escalation.js';
import type { Work } from '../model/work.js';

/**
 * A submitted item nobody is acting for (GY-191).
 *
 * On 2026-09-24 four submitted candidates sat in review for hours: each was behind the moved base,
 * so no review request was raised for its head, nothing refreshed it, and no rework was asked for.
 * Every reader showed an ordinary wait. The invariant this names is simple: a submitted item that
 * still needs its review holds a live review request, a live producer request, a rework request,
 * or a named wait — a blocker, an escalation, a queue entry, a base refresh in flight, a review a
 * provider answers on its own. Past `actorlessBoundMs` with none of them, the item is named with
 * the actor that is missing, so the gap is a line in `master status` instead of a silent stall.
 */
export const actorlessBoundMs = 5 * 60_000;

const missingActor: Record<ReviewState, { actor: string; next: (key: string) => string }> = {
  required: { actor: 'a reviewer: no review request is raised for its head', next: key => `graphyard master review ${key}` },
  'base-not-contained': { actor: 'a sync rework: its head does not merge cleanly with the base', next: key => `graphyard master decide ${key} rework REASON naming the conflicting base tip, then graphyard master approver ${key} DECISION` },
  'changes-requested': { actor: 'a rework request: a verdict stands against its head', next: key => `graphyard master decide ${key} rework REASON, then graphyard master approver ${key} DECISION` },
  'proof-failed': { actor: 'a rework request: a mechanical proof failed on its head', next: key => `graphyard master decide ${key} rework REASON, then graphyard master approver ${key} DECISION` },
  'proofs-pending': { actor: 'a proof producer: no producer request is raised for its unproven proofs', next: key => `graphyard master status; file the control-plane defect that raised no producer request for ${key}` },
  'provider-exhausted': { actor: 'reviewer capacity: every reviewer profile is exhausted', next: key => `graphyard master status; add reviewer capacity or select another review provider for ${key}` },
  'provider-dispatched': { actor: 'the review provider', next: key => `graphyard master status ${key}` },
  'not-required': { actor: 'nobody', next: key => `graphyard master status ${key}` },
  approved: { actor: 'nobody', next: key => `graphyard master status ${key}` },
  carried: { actor: 'nobody', next: key => `graphyard master status ${key}` },
};

/** The named wait that accounts for a submitted item nobody is otherwise acting for, or null. */
function namedWait(work: Work, state: ReviewState, now: Date): string | null {
  if (work.blocker) return 'blocked';
  if (standingEscalations(work).length) return 'escalated';
  if (work.queue) return 'queued';
  if (work.lease && Date.parse(work.lease.expiresAt) > now.getTime()) return 'leased';
  if (pendingBaseRefresh(work)) return 'base refresh';
  if (state === 'approved' || state === 'carried' || state === 'not-required') return 'reviewed';
  if (state === 'provider-dispatched') return 'provider review';
  return null;
}

/** When the item last had someone acting for it: its stage entry, or the newest dispatch request on it. */
function lastActorAt(work: Work): number {
  const dispatch = work.autoDispatch;
  const times = [work.stageEnteredAt, ...(dispatch?.history ?? []).flatMap(request => [request.requestedAt, request.resolvedAt ?? ''])]
    .map(value => Date.parse(value ?? '')).filter(Number.isFinite);
  return times.length ? Math.max(...times) : Number.NaN;
}

/**
 * Every submitted item past the bound with no review request, no producer request, no rework
 * request and no named wait. `reworkDecisions` holds the keys of items with a rework decision the
 * loop has requested and not yet seen settled; that is a rework request too.
 */
export function actorlessSubmissions(work: Work[], now: Date, reworkDecisions: ReadonlySet<string> = new Set(), boundMs = actorlessBoundMs): AttentionItem[] {
  return work.flatMap(item => {
    if (item.stage === 'done' || !item.submission || !item.candidate || !item.observation || item.reworkRequested || reworkDecisions.has(item.key)) return [];
    const dispatch = item.autoDispatch;
    if (dispatch?.review?.state === 'requested' || dispatch?.producers.some(request => request.state === 'requested')) return [];
    const need = reviewNeed(item, work, now);
    if (namedWait(item, need.state, now)) return [];
    const idleMs = now.getTime() - lastActorAt(item);
    if (!(idleMs > boundMs)) return [];
    const missing = missingActor[need.state];
    return [{ subject: item.key, text: `${item.key} candidate ${item.candidate.sha.slice(0, 12)} has been submitted for ${Math.round(idleMs / 60_000)}m with no review request, no producer request, no rework request and no named wait; missing ${missing.actor} (${need.reason})`,
      ...agentOwner('master', missing.next(item.key)) }];
  });
}
