import type { Work } from '../model/work.js';
import { type ActionlessItem, accountOutcome, stallBoundMs } from '../model/action-account.js';
import { actionAccount } from './next-action.js';
/** Every open item the control plane names no action for, with the reason it names instead. */
export function actionlessItems(all: Work[], now: Date): ActionlessItem[] {
  return all.filter(work => work.ready && work.stage !== 'done')
    .map(work => actionAccount(work, all, now))
    .filter(account => !account.action)
    .map(account => ({ key: account.key, work: account.work, gate: account.gate, refusal: account.refusal,
      heldSince: account.heldSince, heldMs: account.heldMs, outcome: accountOutcome(account), wait: account.wait,
      waitingOn: account.wait?.on ?? null,
      detail: account.defect ?? account.wait?.detail ?? 'no reason was recorded' }))
    .sort((a, b) => b.heldMs - a.heldMs);
}

/**
 * Open items with no action and nothing moving them, past the bound.
 *
 * Counted apart from the items that are genuinely waiting on something that will move them — a
 * dependency, the entry ahead of them in the merge queue, the session already building them.
 * What is left is an item holding a failing gate with nobody told, which is the defect, and an
 * item waiting on one of the three decisions only a person may make, which is owed to a person.
 */
export function stalledItems(all: Work[], now: Date, thresholdMs = stallBoundMs): ActionlessItem[] {
  return actionlessItems(all, now).filter(entry => (entry.outcome === 'unaccounted' || entry.outcome === 'human') && entry.heldMs > thresholdMs);
}
