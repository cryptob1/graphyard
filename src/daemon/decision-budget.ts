// Concern: the decisions step's time budget — which items it reaches this cycle and which wait for the next (GY-1286), and the bound each decision call waits under (GY-1766), through the shared step bound (GY-1774).
import { canonicalJson } from '../onboarding.js';
import type { Work } from '../model.js';
import type { Cycle } from './cycle.js';
import { record, type DaemonEffects } from './effects.js';
import { boundedCalls, stepBudgetMs, stepCallBoundMs, stepCallCarried } from './step-budget.js';
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
export const decisionBudgetMs = (intervalMs: number) => stepBudgetMs(intervalMs);

/** The items the step left for the next cycle come first, in the order they were put off; the rest keep `order`. */
export function deferredFirst(order: Work[], deferred: readonly string[]) {
  if (!deferred.length) return order;
  const rank = new Map(deferred.map((key, index) => [key, index]));
  return [...order].sort((a, b) => (rank.get(a.key) ?? Number.POSITIVE_INFINITY) - (rank.get(b.key) ?? Number.POSITIVE_INFINITY));
}

/** What `decisionsDeferred` may hold, as its schema bounds it. */
export const maxDecisionsDeferred = 5000;

/**
 * The step's clock. Each of the step's passes (rework and routine decisions, then attestations)
 * asks `pass()` for its gate; `over()` says whether the pass must put the item it reached off. The
 * first item a pass reaches is never put off, whatever the clock says: both passes order the items
 * the last cycle put off first, so the oldest of them always gets its request, and a pass that starts
 * after the other spent the budget still moves (GY-1286 review: without this, attestations reached
 * only after a saturated rework pass were put off every cycle). An item put off is `defer`red: the
 * step still counts its decision as needed, so the watch cleanup withdraws nothing for it, but makes
 * no request for it this cycle. `settle()` records what was put off on the state.
 */
export function decisionBudget(state: Pick<DaemonState, 'decisionsDeferred'>, now: () => number, intervalMs: number) {
  const startedAt = now(), budgetMs = decisionBudgetMs(intervalMs), deferred = new Set<string>();
  const spent = () => now() - startedAt >= budgetMs;
  return {
    budgetMs,
    spent,
    pass: () => { let reached = false; return { over: () => { if (!reached) { reached = true; return false; } return spent(); } }; },
    defer: (item: Work) => { deferred.add(item.key); },
    settle: () => { state.decisionsDeferred = [...deferred].slice(0, maxDecisionsDeferred); return state.decisionsDeferred; },
  };
}

/** How long one owed decision's approver call may take before the step returns and carries it to the next cycle (GY-1766); the shared per-call bound (GY-1774). */
export const decisionCallBoundMs = 10_000;
/** GY-1766. A decision call that passed its bound — the per-decision bound, or the step budget left it is capped by: the decision stays owed, with its attempt recorded, and is retried next cycle. */
export const decisionCallCarried: typeof stepCallCarried = (...args) => stepCallCarried(...args);
/** The decide calls unanswered when their bound passed are keyed to the request they belong to — the item's binding-bearing identity (head, base, policy revision, epoch), the action and the input — so a retry joins its own call only: a changed head, criterion or action never joins an older call's answer nor has its own request suppressed. */
const decidingKey = (item: Work, rest: unknown[]) => canonicalJson([item.id, item.candidate?.sha ?? null, item.candidate?.baseSha ?? null, item.policyRevision, item.epoch, rest[0], rest[2] ?? null]);
/**
 * GY-1766: the step sees its `decide` through this. One call races its answer against the shorter of the per-decision
 * bound and the step budget `budgetLeft` still has, so several unanswered calls cannot stack the step past the cycle
 * bound; a call past its bound keeps running and its retry joins it (applied once). GY-1774: the shared step bound
 * (step-budget.ts) does the racing and the joining; this keeps the decision's key and wording.
 */
export function boundedDecisions(effects: DaemonEffects, kept: object, clockMs: () => number, budgetLeft: () => number | null): DaemonEffects {
  if (!effects.decide) return effects;
  return boundedCalls(effects, kept, clockMs, budgetLeft, { step: 'decisions', calls: ['decide'], boundMs: fx => (fx as { decisionCallBoundMs?: number }).decisionCallBoundMs ?? decisionCallBoundMs,
    key: (_call, args) => decidingKey(args[0] as Work, args.slice(1)), wording: (_call, args) => ({ what: `${(args[0] as Work).key}'s decision call`, owed: 'decision', per: 'decision' }) });
}

const reachedEvery = 'The decisions step reached every item within its budget';

/** Record what the step put off, so the journal and `master status` say the step was bounded rather than silent. */
export async function settleDeferred(cycle: Pick<Cycle, 'state' | 'effects' | 'now' | 'performed'>, budget: ReturnType<typeof decisionBudget>) {
  const { state, effects, now, performed } = cycle, deferred = budget.settle(), standing = state.actions['decisions:deferred'];
  // A cycle that reached every item supersedes the last deferral note once, so status shows no stale backlog.
  if (!deferred.length) {
    if (standing && !standing.detail.startsWith(reachedEvery)) performed.push(await record(state, 'decisions:deferred', { kind: 'decision', work: null, principal: null, state: 'done', attempts: standing.attempts + 1, cycle: state.cycle, detail: `${reachedEvery}; nothing waits for the next cycle` }, now(), effects.persist));
    return;
  }
  const named = deferred.length > 20 ? `${deferred.slice(0, 20).join(', ')} and ${deferred.length - 20} more` : deferred.join(', ');
  performed.push(await record(state, 'decisions:deferred', { kind: 'decision', work: null, principal: null, state: 'done', attempts: (standing?.attempts ?? 0) + 1, cycle: state.cycle,
    detail: `The decisions step spent its ${Math.round(budget.budgetMs / 1000)}s budget; ${deferred.length} item(s) wait for the next cycle, which reaches them first: ${named}` }, now(), effects.persist));
}
