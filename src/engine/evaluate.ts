import { record } from '../store/mutations.js';
import type { Work } from '../model.js';
import type { DispatchTransition } from '../model/dispatch.js';
import { reconcileAutoDispatch } from '../model-boundary/dispatch.js';
import { reconcileReviewConflict } from '../model/review-conflict.js';
import type { ReviewConflictTransition } from '../model/review-conflict.js';
import { actionAccount } from '../model-boundary/next-action.js';
import { sameAction } from '../model/next-action.js';
import { reconcileActions } from '../model-boundary/actions.js';
import { livenessFallback } from '../model-boundary/liveness.js';
import { evaluate as evaluateGates } from '../model-boundary/gates.js';
import { reconcileDueAt } from '../reconcile/faces.js';

/** Auto-dispatch transitions the last evaluation of a document produced, written to the ledger by the transaction that
 * persists it. Keyed by the object, so a probe clone records nothing. */
const dispatchTransitions = new WeakMap<Work, DispatchTransition[]>();
const conflictTransitions = new WeakMap<Work, ReviewConflictTransition[]>();

/**
 * Evaluate one item and return the earliest instant at which its outcome could change with no
 * write (GY-1873): the minimum over the time-bounded inputs the evaluation read, which the
 * reconciliation keeps in its view so a pass wakes the item when that instant passes. The
 * derivation runs once and answers both — the account it computes names the action and the wait,
 * and the due reads the bounds beside them.
 */
export function evaluateWork(work: Work, all: Work[], now: Date): number | null {
  // One request, one verdict (GY-124): two verdicts from one identity on one head for one request
  // are recorded as a conflict and withheld from the observation before any gate reads it.
  conflictTransitions.set(work, [...(conflictTransitions.get(work) ?? []), ...reconcileReviewConflict(work, now)]);
  const result = evaluateGates(work, all, now);
  if (work.stage !== result.stage) work.stageEnteredAt = now.toISOString();
  Object.assign(work, result);
  // What the exact head still needs from a launched reviewer or producer, decided from the
  // gates just evaluated; the transitions reach the ledger with the document (recordDispatch).
  dispatchTransitions.set(work, reconcileAutoDispatch(work, all, now));
  // The typed instruction the inverted loop runs on: what this item needs next, named from the
  // gates just evaluated, and the durable row that says whether an executor has it.
  // The queue's own transitions are recorded on each row's history and travel to the ledger
  // with the document every save appends, so they need no second event of their own; the
  // executor's claim and settlement write their own named events.
  // One computation answers both: the queue reconciles against it and the item carries it, so
  // two readers of the same evaluation cannot disagree about what this item needs — and the
  // same account names the wait, whose bound is part of the due instant (GY-1873).
  const account = actionAccount(work, all, now);
  const computed = account.action;
  // An open item the derivation names nothing for and nothing moves is owned by an escalation (GY-201).
  reconcileActions(work, all, now, { next: computed ?? livenessFallback(work, all, now, account) });
  // Only a different decision is written: an identical action rebuilt in source order would
  // differ from the stored one by key order alone, and the reconciliation tick would rewrite
  // every item on every pass.
  if (work.nextAction === undefined || !sameAction(work.nextAction, computed)) work.nextAction = computed;
  // After the queue reconciled: the rows it leaves are the ones whose dues are read (GY-1873).
  return reconcileDueAt(work, all, now, account);
}
/** Append the auto-dispatch transitions of the last evaluation to the ledger, once, beside the document save. */
export async function recordDispatch(db: { query: (text: string, values: unknown[]) => Promise<unknown> }, work: Work, now: Date) {
  const transitions = dispatchTransitions.get(work) ?? [];
  dispatchTransitions.delete(work);
  for (const transition of transitions) await record(db, work, 'graphyard', transition.event, { details: { ...transition.request, at: now.toISOString() } });
  const conflicts = conflictTransitions.get(work) ?? [];
  conflictTransitions.delete(work);
  for (const transition of conflicts) await record(db, work, 'graphyard', transition.event, { details: { ...transition.conflict, at: now.toISOString() } });
}
