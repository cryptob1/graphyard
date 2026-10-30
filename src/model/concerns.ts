import { resourceConflicts } from '../coordination.js';
import { actionJudgment, type NextAction, type NextActionKind } from './action-kinds.js';
import { isFilingRefusal } from './user-facing.js';
import type { Work } from './work.js';

/**
 * What an action nobody may run is waiting for (GY-104). `attention` and `request-rework` are
 * judgments made in the step itself (`actionJudgment`), so the executor holds no handler for
 * either: such a row is never claimed and never fails. It is recorded with the computed action,
 * so every reader — the dashboard, `master status`, the loop, the API — sees who owes it.
 */

/** Why an action leaves the executor loop, and the one command that answers it. */
export interface HumanNeeded { decision: string; resolve: string }
/** The computed action as this module writes it; `Work['nextAction']` is typed as the base kind. */
export interface OpenAction extends NextAction { needsHuman?: HumanNeeded }
export const openAction = (work: Pick<Work, 'nextAction'>): OpenAction | null => (work.nextAction ?? null) as OpenAction | null;

/**
 * What an action waits on when no executor may run it, or null when the loop can run it itself.
 *
 * `actionJudgment` already says which kinds are judgments made in the step rather than inside a
 * session the step starts, and the executor refuses to hold a handler for one. That refusal is
 * only half the rule: a row nobody may claim also has to be owed by somebody, or the item sits
 * with an action that never runs and nobody was told. This names who owes it, and with which
 * command.
 */
export function humanNeeded(action: NextAction): HumanNeeded | null {
  if (actionJudgment[action.kind] !== 'in-step') return null;
  // A rework the loop owes is applied by the loop itself (GY-1387, GY-2874); the hand command is the fallback.
  if (action.kind === 'request-rework') return { decision: `a new head for ${action.key}`, resolve: `graphyard master rework ${action.key} REASON` };
  // GY-2981: a filing refusal the ready gate raised is answered by requirements, which adds the
  // criterion the item's creation rules now demand — it never weakens the item to fit them.
  if (action.inputs.kind === 'attention' && isFilingRefusal(action.inputs.detail))
    return { decision: `filing ${action.key} under today's rules`, resolve: `graphyard master requirements ${action.key} FILE REASON` };
  // A gate refusing something no executor step answers — an exhausted reviewer roster, an
  // unverified branch protection — names what has to be decided in the refusal itself.
  const detail = action.inputs.kind === 'attention' ? action.inputs.detail : action.reason;
  return { decision: `resolving ${action.key}'s refusal`, resolve: `graphyard diagnose ${action.key} — ${detail}` };
}

/**
 * Why no fresh attempt can start on this item right now, apart from anything the gates or a
 * say — the one hold `assertDispatchable` applies that the gates do not.
 *
 * An assignment is the one action whose subject is another item as much as this one: an
 * exclusive resource held by somebody else is not visible in this item's own refusals, and is not
 * something the worker such an action would launch could do anything about. Planned-file overlap
 * is not a hold: dispatch is optimistic, and the merge queue and a sync round integrate whichever
 * of two overlapping items lands second.
 */
export function dispatchHold(work: Work, all: Work[], now: Date): string | null {
  const resources = resourceConflicts(work, all, now.getTime());
  return resources.length ? `exclusive resources are held by ${resources.map(conflict => `${conflict.key} (${conflict.resource})`).join(', ')}` : null;
}

/** A delivered (merged or Done) item owes nothing more. */
export const isDeliveredWork = (work: Pick<Work, 'stage'> & { observation?: { merged?: boolean } | null; delivery?: unknown }): boolean =>
  work.stage === 'done' || !!work.observation?.merged || !!work.delivery;

/** The step an item needs, with who owes it when no executor may run it. */
export function carriedAction(action: NextAction | null): OpenAction | null {
  if (!action) return null;
  const owed = humanNeeded(action);
  return { ...action, ...(owed ? { needsHuman: owed } : {}) };
}

/** One row per concern waiting on somebody outside the executor loop, longest wait first. */
export interface HumanNeededRow {
  key: string; work: string;
  source: 'action';
  kind: NextActionKind; trigger: string | null; reason: string;
  decision: string; resolve: string;
  /** The queue row that holds the action, when one is open for it. */
  action: string | null;
  since: string; waitedMs: number;
}

/**
 * Every concern that needs a person, across the graph.
 *
 * An action an executor may claim is work in progress however long it waits; an action no
 * executor may claim is waiting on somebody, and until this existed the two were indistinguishable
 * — one more unclaimed row, counted with the rest. Each row here names what is waiting, who
 * decides it, the command that answers it, and since when: from the moment the control plane
 * computed the action, not from the moment it grew old.
 *
 * Delivered work (merged or Done) is immutable and owes nothing, so it yields no rows.
 */
export function humanNeededActions(all: readonly Work[], now: Date): HumanNeededRow[] {
  const rows: HumanNeededRow[] = [];
  for (const work of all) {
    if (isDeliveredWork(work)) continue;
    const action = openAction(work);
    if (!action) continue;
    const row = (work.actionQueue?.actions ?? []).find(entry => entry.kind === action.kind && entry.binding === action.binding) ?? null;
    const since = (at: string | null) => {
      const parsed = at ? Date.parse(at) : Number.NaN;
      const instant = Number.isFinite(parsed) ? parsed : now.getTime();
      return { since: new Date(instant).toISOString(), waitedMs: Math.max(0, now.getTime() - instant) };
    };
    if (action.needsHuman) rows.push({ key: work.key, work: work.id, source: 'action', kind: action.kind,
      trigger: action.inputs.kind === 'attention' ? action.inputs.trigger : null, reason: action.reason,
      ...action.needsHuman, action: row?.id ?? null, ...since(row?.requestedAt ?? null) });
  }
  return rows.sort((a, b) => b.waitedMs - a.waitedMs || a.key.localeCompare(b.key));
}
