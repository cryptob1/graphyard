import { actionAccount } from './next-action.js';
import type { NextAction } from './action-kinds.js';
import type { Work } from './work.js';

/**
 * The vocabulary for what an item needs, or for why it needs nothing.
 *
 * It is separated from the computation in `next-action.ts` for the same reason `action-kinds.ts`
 * is: everything downstream — master status, the coordination loop, the dashboard — reads this
 * without computing anything, and adding a kind of wait means answering here what it means and
 * who it names, in one place, rather than in each reader.
 */

/**
 * Why an item needs nothing from anybody, when it needs nothing.
 *
 * `nextAction` returning `null` used to mean five different things at once, and the difference
 * between them is the whole of what this vocabulary exists to say. An item waiting for a
 * dependency to ship is healthy; an item whose failing gate produced no action at all is the
 * defect GY-103 sat in for hours with nobody told. So every place that computes "nothing" now
 * says which nothing it is, and the one case that is none of them is named a defect rather than
 * left as silence:
 *
 * - `dependency` — another item's action moves this one. Its key is on `on`.
 * - `queue` — the merge ahead of it in the queue moves it; that entry's key is on `on`.
 * - `session` — a live session is already doing exactly what the gate waits for.
 * - `human` — one of the three decisions the project reserves for a person (AGENTS.md).
 * - `settled` — no gate refuses: the item is delivered, or merged and awaiting its record.
 */
export const waitKinds = ['dependency', 'queue', 'session', 'human', 'settled'] as const;
export type WaitKind = typeof waitKinds[number];
export interface ActionWait {
  kind: WaitKind;
  /** Who moves it: an item key, the session owner holding it, the operator; null when nobody is named. */
  on: string | null;
  detail: string;
}

/**
 * The complete answer for one item: the action it needs, or the named wait that says why it needs
 * none — and, when neither could be produced, the defect that says so.
 *
 * `defect` is the field this work item exists for. It is never set by a rule anybody wrote for a
 * situation; it is what is left when every rule has run and named nothing, which is exactly the
 * state no reader could previously distinguish from a healthy idle item. Nothing synthesises an
 * action to paper over it: naming an action no executor can complete is the failure mode the
 * mapping already guards against everywhere else (see `reviewStandstill` in
 * `refusal-mapping.ts`). It is reported instead — by `master status`, by the coordination loop's
 * actionable inventory, and by the dashboard.
 */
export interface ActionAccount {
  work: string; key: string;
  /** The failing gate this account answers and the refusal of it that was acted on; null when none refuses. */
  gate: string | null; refusal: string | null;
  action: NextAction | null;
  wait: ActionWait | null;
  defect: string | null;
  /** When the item entered the step its failing gate belongs to, and how long ago that was. */
  heldSince: string; heldMs: number;
}

/**
 * The three answers AC-1 allows an open item, plus the two that are not answers about a refusal:
 * `settled` (nothing refuses) and `unaccounted` (the defect). `action` covers both an action an
 * executor runs and one that is a judgment owed — `actionJudgment` on the kind tells them apart,
 * and both are answers, because both name somebody who can complete them.
 */
export const accountOutcomes = ['action', 'waiting-on', 'human', 'settled', 'unaccounted'] as const;
export type AccountOutcome = typeof accountOutcomes[number];
export function accountOutcome(account: Pick<ActionAccount, 'action' | 'wait' | 'defect'>): AccountOutcome {
  if (account.defect) return 'unaccounted';
  if (account.action) return 'action';
  if (!account.wait) return 'unaccounted';
  return account.wait.kind === 'human' ? 'human' : account.wait.kind === 'settled' ? 'settled' : 'waiting-on';
}

// ---- What is owed and nobody told -----------------------------------------------------------

/**
 * How long an open item may hold a failing gate with nothing named before it is somebody's
 * problem. It is the bound `actionIdleMs` applies to a queued row nobody claims; an item with no
 * row at all was invisible to that measure, and this is the same patience applied to it.
 */
export const stallBoundMs = 5 * 60_000;

/** One open item with no action, and what the control plane says instead. */
export interface ActionlessItem {
  key: string; work: string;
  gate: string | null; refusal: string | null;
  heldSince: string; heldMs: number;
  outcome: AccountOutcome;
  /** The wait that explains it, when one does; null when nothing explained it. */
  wait: ActionWait | null;
  /** Who moves it — another item, a live session, the operator — or null when nobody was named. */
  waitingOn: string | null;
  detail: string;
}

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

