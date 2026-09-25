import { agentOwner, type AttentionItem, type AttentionOwner } from '../master.js';
import type { Work } from '../model.js';
import { humanNeededActions, type HumanNeededRow } from '../model/next-action.js';
import { decideScopeRequest, scopeRefusalBlocker } from '../model/scope.js';
import { elapsed } from '../model/sessions.js';
import { routedScopeRequests } from './status-attention.js';

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
 * request; a request from a lease that ended is never surfaced. Nor is one the loop has routed to
 * the independent approver (its `approvals` watch, GY-176): that is being decided, and the worker reads the outcome.
 */
export function scopeRequestAttention(snapshot: { work: Work[]; now: string }, approvals: Parameters<typeof routedScopeRequests>[0] = []): AttentionItem[] {
  const routed = routedScopeRequests(approvals);
  return snapshot.work.flatMap(work => {
    const request = work.scopeRequest;
    const live = request && work.lease && work.lease.epoch === request.epoch && Date.parse(work.lease.expiresAt) > Date.parse(snapshot.now);
    if (!live || routed(work)) return [];
    const decision = request.decision ?? decideScopeRequest(work, request);
    if (decision.state === 'approved') return [];
    return [{ subject: work.key, text: `${request.requestedBy} needs files outside plannedFiles: ${request.paths.join(', ')} — ${request.reason}. The widening rule refuses it: ${decision.reason}`,
      ...agentOwner('master', `graphyard master scope ${work.key}`) }];
  });
}

type RoutedWatch = { work: string; action: string; decision: string; settledAt?: string | null; scope?: { epoch: number; at: string } | null };

/**
 * A request the loop has routed to the independent approver (GY-176) is being decided. While its
 * watch is unsettled and only the rule has refused it, the item's row says so and names the
 * decision, rather than the rule refusal's gate and `master unblock`, which would send a master to
 * widen or unblock what the approver is already judging. `routedScope` marks the row, so its owed
 * action is named the same way (`owedAttention`).
 */
export function routedScopeStatus<S extends { work: { key: string; attention: string | null; attentionOwner: AttentionOwner | null }[]; attentionItems: AttentionItem[] }>(status: S, work: readonly Work[], approvals: readonly RoutedWatch[] = []): S {
  const judging = new Map(approvals.filter(watch => watch.action === 'requirements' && watch.scope && !watch.settledAt).map(watch => [`${watch.work}:${watch.scope!.epoch}:${watch.scope!.at}`, watch.decision]));
  const rows = status.work.map(row => {
    const item = work.find(entry => entry.key === row.key), request = item?.scopeRequest;
    const decision = request && judging.get(`${row.key}:${request.epoch}:${request.at}`);
    if (!decision || !row.attention || request.decision?.decidedBy !== 'graphyard' || !item!.blocker?.startsWith(scopeRefusalBlocker)) return row;
    const next = `Nothing to run: the approver judges requirements decision ${decision} (graphyard master decisions ${row.key}); ${request.requestedBy} reads the outcome with scope-request ${row.key} ${request.epoch} --wait`;
    return { ...row, routedScope: next, attention: `${row.key}'s scope request for ${request.paths.join(', ')} is with the independent approver: the rule refused it and the loop routed it as requirements decision ${decision}`, attentionOwner: agentOwner('control plane', next, 'approver') };
  });
  const routed = new Map(rows.flatMap((row, index) => row !== status.work[index] ? [[row.key, { from: status.work[index].attention, row }]] : []));
  return { ...status, work: rows, attentionItems: status.attentionItems.map(entry => {
    const change = routed.get(entry.subject);
    return change && entry.text === change.from ? { subject: entry.subject, text: change.row.attention!, ...change.row.attentionOwner! } : entry;
  }) };
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
export function owedAttention(snapshot: { work: Work[]; now: string }, rows: { key: string; attention: string | null; routedScope?: string }[], scopeRequests: AttentionItem[]) {
  const rowAttention = (key: string) => !!rows.find(row => row.key === key)?.attention;
  const items = humanNeededAttention(snapshot).filter(item => !rowAttention(item.subject));
  // The rule refusal's escalation of a request the approver is judging is answered by that decision.
  const routed = (key: string) => rows.find(row => row.key === key)?.routedScope;
  return { rows: humanNeededActions(snapshot.work, new Date(snapshot.now)).map(row => row.source === 'action' && routed(row.key)
    ? { ...row, decision: `the independent approver's judgement of ${row.key}'s routed scope request`, resolve: routed(row.key)! } : row), items,
    counted: items.length + scopeRequests.filter(item => !rowAttention(item.subject)).length };
}
