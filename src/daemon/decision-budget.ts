// Concern: the decisions step's time budget — which items it reaches this cycle and which wait for the next (GY-1286), and the bound each decision call waits under (GY-1766).
import { canonicalJson } from '../onboarding.js';
import type { Work } from '../model.js';
import type { Cycle } from './cycle.js';
import { record, type DaemonEffects } from './effects.js';
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

/** How long one owed decision's approver call may take before the step returns and carries it to the next cycle (GY-1766). */
export const decisionCallBoundMs = 10_000;
/** GY-1766. A decision call that passed its bound — the per-decision bound, or the step budget left it is capped by: the decision stays owed, with its attempt recorded, and is retried next cycle. */
export const decisionCallCarried = (detail: string) => / (?:ms per-decision bound|step'?s? budget) passed before .+ answered( \(.+\))?; the decision stays owed and is retried next cycle/.test(detail);
/** The decide calls unanswered when their bound passed, per kept state, keyed to the request they belong to — the item's binding-bearing identity (head, base, policy revision, epoch), the action and the input — so a retry joins its own call only: a changed head, criterion or action never joins an older call's answer nor has its own request suppressed. */
const deciding = new WeakMap<object, Map<string, Promise<unknown>>>();
const decidingKey = (item: Work, rest: unknown[]) => canonicalJson([item.id, item.candidate?.sha ?? null, item.candidate?.baseSha ?? null, item.policyRevision, item.epoch, rest[0], rest[2] ?? null]);
/**
 * GY-1766: the step sees its `decide` through this. One call races its answer against the shorter of the per-decision
 * bound and the step budget `budgetLeft` still has, so several unanswered calls cannot stack the step past the cycle
 * bound; a call past its bound keeps running and its retry joins it (applied once). The wait is polled on the loop's
 * clock, which moves without timers on a simulated day, and on the wall under it, which moves under a fixed test clock.
 */
export function boundedDecisions(effects: DaemonEffects, kept: object, clockMs: () => number, budgetLeft: () => number): DaemonEffects {
  const decide = effects.decide;
  if (!decide) return effects;
  const pending = deciding.get(kept) ?? deciding.set(kept, new Map()).get(kept)!;
  return new Proxy(effects, { get: (target, property, receiver) => property !== 'decide' ? Reflect.get(target, property, receiver) : (item: Work, ...rest: Parameters<typeof decide> extends [Work, ...infer R] ? R : never) => {
    const startedAt = clockMs(), wall = Date.now(), boundMs = (effects as { decisionCallBoundMs?: number }).decisionCallBoundMs ?? decisionCallBoundMs, left = Math.max(0, Math.min(boundMs, budgetLeft())), budgeted = left < boundMs, key = decidingKey(item, rest);
    let call = pending.get(key) as ReturnType<typeof decide> | undefined;
    if (!call) {
      const made = call = decide.call(target, item, ...rest), done = () => { if (pending.get(key) === made) pending.delete(key); };
      made.then(done, done);
      pending.set(key, made);
    }
    let timer: ReturnType<typeof setTimeout> | undefined, stopped = false;
    const expired = new Promise<never>((_, reject) => {
      const tick = () => {
        if (stopped) return;
        const past = Math.max(clockMs() - startedAt, Date.now() - wall);
        if (past >= left) return void reject(new Error(budgeted ? `the decisions step's budget passed before ${item.key}'s decision call answered (${boundMs} ms per decision, ${left} ms left); the decision stays owed and is retried next cycle` : `the decisions step's ${boundMs} ms per-decision bound passed before ${item.key}'s decision call answered; the decision stays owed and is retried next cycle`));
        timer = setTimeout(tick, Math.min(left - past, 25)); timer.unref?.();
      };
      timer = setTimeout(tick, Math.min(left, 25)); timer.unref?.();
    });
    return Promise.race([call, expired]).finally(() => { stopped = true; clearTimeout(timer); });
  } });
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
