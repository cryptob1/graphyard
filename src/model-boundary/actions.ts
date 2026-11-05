import { actionRecordLimit, claimLive, settling } from '../model/action-progress.js';
import type { NextActionKind, NextAction } from '../model/action-kinds.js';
import { createHash } from 'node:crypto';
import type { Work } from '../model/work.js';
import { type ActionTransition, actionQueue, type ActionRow, actionHistoryLimit, record } from '../model/actions.js';
import { nextAction } from './next-action.js';
import { sameAction } from '../model/next-action.js';
export { actionRecordLimit };

export const actionId = (kind: NextActionKind, workId: string, binding: string) =>
  createHash('sha256').update(['action', kind, workId, binding].join('\0')).digest('hex').slice(0, 32);

/**
 * Bring the item's rows in line with what it needs now, and say what changed.
 *
 * Pure over the item, its graph and the clock. A situation that has not changed reconciles to the
 * same row; one that has retires the row that no longer applies — naming what moved — and opens
 * the row that does. An expired claim returns its row to `pending` without losing the attempt
 * count, which is what makes a dead executor cost one attempt rather than the action.
 */
export function reconcileActions(work: Work, all: Work[], now: Date, options: { requester?: string; next?: NextAction | null } = {}): ActionTransition[] {
  const requester = options.requester ?? 'graphyard';
  const queue = actionQueue(work);
  const at = now.toISOString();
  const transitions: ActionTransition[] = [];
  const retire = (row: ActionRow, reason: string) => {
    const resolved: ActionRow = { ...row, claim: null, resolvedAt: row.resolvedAt ?? at, resolution: row.resolution ?? reason };
    queue.history = [...queue.history, resolved].slice(-actionHistoryLimit);
    // A row that completed is history the moment its situation moves on; only an unfinished
    // one is cancelled, and then the reason says what replaced it.
    if (row.state === 'done') return;
    record(resolved, { at, event: 'cancelled', requester: row.requestedBy, executor: row.claim?.executor ?? null, result: null, reason });
    transitions.push({ event: 'cancelled', action: resolved });
  };
  // The caller may have computed the action already — an evaluation writes it onto the item as
  // well as reconciling the queue — and the same snapshot always names the same action, so it is
  // taken rather than computed a second time.
  const next = 'next' in options ? options.next ?? null : nextAction(work, all, now);
  const wanted = next ? actionId(next.kind, work.id, next.binding) : null;

  const kept: ActionRow[] = [];
  for (const row of queue.actions) {
    if (row.id !== wanted) {
      // An executor holding a live claim still owes a result, and running the action is itself
      // what moved the situation on. Retiring the row under it would leave that settlement with
      // nothing to land on — every completed action recorded as a failure, and the history that
      // says who ran what lost. The row is kept until it settles or its claim expires; the row
      // the item now needs is opened beside it, and `claimable` keeps this one out of the queue.
      if (row.state === 'claimed' && claimLive(row, now)) { kept.push(row); continue; }
      retire(row, next ? `${work.key} now needs ${next.kind} instead: ${next.reason}` : `${work.key} no longer needs this action`);
      continue;
    }
    // The claim of an executor that stopped renewing is released; the row stays open.
    if (row.state === 'claimed' && !claimLive(row, now)) {
      const executor = row.claim!.executor;
      row.state = 'pending'; row.claim = null;
      record(row, { at, event: 'reclaimed', requester: row.requestedBy, executor, result: null, reason: `claim by ${executor} expired without a result; the action is open for another executor` });
      transitions.push({ event: 'reclaimed', action: row });
    }
    // A completed action whose situation outlived its settle window did not fix it; owe another.
    if (row.state === 'done' && !settling(row, now)) {
      row.state = 'pending'; row.claim = null; delete row.retryAt; delete row.stall;
      const reason = `${row.kind} completed at ${row.resolvedAt} (${row.resolution ?? 'no result recorded'}) and ${work.key} still needs it`;
      record(row, { at, event: 'reopened', requester: row.requestedBy, executor: null, result: null, reason });
      transitions.push({ event: 'reopened', action: row });
    }
    kept.push(row);
  }
  queue.actions = kept;

  if (next && !queue.actions.some(row => row.id === wanted)) {
    const row: ActionRow = {
      id: wanted!, kind: next.kind, work: work.id, key: work.key, inputs: next.inputs,
      gate: next.gate, refusal: next.refusal, reason: next.reason, binding: next.binding,
      requestedBy: requester, requestedAt: at, state: 'pending', claim: null, attempts: 0, history: [],
    };
    record(row, { at, event: 'requested', requester, executor: null, result: null, reason: next.reason });
    queue.actions.push(row);
    transitions.push({ event: 'requested', action: row });
  }
  return transitions;
}

/**
 * Bring a delivered item's queue in line with what it still owes (GY-185).
 *
 * An item becomes done inside the transaction that observed its merge, after that transaction's
 * evaluation named the merge it was about to need; nothing evaluated it again, so it kept that
 * action, its merge and dispatch rows and its merge-queue entry, and executors retried them against
 * a delivery that refuses every one. Every path that delivers an item calls this in the same
 * transaction: the next action is recomputed — the deployment it owes, or nothing — every row that
 * is not that action is retired, and the queue entry, which only an undelivered candidate holds, is
 * cleared. A row an executor holds a live claim on is kept until it settles, as everywhere else,
 * and the settlement calls this again. Returns whether anything changed, including a completed row
 * retired to history, which reports no transition.
 */
export function settleDelivered(work: Work, all: Work[], now: Date): boolean {
  if (work.stage !== 'done') return false;
  const computed = nextAction(work, all, now);
  // A completed row is moved to history without a transition, so the rows themselves are compared:
  // a cleanup that only retires completed rows must still be saved, or every pass repeats it.
  const rows = (work.actionQueue?.actions ?? []).map(row => row.id).join();
  let changed = reconcileActions(work, all, now, { next: computed }).length > 0 || actionQueue(work).actions.map(row => row.id).join() !== rows;
  if (work.nextAction === undefined || !sameAction(work.nextAction, computed)) { work.nextAction = computed; changed = true; }
  return changed;
}
