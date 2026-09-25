import { agentOwner, humanOwner, type AttentionItem } from '../master.js';
import type { Work } from '../model.js';
import { stallBoundMs, stalledItems, type ActionlessItem } from '../model/action-account.js';
import { elapsed } from '../model/sessions.js';

// The orphaned-supervisor builders live in their own module (GY-138); they are read from here too.
export { nameOrphanSupervisors, orphanSupervisorAttention, supervisorReclaimCommand } from './orphan-supervisors.js';

/**
 * One attention item per requested decision whose approver could not be launched (GY-101). A
 * decision changes nothing until a session judges it, and a launch the runtime refuses — for a
 * name it will not take, a credential it cannot read, a workspace that is gone — leaves the watch
 * standing with a session that never started. `master status` used to show that as a decision
 * "waiting for approver session NAME to judge it", naming a session nobody could find. It is
 * named here as what it is, with the loop's own refusal and the command that launches it again.
 */
export function approverLaunchAttention(daemon: {
  approvals?: { key: string; work: string; action: string; decision: string; agentName: string | null; launches: number; launchedAt: string | null; requestedAt: string; settledAt: string | null }[];
  actions?: { key: string; kind: string; state: string; detail: string; at: string }[];
}): AttentionItem[] {
  const actions = daemon.actions ?? [];
  return (daemon.approvals ?? []).flatMap(watch => {
    if (watch.settledAt) return [];
    // The loop records a refused launch under the decision it was requested for (the request that
    // could not reach an approver) or under that launch's own key (a replacement that could not).
    const since = Date.parse(watch.launchedAt ?? watch.requestedAt);
    const refusal = actions.find(action => action.state === 'failed' && action.kind === 'decision'
      && (action.key === watch.key || action.key.startsWith(`approver:${watch.decision}:launch:`))
      && (!Number.isFinite(since) || Date.parse(action.at) >= since));
    return refusal ? [{ subject: watch.work, text: `${watch.work} is awaiting an approver for ${watch.action} decision ${watch.decision} that could not start${watch.agentName ? ` as ${watch.agentName}` : ''}: ${refusal.detail}`,
      ...agentOwner('master', `graphyard master approver ${watch.work} ${watch.decision} [AGENT_KIND]`, 'approver') }] : [];
  });
}

/**
 * Who is told what, and with which command.
 *
 * `master status` is an assembler over ledgers and snapshots; this is the part of it that turns
 * one observed situation into one line addressed to somebody. Each builder answers the same three
 * questions — what is true, how long it has been true, and whose command changes it — and keeping
 * them together is what stops two readers of the same situation saying different things about it.
 * Nothing here decides anything: every situation below was already decided by the control plane.
 */

/**
 * What an item with no action is missing, in one clause: the refusal its failing gate raised, or
 * the account itself when no gate said anything.
 */
const missingFrom = (entry: ActionlessItem) => entry.refusal ?? entry.detail;

/**
 * One attention item per open item the control plane names no action for and nothing is moving.
 *
 * This is the state with no other reporter. An item waiting on a dependency, on the entry ahead
 * of it in the merge queue, or on the session already building it has somewhere to be seen and
 * something that will move it; `actionlessItems` counts those separately and they raise nothing
 * here. What is left is an item holding a failing gate past the idle bound with no action, no
 * dependency and no recorded human need — which was, until this, exactly as visible as an item
 * that was fine. It is named with the gate, how long it has held it, what is missing, and who
 * answers: the operator for a decision the project reserves for a person, and the master for the
 * control-plane defect that a state produced no answer at all.
 */
export function stalledItemAttention(snapshot: { work: Work[]; now: string }, thresholdMs = stallBoundMs): AttentionItem[] {
  return stalledItems(snapshot.work, new Date(snapshot.now), thresholdMs).map(entry => {
    const held = `has held its ${entry.gate ?? 'unevaluated'} gate for ${elapsed(entry.heldMs)} with no action named and nothing moving it`;
    return entry.outcome === 'human'
      ? { subject: entry.key, text: `${entry.key} ${held}: ${missingFrom(entry)} — ${entry.detail}`, ...humanOwner('goals and priorities', entry.detail) }
      : { subject: entry.key, text: `${entry.key} ${held}: ${missingFrom(entry)} — the control plane computed neither an action, a dependency nor a human need for this state, which is a defect in the control plane rather than in the item (${entry.detail})`,
        ...agentOwner('master', `graphyard master create files the control-plane defect that left ${entry.key} without an action; until it is fixed, graphyard master status names no step for this item and nothing will claim it`) };
  });
}

/** Direct-merge mode (src/direct-merge.ts), first in master status and in one line while it is on: gated merging is bypassed. */
export const directMergeLine = (coordinator: any): { directMerge?: string } => coordinator?.directMerge?.line ? { directMerge: coordinator.directMerge.line } : {};
