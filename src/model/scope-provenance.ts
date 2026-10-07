// Concern: who settled a planned-files widening, as the intervention fold reads it from the ledger (GY-1388).
//
// A worker that needs a file its plan did not name asks for it, and the control plane settles most
// of those asks on its own: the engine's implication rule (`autoscope`), the loop's audited grounds
// (a review finding, a pinning test, a companion, a symbol a criterion names: cycle-scope.ts), and
// — for what no rule grounds — the independent approver, on a decision the loop itself routes with
// no master session involved (GY-176, GY-1008). None of those is a person or a coordinator stepping
// in, so none is an intervention. A widening a master session or an operator authors (`master
// scope`, `master requirements`, a decision it requests in its own words) still is.
//
// Most of those that remained were a master — or the doctor — running `master scope` on an ask the
// rule had refused and the loop was already putting to the approver, minutes before the routed
// decision arrived (GY-1377, GY-1379). The control plane refuses that hand widening while the
// approver still judges the ask (`handScopeWideningRefusal`), and the board names the decision
// to read rather than `master scope` (`scopeAskCommand`).
import type { Work } from './work.js';
import { pathScopeContains, scopeBlockedBudgetMs, unplannedPaths } from './scope.js';
import { routableScopeRequest, terminalScopeRefusal } from './scope-collapse.js';

/** The opening of the reason the loop writes when it widens on its own audited grounds (cycle-scope.ts widenOnFindings). */
export const groundedWideningReason = (key: string) => `Additive scope ${key}'s own change calls for — `;
const groundedWidening = /^Additive scope \S+'s own change calls for — /;
/** What `scopeDecisionReason` (model/scope.ts) tells the approver of a scope request the loop routed to it. */
export const routedScopeJudgement = 'The implication rule refused it and no review finding on the item\'s own change names it, so it is the approver\'s judgement';
/** What `blockerScopeDecision` (daemon/decisions.ts) tells the approver of a planned-file-scope blocker the loop routed to it. */
export const routedBlockerJudgement = 'Approve the additive plannedFiles widening if the item\'s criteria justify those files';

export type WideningSettlement = 'loop-rule' | 'routed-approver';
const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);

/** True when a requested `requirements` decision's reason is one the loop's routing writes: a scope ask or a scope blocker put to the approver. */
export const routedWideningRequest = (reason: unknown): reason is string => typeof reason === 'string' && (reason.includes(routedScopeJudgement) || reason.includes(routedBlockerJudgement));
/**
 * True when a `decision.requested` payload is a widening the loop routed: the scope decision it
 * requests names the ask it answers in its input (`answers`, daemon/decisions.ts
 * scopeRoutineDecision), which a decision a master requests by hand does not; a scope blocker's is
 * known by the reason the loop writes for it.
 */
export const routedWideningDecision = (payload: { action?: unknown; input?: { answers?: unknown } | null; reason?: unknown } | null | undefined): boolean =>
  payload?.action === 'requirements' && (isObject(payload.input?.answers) || routedWideningRequest(payload.reason));

/**
 * How the control plane settled the widening a `requirements` row records, or null when somebody
 * authored it. Only an operator agent's row carries `intent` (engine.ts), so the loop's own grounds
 * are read from that alone. An approved decision is applied under its requester as an admin, with
 * the decision's reason and an audit suffix cut to the 2000-character bound (server/decisions.ts
 * applyThroughEngine), so its row begins with the reason the decision was requested with: `routed`
 * holds the reasons of the item's decisions the loop routed (`routedWideningRequest`).
 */
export function wideningSettlement(details: unknown, routed: readonly string[] = []): WideningSettlement | null {
  if (!isObject(details)) return null;
  if (isObject(details.intent)) return typeof details.intent.reason === 'string' && groundedWidening.test(details.intent.reason) ? 'loop-rule' : null;
  const reason = typeof details.reason === 'string' ? details.reason : '';
  // The request may lie before the report's reach while its application lies inside: the applied
  // reason still opens with the routed wording, well inside the 2000-character bound.
  return reason && (routed.some(requested => reason.startsWith(requested)) || routedWideningRequest(reason)) ? 'routed-approver' : null;
}

/**
 * The open ask a hand widening would pre-empt (GY-1388): a live attempt's additive ask the rule
 * refused, which the loop puts to the independent approver (`routableScopeRequest`), when the
 * revision covers any path it asks for. Null for anything else — an undecided ask, one the
 * approver already refused, a non-additive or over-cap one — which stays the master's.
 */
export function routedScopeAsk(work: Pick<Work, 'scopeRequest' | 'lease' | 'plannedFiles' | 'criteria'>, plannedFiles: readonly string[], now: number) {
  const request = work.scopeRequest;
  if (request?.decision?.decidedBy !== 'graphyard' || !routableScopeRequest(work, now)) return null;
  return unplannedPaths(work.plannedFiles, request.paths).some(path => plannedFiles.some(planned => pathScopeContains(planned, path))) ? request : null;
}

/**
 * Why an operator agent's hand widening of a routed ask is refused, or null when it may proceed:
 * while the approver's decision on it is pending, and — before the loop has requested one — for
 * the bound the loop promises to settle a scope ask in (`scopeBlockedBudgetMs`). A decided, stale,
 * failed or withdrawn decision, or none past that bound (no approver serves), leaves it the master's.
 */
export function handScopeWideningRefusal(key: string, request: { at: string; decision?: { at: string } | null }, pending: string | null, decided: boolean, now: number): string | null {
  const within = now - Date.parse(request.decision?.at ?? request.at) < scopeBlockedBudgetMs;
  if (!pending && (decided || !within)) return null;
  return `${key}'s scope request is the independent approver's to judge: ${pending ? `the loop routed it as requirements decision ${pending}` : `the loop routes it as a requirements decision within ${scopeBlockedBudgetMs / 60_000} minutes of the rule's refusal`}, and a hand widening would pre-empt that judgement. Read it with graphyard master decisions ${key}; a master widens it by hand only once that decision is refused, stale or withdrawn${pending ? '' : ', or none comes within the bound'}`;
}

/** The command that takes a refused scope ask forward: the approver's decision while the loop routes it, otherwise `master requirements` past the cap or `master scope`. */
export const scopeAskCommand = (work: Work, now: number) => work.scopeRequest?.decision?.decidedBy === 'graphyard' && routableScopeRequest(work, now)
  ? `graphyard master decisions ${work.key}`
  : terminalScopeRefusal(work) ? `graphyard master requirements ${work.key} FILE REASON` : `graphyard master scope ${work.key}`;
