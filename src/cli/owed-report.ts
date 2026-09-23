import { agentOwner, type AttentionItem } from '../master.js';
import type { Work } from '../model.js';
import { humanNeededActions, type HumanNeededRow } from '../model/next-action.js';
import { decideScopeRequest } from '../model/scope.js';
import { elapsed } from '../model/sessions.js';

/**
 * What `master status` says about work that is waiting on a judgement rather than on capacity
 * (GY-104).
 *
 * `escalate` and `request-rework` are judgments made in the step itself, so no executor holds a
 * handler for either: their rows are never claimed, never fail, and never appear as a refused
 * launch. Counted with the queue they were indistinguishable from work an executor was about to
 * take, and noticed only if somebody read the idle list five minutes later. Here they are their
 * own population — named, owed, and counted apart.
 */

/**
 * One attention item per open worker scope request that somebody actually has to decide.
 *
 * A request the item's own criteria — or this repository's documentation rule — already imply is
 * nobody's decision: the control plane computes `approve-scope` for it and an executor applies the
 * widening, with no master session and no command. Naming those here asked a master to run
 * `master scope` for a verdict already determined, and an item one file short of finishing waited
 * on that line being read. The verdict is recomputed from the item itself, never taken from the
 * request; a request from a lease that ended is never surfaced.
 */
export function scopeRequestAttention(snapshot: { work: Work[]; now: string }): AttentionItem[] {
  return snapshot.work.flatMap(work => {
    const request = work.scopeRequest;
    const live = request && work.lease && work.lease.epoch === request.epoch && Date.parse(work.lease.expiresAt) > Date.parse(snapshot.now);
    if (!live) return [];
    const decision = request.decision ?? decideScopeRequest(work, request);
    if (decision.state === 'approved') return [];
    return [{ subject: work.key, text: `${request.requestedBy} needs files outside plannedFiles: ${request.paths.join(', ')} — ${request.reason}. The widening rule refuses it: ${decision.reason}`,
      ...agentOwner('master', `graphyard master scope ${work.key}`) }];
  });
}

/**
 * One attention item per action nobody in the executor loop may run, and per concern carried
 * beside an action that is running. Each names what is waiting, how long it has waited and the
 * command that answers it.
 */
export function humanNeededAttention(snapshot: { work: Work[]; now: string }): AttentionItem[] {
  return humanNeededActions(snapshot.work, new Date(snapshot.now)).map(row => ({
    subject: row.key,
    text: `${row.reason} — no executor may run it; ${row.decision} has been owed for ${elapsed(row.waitedMs)}`,
    ...agentOwner('master', row.resolve, 'approver'),
  }));
}

/**
 * The action report with the two populations separated: rows an executor will take, and rows only
 * a judgment settles. `waiting` and `idle` are what the queue offers executors, so a row nobody
 * may claim is taken out of both — it would otherwise age into the idle list as though an
 * executor were late to it.
 */
export function needsHumanActions<T extends { waiting: { id: string }[]; idle: { id: string }[] }>(report: T, owed: HumanNeededRow[]) {
  const rows = new Set(owed.map(entry => entry.action).filter((id): id is string => !!id));
  return { ...report, needsHuman: owed, waiting: report.waiting.filter(entry => !rows.has(entry.id)), idle: report.idle.filter(entry => !rows.has(entry.id)) };
}

/**
 * What `master status` adds for work waiting on a judgment: every owed row (counted apart from the
 * queue), the attention items for items whose row does not already carry an attention line — an
 * item says this once, and the rest would be named nowhere at all — and how many attention lines
 * the owed items and scope requests add to the total.
 */
export function owedAttention(snapshot: { work: Work[]; now: string }, rows: { key: string; attention: string | null }[], scopeRequests: AttentionItem[]) {
  const rowAttention = (key: string) => !!rows.find(row => row.key === key)?.attention;
  const items = humanNeededAttention(snapshot).filter(item => !rowAttention(item.subject));
  return { rows: humanNeededActions(snapshot.work, new Date(snapshot.now)), items,
    counted: items.length + scopeRequests.filter(item => !rowAttention(item.subject)).length };
}
