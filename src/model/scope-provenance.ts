// Concern: who settled a planned-files widening, as the intervention fold reads it from the ledger (GY-1388).
//
// A worker that needs a file its plan did not name asks for it, and the control plane settles most
// of those asks on its own: the engine's implication rule (`autoscope`), the loop's audited grounds
// (a review finding, a pinning test, a companion, a symbol a criterion names: cycle-scope.ts), and
// — for what no rule grounds — the independent approver, on a decision the loop itself routes with
// no master session involved (GY-176, GY-1008). None of those is a person or a coordinator stepping
// in, so none is an intervention. A widening a master session or an operator authors (`master
// scope`, `master requirements`, a decision it requests in its own words) still is.

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
  return reason && routed.some(requested => reason.startsWith(requested)) ? 'routed-approver' : null;
}
