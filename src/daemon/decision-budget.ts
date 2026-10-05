// Concern: the decisions step's time budget — which items it reaches this cycle and which wait for the next (GY-1286).
import type { Work } from '../model.js';
import type { Cycle } from './cycle.js';
import { record } from './effects.js';
import { actionableIntervalMs } from './liveness.js';
import type { DaemonState } from './state.js';

/**
 * GY-1286: what the decisions step may spend before it hands the rest of its items to the next
 * cycle. Every request it makes is a control-plane write: a rework decision, an observation wake,
 * an approver launch. While the server is slow those writes run into their 30s timeout one after
 * another, and on 2026-10-05 the step spent 319s and then 365s of a 300s interval on them, so the
 * loop missed its budget and every subject waited a whole slow cycle (loop-cost on cycle 12285).
 * Two fifths of the interval, never under the 30s actionable cadence, leave the rest of the cycle
 * its share; a request already in flight at the bound finishes, so the step overruns by one call
 * at most. The loop comes back inside the actionable cadence and starts with what it put off.
 */
export const decisionBudgetMs = (intervalMs: number) => Math.max(actionableIntervalMs, Math.round(intervalMs * 0.4));

/** The items the step left for the next cycle come first, in the order they were put off; the rest keep `order`. */
export function deferredFirst(order: Work[], deferred: readonly string[]) {
  if (!deferred.length) return order;
  const rank = new Map(deferred.map((key, index) => [key, index]));
  return [...order].sort((a, b) => (rank.get(a.key) ?? Number.POSITIVE_INFINITY) - (rank.get(b.key) ?? Number.POSITIVE_INFINITY));
}

/**
 * The step's clock. `spent()` says whether the step has used its budget; an item reached past it is
 * `defer`red: the step still counts its decision as needed, so the watch cleanup withdraws nothing
 * for it, but makes no request for it this cycle. `settle()` records what was put off on the state.
 */
export function decisionBudget(state: Pick<DaemonState, 'decisionsDeferred'>, now: () => number, intervalMs: number) {
  const startedAt = now(), budgetMs = decisionBudgetMs(intervalMs), deferred: string[] = [];
  return {
    budgetMs,
    spent: () => now() - startedAt >= budgetMs,
    defer: (item: Work) => { if (!deferred.includes(item.key)) deferred.push(item.key); },
    settle: () => { state.decisionsDeferred = deferred; return deferred; },
  };
}

/** Record what the step put off, so the journal and `master status` say the step was bounded rather than silent. */
export async function settleDeferred(cycle: Pick<Cycle, 'state' | 'effects' | 'now' | 'performed'>, budget: ReturnType<typeof decisionBudget>) {
  const { state, effects, now, performed } = cycle, deferred = budget.settle();
  if (!deferred.length) return;
  const named = deferred.length > 20 ? `${deferred.slice(0, 20).join(', ')} and ${deferred.length - 20} more` : deferred.join(', ');
  performed.push(await record(state, 'decisions:deferred', { kind: 'decision', work: null, principal: null, state: 'done', attempts: (state.actions['decisions:deferred']?.attempts ?? 0) + 1, cycle: state.cycle,
    detail: `The decisions step spent its ${Math.round(budget.budgetMs / 1000)}s budget; ${deferred.length} item(s) wait for the next cycle, which reaches them first: ${named}` }, now(), effects.persist));
}
