// Concern: the bound every loop step's external call waits under (GY-1774): the step's two-fifths budget, the 10 s per-call bound, the carry of a call past it to the next cycle, and the join of a retry onto the call still in flight.
import { canonicalJson } from '../onboarding.js';
import type { Work } from '../model.js';
import type { Cycle } from './cycle.js';
import { record, type DaemonEffects } from './effects.js';
import { actionableIntervalMs } from './liveness.js';
import { type DaemonAction, type DaemonActionKind, type DaemonState, message } from './state.js';

/**
 * GY-1286: what a step may spend before it hands the rest of its work to the next cycle. Every
 * request a step makes is a control-plane or runtime write; while the server is slow those writes
 * run into their 30s timeout one after another, so on 2026-10-05 the decisions step spent 319s of
 * a 300s interval on them. Two fifths of the interval, never under the 30s actionable cadence,
 * leave the rest of the cycle its share. GY-1774: every step that calls an approver, a decision or a
 * session takes this same share.
 */
export const stepBudgetMs = (intervalMs: number) => Math.max(actionableIntervalMs, Math.round(intervalMs * 0.4));
/** How long one external call may take before the step returns and carries the call's work to the next cycle (GY-1766, GY-1774). */
export const stepCallBoundMs = 10_000;
/** The steps bounded this way, by the name their carried calls record (GY-1774); `decisions` keeps GY-1766's wording. */
export type BoundedStep = 'decisions' | 'approvers' | 'blockers' | 'dispatch' | 'review-cap' | 'scope' | 'sessions' | 'resume' | 'reclaim' | 'triage';

/**
 * A step's clock. `left()` is the budget still unspent, which caps every call's bound while the
 * step runs; once the step has returned (`end()`), it answers null, and a call made after it — a
 * launch the launcher runs beside the cycle, a triage run settling minutes later — holds no cycle,
 * so it passes through unbounded, exactly as it did before.
 */
export function stepBudget(now: () => number, intervalMs: number) {
  const startedAt = now(), budgetMs = stepBudgetMs(intervalMs);
  let ended = false;
  return { budgetMs, left: (): number | null => ended ? null : Math.max(0, budgetMs - (now() - startedAt)), end: () => { ended = true; } };
}

/** A call that passed its bound (GY-1766/GY-1774): the per-call bound, or the step budget left it is capped by. Its work stays owed, with the attempt recorded, and is retried next cycle. */
export const stepCallCarried = (detail: string | unknown) => / (?:ms per-(?:decision|call) bound|step'?s? budget) passed before .+ answered( \(.+\))?; the .+ stays owed and is retried next cycle/.test(typeof detail === 'string' ? detail : message(detail));
/** A cursor row that records a carried call: the row is no outcome, so what it gates is retried. */
export const carriedRow = (row: DaemonAction | undefined) => !!row && row.state === 'waiting' && stepCallCarried(row.detail);

/** How a carried call is named: what was waited on, the work that stays owed, and the unit the bound is stated per. */
export interface CallWording { what: string; owed: string; per: string }
export interface BoundOptions {
  step: BoundedStep;
  /** The effects the step sees through the bound; every other one passes through untouched. */
  calls: readonly (keyof DaemonEffects)[];
  /** The per-call bound; the effects' own `stepCallBoundMs` (a test's) wins over the default. */
  boundMs?: (effects: DaemonEffects) => number;
  /** The in-flight key of a call: the identity a retry must share to join it. */
  key?: (call: string, args: unknown[]) => string | null;
  wording?: (call: string, args: unknown[]) => CallWording | null;
}

/** The identity a retry's argument must share with the call in flight: an item's binding (head, base, policy revision, epoch), a session's pane, a ledger record's id. */
export function callIdentity(arg: unknown): unknown {
  if (!arg || typeof arg !== 'object') return arg ?? null;
  if (Array.isArray(arg)) return arg.map(callIdentity);
  const value = arg as Record<string, unknown>;
  if (typeof value.id === 'string' && typeof value.key === 'string' && 'epoch' in value) { const item = value as unknown as Work; return [item.id, item.candidate?.sha ?? null, item.candidate?.baseSha ?? null, item.policyRevision, item.epoch]; }
  if ('pane_id' in value || 'agent_status' in value) return { name: value.name ?? null, pane: value.pane_id ?? null };
  if (typeof value.record === 'string' && typeof value.agentName === 'string') return { record: value.record, agentName: value.agentName, request: value.requestId ?? null };
  return value;
}
/** The arguments that name a call's identity: free text — a reason, a prompt, a message — is left out, so a re-worded retry still joins its call. */
const identityArguments: Partial<Record<keyof DaemonEffects, number[]>> = { promptSession: [0], withdraw: [0, 1], widenScope: [0, 1, 2], withdrawReview: [0, 1], endRegistrySession: [0], endSession: [0], decide: [0, 1, 3] };
export const callKey = (call: string, args: unknown[]) => canonicalJson([call, ...(identityArguments[call as keyof DaemonEffects] ?? args.map((_, index) => index)).map(index => callIdentity(args[index]))]);
/** What a call is called in its carried record: the subject its first argument names, and the call. */
export function callWording(call: string, args: unknown[]): CallWording {
  const first = args[0] as Record<string, unknown> | string | undefined;
  const subject = typeof first === 'string' ? `${call === 'closeSession' ? 'pane' : call === 'endRegistrySession' ? 'registry session' : ''} ${first}`.trim()
    : first && typeof first === 'object' ? String(first.key ?? first.name ?? first.agentName ?? call) : null;
  return { what: subject ? `${subject}'s ${call} call` : `the ${call} call`, owed: 'call', per: 'call' };
}

/** The calls unanswered when their bound passed, per kept state, keyed to the request they belong to, so a retry joins its own call only: a changed head, action or input never joins an older call's answer nor has its own request suppressed. */
const inFlight = new WeakMap<object, Map<string, Promise<unknown>>>();
/** The effects beneath a bound, for a launch the launcher runs beside the cycle: it holds no cycle, so it waits as long as the launch takes. */
const beneath = new WeakMap<object, DaemonEffects>();
export const unboundedEffects = (effects: DaemonEffects): DaemonEffects => { let base = effects; while (beneath.has(base)) base = beneath.get(base)!; return base; };

/**
 * GY-1774: the step sees its effects through this. Each call named in `calls` races its answer
 * against the shorter of the per-call bound and the step budget `budgetLeft` still has, so several
 * unanswered calls cannot stack the step past the cycle bound; a call past its bound keeps running
 * and its retry joins it (applied once). The wait is polled on the loop's clock, which moves
 * without timers on a simulated day, and on the wall under it, which moves under a fixed test clock.
 */
export function boundedCalls(effects: DaemonEffects, kept: object, clockMs: () => number, budgetLeft: () => number | null, options: BoundOptions): DaemonEffects {
  const pending = inFlight.get(kept) ?? inFlight.set(kept, new Map()).get(kept)!;
  const bounded = new Set<PropertyKey>(options.calls);
  const proxy: DaemonEffects = new Proxy(effects, { get: (target, property, receiver) => {
    const fn = Reflect.get(target, property, receiver);
    if (!bounded.has(property) || typeof fn !== 'function') return fn;
    const call = String(property);
    return (...args: unknown[]) => {
      const left = budgetLeft();
      if (left === null) return fn.call(target, ...args);
      const startedAt = clockMs(), wall = Date.now(), boundMs = options.boundMs?.(effects) ?? (effects as { stepCallBoundMs?: number }).stepCallBoundMs ?? stepCallBoundMs, capped = Math.max(0, Math.min(boundMs, left)), budgeted = capped < boundMs;
      const key = options.key?.(call, args) ?? callKey(call, args);
      let made = pending.get(key);
      if (!made) {
        let result: Promise<unknown>;
        try { result = Promise.resolve(fn.call(target, ...args)); } catch (error) { result = Promise.reject(error); }
        const own = made = result, done = () => { if (pending.get(key) === own) pending.delete(key); };
        own.then(done, done);
        pending.set(key, own);
      }
      const { what, owed, per } = options.wording?.(call, args) ?? callWording(call, args);
      let timer: ReturnType<typeof setTimeout> | undefined, stopped = false;
      const expired = new Promise<never>((_, reject) => {
        const tick = () => {
          if (stopped) return;
          const past = Math.max(clockMs() - startedAt, Date.now() - wall);
          if (past >= capped) return void reject(new Error(budgeted ? `the ${options.step} step's budget passed before ${what} answered (${boundMs} ms per ${per}, ${capped} ms left); the ${owed} stays owed and is retried next cycle` : `the ${options.step} step's ${boundMs} ms per-${per} bound passed before ${what} answered; the ${owed} stays owed and is retried next cycle`));
          timer = setTimeout(tick, Math.min(capped - past, 25)); timer.unref?.();
        };
        timer = setTimeout(tick, Math.min(capped, 25)); timer.unref?.();
      });
      return Promise.race([made, expired]).finally(() => { stopped = true; clearTimeout(timer); });
    };
  } });
  beneath.set(proxy, effects);
  return proxy;
}

/**
 * Record a carried call on its row as `waiting` — the outcome is still in flight, so the row gates
 * nothing and the work is asked again next cycle (readyToRetry) — with its attempt counted and no
 * fault. A `started` row the call left is replaced, so no restart reconciles it as interrupted.
 */
export async function recordCarried(cycle: Pick<Cycle, 'state' | 'now' | 'performed' | 'effects'>, key: string, row: { kind: DaemonActionKind; work: string | null; principal?: string | null; epoch?: number | null }, error: unknown, what: string) {
  const { state, now, performed, effects } = cycle, previous = state.actions[key];
  // A `started` row already counted this attempt; a row of any other state counts it here.
  const attempts = previous?.state === 'started' ? previous.attempts : (previous?.attempts ?? 0) + 1;
  performed.push(await record(state, key, { kind: row.kind, work: row.work, principal: row.principal ?? null, epoch: row.epoch ?? null, state: 'waiting', detail: `${what} was carried to the next cycle: ${message(error)}`.slice(0, 2000), attempts, cycle: state.cycle }, now(), effects.persist, null));
}

/**
 * The step's isolation, carried-aware: a carried call that reaches it is recorded `waiting` on the
 * item's row, no fault, and the cycle goes on; anything else is the step's own failure as before.
 */
export const carriedIsolate = (cycle: Cycle, step: BoundedStep): Cycle['isolate'] => (kind, item, name, body) => cycle.isolate(kind, item, name, async () => {
  try { return await body(); }
  catch (error) {
    if (!stepCallCarried(error)) throw error;
    await recordCarried(cycle, `carried:${kind}:${item?.id ?? name}`, { kind, work: item?.key ?? null, epoch: item?.epoch ?? null }, error, `Handling ${name} in the ${step} step`);
    return undefined;
  }
});

/**
 * Run a step under its budget (GY-1774): the step's calls named in `calls` are bounded by the lesser
 * of the per-call bound and the budget left, a carried one reaching the step's isolation is recorded
 * `waiting` and retried next cycle, and once the step returns the budget ends, so a launch it handed
 * to the launcher passes through unbounded.
 */
export async function withinStepBudget<T>(cycle: Cycle, step: BoundedStep, calls: readonly (keyof DaemonEffects)[], body: (bounded: Cycle) => Promise<T>): Promise<T> {
  const budget = stepBudget(cycle.now, (cycle.config.run.intervalSeconds ?? 20) * 1000);
  // Nested steps (the resume step runs inside the sessions step) bound the effects beneath every earlier bound, never a bound's own race.
  const effects = boundedCalls(unboundedEffects(cycle.effects), cycle.state as DaemonState, cycle.now, budget.left, { step, calls });
  const bounded: Cycle = { ...cycle, effects, isolate: carriedIsolate({ ...cycle, effects }, step) };
  try { return await body(bounded); } finally { budget.end(); }
}
