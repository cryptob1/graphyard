import type { Work } from '../model/work.js';
import { type OpenAction, carriedAction } from '../model/concerns.js';
import type { ActionAccount } from '../model/action-account.js';
import { livenessCarry } from './liveness.js';
import { computeAccount } from '../model/next-action.js';
/**
 * What this item needs next, or null when it needs nothing from anybody: it is delivered and
 * verified, a session is already doing what the gate waits for, or every refusal standing against
 * it belongs to another item (an unfinished dependency is that item's dispatch, not this one's),
 * with every standing concern beside it (`concerns.ts`).
 *
 * This is `actionAccount` with everything but the action dropped, kept because every caller that
 * only wants the instruction — the queue, the API, the executor — should not have to know about
 * the accounting. A caller that has to tell an idle item from a stalled one calls `actionAccount`.
 */
export function nextAction(work: Work, all: Work[], now: Date): OpenAction | null {
  return actionAccount(work, all, now).action;
}

/**
 * What this item needs next, or why it needs nothing — with the failing gate it answers and how
 * long the item has held it.
 *
 * The order is the order a delivery actually unblocks in: a typed request an agent left behind
 * first, because a session gave up its lease waiting for that answer; then a delivered item, which
 * owes nothing; then an assignment nobody holds any more; then the first refusing gate; and finally the merge a fully proven candidate
 * is authorized for. `carriedAction` (concerns.ts) names who owes an action no executor may run.
 */
export function actionAccount(work: Work, all: Work[], now: Date): ActionAccount {
  const heldSince = work.stageEnteredAt ?? work.updatedAt ?? now.toISOString();
  const held = Date.parse(heldSince);
  // The liveness rules (liveness.ts) apply to what was computed before any concern is carried.
  const computed = livenessCarry(work, computeAccount(work, all, now), all, now);
  const action = carriedAction(computed.action);
  return { work: work.id, key: work.key, ...computed, action, ...(action && !computed.action ? { wait: null, defect: null } : {}),
    heldSince, heldMs: Number.isFinite(held) ? Math.max(0, now.getTime() - held) : 0 };
}
