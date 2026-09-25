import { resourceConflicts } from '../coordination.js';
import { standingEscalations } from './escalation.js';
import { actionJudgment, nextActionLlmRoles, type NextAction, type NextActionKind } from './action-kinds.js';
import { escalationTriggers, type Work } from './work.js';

/**
 * What stands beside an action, and what an action nobody may run is waiting for (GY-104).
 *
 * `next-action.ts` names the step an item needs. Two facts about an item are not that step and
 * were lost because nothing held them:
 *
 * - **A concern that blocks something else.** An escalation refuses delivery — the merge gate
 *   carries its refusal — and refuses nothing else. Answering it before anything else about the
 *   item was considered froze work it did not block: three items whose leases lapsed when the
 *   operator stopped every session sat for fifty minutes with no action but `escalate`, while ten
 *   worker profiles idled. The concern is now carried beside whatever the item actually needs.
 * - **An action no executor may claim.** `escalate` and `request-rework` are judgments made in
 *   the step itself (`actionJudgment`), so the executor holds no handler for either: such a row
 *   is never claimed, never fails, and never shows as a refused launch. Without a name for that
 *   state it was one more unclaimed row in the queue, indistinguishable from work an executor was
 *   about to take, and noticed only if somebody read the idle list five minutes later.
 *
 * Both are recorded with the computed action, so every reader — the dashboard, `master status`,
 * the durable loop, the API — sees them without recomputing anything.
 */

/** One standing concern kept beside an action it does not block, with what settles it. */
export interface CarriedConcern { kind: 'escalation'; trigger: string; reason: string; at: string; resolve: string }
/** Why an action leaves the executor loop, and the one command that answers it. */
export interface HumanNeeded { decision: string; resolve: string }
/** The computed action as this module writes it; `Work['nextAction']` is typed as the base kind. */
export interface OpenAction extends NextAction { carried?: CarriedConcern[]; needsHuman?: HumanNeeded }
export const openAction = (work: Pick<Work, 'nextAction'>): OpenAction | null => (work.nextAction ?? null) as OpenAction | null;

/** How a standing escalation is settled: a spawned handler that follows precedent, or a judged decision. */
export const escalationResolution = (key: string, trigger: string) =>
  `graphyard master escalation ${key} ${trigger} spawns a handler that follows precedent; a judgment nobody has taken before is graphyard master decide ${key} resolve '{"trigger":"${trigger}"}' REASON, then graphyard master approver ${key} DECISION`;

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
  if (action.kind === 'request-rework') return { decision: `a new head for ${action.key}`,
    resolve: `graphyard master decide ${action.key} rework REASON, then graphyard master approver ${action.key} DECISION` };
  const trigger = action.inputs.kind === 'escalate' ? action.inputs.trigger : 'refusal';
  const standing = (escalationTriggers as readonly string[]).includes(trigger);
  const detail = action.inputs.kind === 'escalate' ? action.inputs.detail : action.reason;
  // A standing trigger is settled by resolving it. Everything else is a gate refusing something
  // no executor step answers — an exhausted reviewer roster, an unverified branch protection —
  // and what has to be decided is named in the refusal itself, so the command that reads it out
  // with the item's own state is the one to run: the same fallback `master status` uses.
  return { decision: `resolving ${action.key}'s ${trigger} ${standing ? 'escalation' : 'refusal'}`,
    resolve: standing ? escalationResolution(action.key, trigger) : `graphyard diagnose ${action.key} — ${detail}` };
}

const carriedConcern = (key: string, escalation: { trigger: string; reason: string; at: string }): CarriedConcern =>
  ({ kind: 'escalation', trigger: escalation.trigger, reason: escalation.reason, at: escalation.at, resolve: escalationResolution(key, escalation.trigger) });

/**
 * Why no fresh attempt can start on this item right now, apart from anything the gates or a
 * standing escalation say — the one hold `assertDispatchable` applies that the gates do not.
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

/**
 * The step an item needs, with every standing concern accounted for.
 *
 * An escalation refuses delivery and refuses nothing else: the merge gate carries its refusal, so
 * an item whose only remaining refusal is the escalation is still named `escalate` by the gate
 * mapping, exactly as before. Everything earlier than delivery is named as it would be with no
 * escalation standing, and the escalation is carried beside it — the work the concern does not
 * block is not frozen by it, and the concern is not lost behind the work.
 *
 * An item that cannot be worked is the one case where the concern is still the action. A
 * `dispatch` for an item nothing may be assigned to (`dispatchHold`) is an action no executor can
 * complete: naming it would replace one silence with another — a row failing on the resource every
 * settle window — and hide the judgment the item owes behind it. Nothing can move there, so what
 * is owed is what is named.
 */
export function carriedAction(work: Work, action: NextAction | null, all: Work[], now: Date): OpenAction | null {
  const standing = work.ready ? standingEscalations(work) : [];
  const assignment = !!standing.length && action?.kind === 'dispatch' && action.inputs.kind === 'dispatch' && action.inputs.target === 'implementation';
  const held = assignment ? dispatchHold(work, all, now) : null;
  if (standing.length && (!action || held)) {
    const first = standing[0];
    const escalate: NextAction = { kind: 'escalate', work: work.id, key: work.key, gate: null, refusal: null,
      reason: held ? `${work.key} has a standing ${first.trigger} escalation and no assignment it can take (${held}): ${first.reason}`
        : `${work.key} has a standing ${first.trigger} escalation and nothing else to do: ${first.reason}`,
      inputs: { kind: 'escalate', trigger: first.trigger, detail: first.reason }, llmRole: nextActionLlmRoles.escalate,
      binding: `escalation:${first.trigger}:${first.at}` };
    return { ...escalate, needsHuman: humanNeeded(escalate)!, ...(standing.length > 1 ? { carried: standing.slice(1).map(entry => carriedConcern(work.key, entry)) } : {}) };
  }
  if (!action) return null;
  // The escalation the action already names is the action, not a concern carried beside it.
  const carried = standing.filter(entry => !(action.inputs.kind === 'escalate' && action.inputs.trigger === entry.trigger))
    .map(entry => carriedConcern(work.key, entry));
  const owed = humanNeeded(action);
  return { ...action, ...(owed ? { needsHuman: owed } : {}), ...(carried.length ? { carried } : {}) };
}

/** One row per concern waiting on somebody outside the executor loop, longest wait first. */
export interface HumanNeededRow {
  key: string; work: string;
  /** `action`: the item's own action is one no executor may claim. `carried`: a concern standing beside an action that is running. */
  source: 'action' | 'carried';
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
 */
export function humanNeededActions(all: readonly Work[], now: Date): HumanNeededRow[] {
  const rows: HumanNeededRow[] = [];
  for (const work of all) {
    const action = openAction(work);
    if (!action) continue;
    const row = (work.actionQueue?.actions ?? []).find(entry => entry.kind === action.kind && entry.binding === action.binding) ?? null;
    const since = (at: string | null) => {
      const parsed = at ? Date.parse(at) : Number.NaN;
      const instant = Number.isFinite(parsed) ? parsed : now.getTime();
      return { since: new Date(instant).toISOString(), waitedMs: Math.max(0, now.getTime() - instant) };
    };
    if (action.needsHuman) rows.push({ key: work.key, work: work.id, source: 'action', kind: action.kind,
      trigger: action.inputs.kind === 'escalate' ? action.inputs.trigger : null, reason: action.reason,
      ...action.needsHuman, action: row?.id ?? null, ...since(row?.requestedAt ?? null) });
    for (const concern of action.carried ?? []) rows.push({ key: work.key, work: work.id, source: 'carried', kind: action.kind,
      trigger: concern.trigger, reason: `${work.key} carries a standing ${concern.trigger} escalation while it is worked: ${concern.reason}`,
      decision: `resolving ${work.key}'s ${concern.trigger} escalation`, resolve: concern.resolve, action: null, ...since(concern.at) });
  }
  return rows.sort((a, b) => b.waitedMs - a.waitedMs || a.key.localeCompare(b.key));
}
