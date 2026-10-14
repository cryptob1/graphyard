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
 * session takes this same share, and every external call the step makes — to the control plane, the
 * runtime, the host — waits under it.
 */
export const stepBudgetMs = (intervalMs: number) => Math.max(actionableIntervalMs, Math.round(intervalMs * 0.4));
/** How long one external call may take before the step returns and carries the call's work to the next cycle (GY-1766, GY-1774). */
export const stepCallBoundMs = 10_000;
/** The steps bounded this way, by the name their carried calls record (GY-1774); `decisions` keeps GY-1766's wording. */
export type BoundedStep = 'decisions' | 'approvers' | 'blockers' | 'dispatch' | 'review-cap' | 'scope' | 'sessions' | 'resume' | 'reclaim' | 'triage' | 'master';

/**
 * A step's clock. `left()` is the budget still unspent, which caps every call's bound while the
 * step runs; once the step has returned (`end()`), it answers null, and a call made after it — a
 * launch the launcher runs beside the cycle, a triage run settling minutes later — holds no cycle,
 * so it passes through unbounded, exactly as it did before.
 */
export function stepBudget(now: () => number, intervalMs: number, outerLeft: () => number = () => Number.POSITIVE_INFINITY) {
  const startedAt = now(), wallStartedAt = Date.now(), budgetMs = stepBudgetMs(intervalMs);
  let ended = false;
  // A step nested in another's budget never outlives what that one has left. The spent share is the larger of the loop's clock and the wall, so a fixed or simulated clock never lets a step go on past its budget on the wall.
  return { budgetMs, left: (): number | null => ended ? null : Math.max(0, Math.min(outerLeft(), budgetMs - Math.max(now() - startedAt, Date.now() - wallStartedAt))), end: () => { ended = true; } };
}

/** A call that passed its bound (GY-1766/GY-1774): the per-call bound, or the step budget left it is capped by, or a budget already spent before the call could be made. Its work stays owed, with the attempt recorded, and is retried next cycle. */
export const stepCallCarried = (detail: string | unknown) => / (?:ms per-(?:decision|call) bound|step'?s? budget) passed before .+ (?:answered|was made)( \(.+\))?; the .+ stays owed and is retried next cycle/.test(typeof detail === 'string' ? detail : message(detail));
/** A cursor row that records a carried call: the row is no outcome, so what it gates is retried. */
export const carriedRow = (row: DaemonAction | undefined) => !!row && row.state === 'waiting' && stepCallCarried(row.detail);
/** The rejection of a carried call; `sent` says whether this call made the request (one attempt) or joined, or waited for, one already in flight (no new attempt). */
export class StepCallCarriedError extends Error { constructor(detail: string, readonly sent: boolean) { super(detail); this.name = 'StepCallCarriedError'; } }
/** The flight a carried call's rejection names, when the call was made or joined: the row that records the call carried owes the flight's answer to its retry (`recordCarried`). A budget-spent rejection names none. */
const flightOf = new WeakMap<StepCallCarriedError, Flight>();
/** Whether a carried call was its cycle's own send: a join of the call still in flight is no new attempt, so the attempts a row counts stay the sends actually made. */
export const carriedCallSent = (error: unknown) => !(error instanceof StepCallCarriedError) || error.sent;
/**
 * How long the answer of a carried call is kept for the retry that consumes it. The answer is owed to
 * the carried row that records the call (`recordCarried`): while that row stands `waiting`, the retry
 * has not come — earlier calls of the same handling carried again, or a spent step budget, may defer
 * it for any number of cycles — and the answer is kept for it, however many cycles begin meanwhile,
 * so the effect is never started twice. The row retired (`retireCarried`: its handling ran through,
 * consuming the answer or proving it moot) owes it no more. An answer no row owes (its row retired, or
 * a call whose carry its caller let go) is kept by cycles, never by the clock, whatever the run
 * interval (up to its 900 s): until `settledKeepCycles` cycles have begun since it settled, which is
 * the retry's cycle and one more, after which the next call under its key is a fresh send.
 * `settledKeepMs` on the wall bounds an answer no row owes, and is the whole keep of a state that
 * counts no cycles (a bound run on its own); it never drops an owed one, whose row may stand for
 * days behind earlier calls or spent budgets before its retry comes, since the retry would then send
 * the effect a second time.
 */
export const settledKeepCycles = 3, settledKeepMs = 24 * 3_600_000;

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
  /** The decisions step's pass reaches its first item whatever the clock says (GY-1286), so its call is made on a spent budget and carried at once, as it always was; every other step makes none. */
  sendWhenSpent?: boolean;
}

/** The identity a retry's argument must share with the call in flight: an item's binding (head, base, policy revision, epoch), a session's pane, a ledger record's id, a fence's supervisor, an escalation handler's launch. */
export function callIdentity(arg: unknown): unknown {
  if (!arg || typeof arg !== 'object') return arg ?? null;
  if (Array.isArray(arg)) return arg.map(callIdentity);
  const value = arg as Record<string, unknown>;
  if (typeof value.id === 'string' && typeof value.key === 'string' && 'epoch' in value) { const item = value as unknown as Work; return [item.id, item.candidate?.sha ?? null, item.candidate?.baseSha ?? null, item.policyRevision, item.epoch]; }
  if ('pane_id' in value || 'agent_status' in value) return { name: value.name ?? null, pane: value.pane_id ?? null };
  if (typeof value.record === 'string' && typeof value.agentName === 'string') return { record: value.record, agentName: value.agentName, request: value.requestId ?? null };
  // A scope ask: the attempt that asked and when, so a withdrawn and re-asked request never joins the earlier ask's call.
  if (typeof value.requestedBy === 'string' && typeof value.at === 'string' && Array.isArray(value.paths)) return { epoch: value.epoch ?? null, at: value.at };
  // An escalation handler's launch, named by what it handles and when it launched; its idle mark and wait change between cycles.
  if (typeof value.trigger === 'string' && typeof value.launchedAt === 'string' && 'work' in value) return { work: value.work, trigger: value.trigger, launchedAt: value.launchedAt };
  // A fenced attempt's supervisor: the attempt and the process, never the lease expiry the cycle read.
  if (value.scope && typeof value.scope === 'object' && 'owner' in value && 'epoch' in value) return { id: value.id ?? value.key ?? null, epoch: value.epoch, owner: value.owner, pid: (value.scope as { pid?: unknown }).pid ?? null };
  // A blocker probe's record: the probe and its outcome, never the next-probe instant the cycle stamps.
  if (typeof value.probe === 'string' && typeof value.result === 'string' && 'nextAt' in value) { const { nextAt: _nextAt, ...probe } = value; return probe; }
  return value;
}
/** The arguments that name a call's identity: free text — a reason, a prompt, a message, an outcome — is left out, so a re-worded retry still joins its call; a call that takes none, or only this cycle's reading of the world (an inventory, a snapshot), is one call however the reading moved. */
const identityArguments: Partial<Record<keyof DaemonEffects, number[]>> = {
  promptSession: [0], withdraw: [0, 1], widenScope: [0, 1, 2], withdrawReview: [0, 1], endRegistrySession: [0], endSession: [0], decide: [0, 1, 3], replan: [0, 1], withdrawTriage: [0, 1],
  blockDispatch: [0], holdAccount: [0], endEscalation: [0], markEscalation: [0], relaunchEscalation: [0], stopSupervisor: [0, 1], recordSession: [], reportCapacity: [0], settleContainment: [0], containment: [0],
  reclaim: [], reclaimResources: [], panes: [], herdr: [], roleHealth: [], escalationSessions: [], launchedSessions: [], approverLaunches: [], planeHealth: [], hostMemory: [], repositoryFiles: [], reconcileSessions: [],
};
/**
 * The intent of a prompt's text: the instruction it gives, with what the clock moves between one cycle's wording
 * and the next's (a timestamp, a count of minutes) blanked. A retry of the same instruction joins its call, or
 * consumes its answer; a different instruction to the same pane — the continuation after a declined prompt, then
 * the resume or idle re-prompt, or a wake naming other subjects — is its own call and is never left unsent.
 */
export const promptIntent = (text: unknown) => String(text).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, 'T').replace(/\b\d+ (?:more )?minutes?\b/g, 'N minutes');
/** What a call's key carries beside its arguments: a prompt is keyed by its intent, a scope decision by the ask it decides (the item's `scopeRequest`), a session record by the handle and state it writes, a capacity report by the event it reports, a settlement by the fence's epoch. */
const keyedBeside = (call: string, args: unknown[]): unknown[] => {
  const second = args[1] as Record<string, unknown> | undefined;
  if (call === 'promptSession') return [promptIntent(args[1])];
  if (call === 'decideScope') return [callIdentity((args[0] as Work | undefined)?.scopeRequest ?? null)];
  // A handle record is keyed by the item's id, never its revision or head: the item advancing between the running and the finished record must not part them.
  if (call === 'recordSession') return [(args[0] as Work | undefined)?.id ?? null, second?.id ?? null, second?.state ?? null];
  if (call === 'reportCapacity') return [second?.event ?? null, second?.role ?? null, second?.epoch ?? null, second?.requestId ?? null, second?.cause ?? null];
  if (call === 'settleContainment') return [second?.epoch ?? null];
  // A hold is keyed by the exhaustion it records (never when it was seen), a mark by the state it writes, an end by the resolution it gives: a different one never joins, nor consumes the answer of, another.
  if (call === 'holdAccount') return [second ? [second.reason, second.role, second.profile, second.work, second.resetsAt, second.identity, second.home, second.kind, second.reported].map(value => value ?? null) : null];
  if (call === 'markEscalation') return [!!(args[0] as { idleSince?: unknown } | undefined)?.idleSince];
  if (call === 'endEscalation') return [second ?? null, args[2] ? 'waiting' : null];
  return [];
};
export const callKey = (call: string, args: unknown[]) => canonicalJson([call, ...(identityArguments[call as keyof DaemonEffects] ?? args.map((_, index) => index)).map(index => callIdentity(args[index])), ...keyedBeside(call, args)]);
/** What a call is called in its carried record: the subject its first argument names, and the call. */
export function callWording(call: string, args: unknown[]): CallWording {
  const first = args[0] as Record<string, unknown> | string | undefined;
  const subject = typeof first === 'string' ? `${call === 'closeSession' ? 'pane' : call === 'endRegistrySession' ? 'registry session' : call === 'holdAccount' ? 'account' : ''} ${first}`.trim()
    : first && typeof first === 'object' && !Array.isArray(first) && (first.key ?? first.name ?? first.agentName) != null ? String(first.key ?? first.name ?? first.agentName) : null;
  return { what: subject ? `${subject}'s ${call} call` : `the ${call} call`, owed: 'call', per: 'call' };
}

/** A call carried past its bound: the request still in flight, or — once it settled — its answer, kept until the owed retry consumes it, so the effect is never started twice; `owedBy` names the carried rows that owe it to their retry. */
interface Flight { promise: Promise<unknown>; settledAt: { cycle: number; wall: number } | null; owedBy: Set<string> }
/** The calls unanswered when their bound passed, per kept state, keyed to the request they belong to, so a retry joins its own call only: a changed head, action or input never joins an older call's answer nor has its own request suppressed. */
const inFlight = new WeakMap<object, Map<string, Flight>>();
/** The effects beneath a bound, for a launch the launcher runs beside the cycle: it holds no cycle, so it waits as long as the launch takes. */
const beneath = new WeakMap<object, DaemonEffects>();
export const unboundedEffects = (effects: DaemonEffects): DaemonEffects => { let base = effects; while (beneath.has(base)) base = beneath.get(base)!; return base; };
/** The cycle a kept state counts, which dates a kept answer; a state counting none dates it 0, and the wall keep alone drops it. */
const cycleOf = (kept: object) => typeof (kept as { cycle?: unknown }).cycle === 'number' ? (kept as { cycle: number }).cycle : 0;
/** The cursor rows a kept state holds; a state holding none (a bound run on its own) owes no answer by a row. */
const rowsOf = (kept: object): Record<string, DaemonAction | undefined> => (kept as { actions?: Record<string, DaemonAction | undefined> }).actions ?? {};
/** Whether a settled flight is still owed its retry: a carried row that recorded it still stands `waiting`, so the handling it belongs to has not run through since and the retry is still to come. */
const stillOwed = (kept: object, flight: Flight) => { const rows = rowsOf(kept); for (const rowKey of flight.owedBy) if (carriedRow(rows[rowKey])) return true; return false; };
/**
 * Mark a carried call's flight owed to the row that records it: its answer is kept for the row's retry
 * however many cycles begin before that retry comes. A rejection naming no flight (a spent budget made
 * no call, a phase, an error rebuilt from its message) owes nothing.
 */
export function oweCarried(rowKey: string, error: unknown) {
  const flight = error instanceof StepCallCarriedError ? flightOf.get(error) : undefined;
  if (flight) flight.owedBy.add(rowKey);
}
/**
 * Release the answers a retired row owed: the row no longer owes them, so an answer no other row owes
 * is kept by the cycle keep alone, as one nobody carried, and lapses after it. It is not dropped here:
 * a row is shared by every isolation of its item in its step (the blockers step runs three), so one
 * isolation running through retires the row another's carried call still owes; that call, retried in
 * the same cycle, finds its flight and owes it to the row again.
 */
function releaseOwed(kept: object, rowKey: string) {
  for (const flight of inFlight.get(kept)?.values() ?? []) flight.owedBy.delete(rowKey);
}
/** A plain object of calls (an effect object, or a port object nested in one): never an array, a promise, a map or another instance, whose members are its own. */
const plainObject = (value: unknown): value is object => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
/**
 * An effect object's calls seen through `through`, named by their path (`acceptance.goals`), method by method
 * and nested object by nested object: the acceptance role's merge-writer ports (`acceptance.writer.merged`,
 * `.fetch`, `.merge`, `.push`) are reached the same way as its own calls, so no call beneath the object escapes
 * the bound or the gate it is seen through. A member that is neither a call nor a plain object passes through.
 */
function throughMethods<T extends object>(object: T, path: string, through: (name: string, owner: object, member: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown): T {
  return new Proxy(object, { get: (inner, method) => {
    const member: unknown = Reflect.get(inner, method), name = `${path}.${String(method)}`;
    if (typeof member === 'function') return through(name, inner, member as (...args: unknown[]) => unknown);
    return plainObject(member) ? throughMethods(member, name, through) : member;
  } });
}

/**
 * GY-1774: the step sees its effects through this. Each call named in `calls` races its answer
 * against the shorter of the per-call bound and the step budget `budgetLeft` still has, so several
 * unanswered calls cannot stack the step past the cycle bound; a call past its bound keeps running
 * and its retry joins it, or — once it has settled — consumes its kept answer, so the effect is
 * applied once and never started twice; a fresh call is never made once the budget is spent, so
 * nothing runs behind a step that has returned. The wait is polled on the loop's clock, which
 * moves without timers on a simulated day, and on the wall under it, which moves under a fixed test clock.
 */
export function boundedCalls(effects: DaemonEffects, kept: object, clockMs: () => number, budgetLeft: () => number | null, options: BoundOptions): DaemonEffects {
  const pending = inFlight.get(kept) ?? inFlight.set(kept, new Map()).get(kept)!;
  const bounded = new Set<PropertyKey>(options.calls);
  const wrap = (call: string, target: object, fn: (...args: unknown[]) => unknown) => {
    return (...args: unknown[]) => {
      const left = budgetLeft();
      if (left === null) return fn.call(target, ...args);
      const startedAt = clockMs(), wall = Date.now(), boundMs = options.boundMs?.(effects) ?? (effects as { stepCallBoundMs?: number }).stepCallBoundMs ?? stepCallBoundMs, capped = Math.max(0, Math.min(boundMs, left)), budgeted = capped < boundMs;
      const key = options.key?.(call, args) ?? callKey(call, args);
      // An answer still owed to a carried row that stands is kept for its retry, however many cycles have begun and however long the wall has run: a retry deferred by earlier calls or a spent budget consumes it and never starts the effect again. One no row owes, unconsumed within the cycle keep or the wall keep, is dropped, this call's own key included: the work it served has moved on, so a later call under the key is a fresh send and never takes the stale answer for its effect.
      const stale = (flight: Flight) => !!flight.settledAt && !stillOwed(kept, flight) && (wall - flight.settledAt.wall >= settledKeepMs || cycleOf(kept) - flight.settledAt.cycle >= settledKeepCycles);
      for (const [other, flight] of pending) if (stale(flight)) pending.delete(other);
      const joined = pending.get(key);
      // The retry of a carried call that settled within the keep consumes its answer: applied once, never sent again.
      if (joined?.settledAt) { pending.delete(key); return joined.promise; }
      const { what, owed, per } = options.wording?.(call, args) ?? callWording(call, args);
      // A budget already spent makes no new call: the work stays owed to the next cycle, which makes it on a fresh budget.
      if (!joined && capped <= 0 && !options.sendWhenSpent) return Promise.reject(new StepCallCarriedError(`the ${options.step} step's budget passed before ${what} was made (${boundMs} ms per ${per}, 0 ms left); the ${owed} stays owed and is retried next cycle`, false));
      const sent = !joined;
      let flight = joined;
      if (!flight) {
        // A call that throws before it is made (a programming error, not a slow answer) throws to its caller as it always did: it is no flight.
        // A finished handle record follows the running one still unanswered (GY-1774): it is sent once that settles, so a delayed running write can never land after the finished one and reopen the handle.
        const second = args[1] as Record<string, unknown> | undefined, prior = call === 'recordSession' && second?.state === 'finished' ? pending.get(options.key?.(call, [args[0], { ...second, state: 'running' }]) ?? callKey(call, [args[0], { ...second, state: 'running' }])) : undefined;
        const result = Promise.resolve(prior && !prior.settledAt ? prior.promise.then(() => undefined, () => undefined).then(() => fn.call(target, ...args)) : fn.call(target, ...args));
        const own: Flight = { promise: result, settledAt: null, owedBy: new Set() }, done = () => { own.settledAt = { cycle: cycleOf(kept), wall: Date.now() }; };
        result.then(done, done);
        pending.set(key, own);
        flight = own;
      }
      let timer: ReturnType<typeof setTimeout> | undefined, stopped = false, carried = false;
      const expired = new Promise<never>((_, reject) => {
        const tick = () => {
          if (stopped) return;
          const past = Math.max(clockMs() - startedAt, Date.now() - wall);
          if (past >= capped) {
            carried = true;
            const error = new StepCallCarriedError(`${budgeted ? `the ${options.step} step's budget passed before ${what} answered (${boundMs} ms per ${per}, ${capped} ms left)` : `the ${options.step} step's ${boundMs} ms per-${per} bound passed before ${what} answered`}; the ${owed} stays owed and is retried next cycle${sent ? '' : ', joining the call still in flight'}`, sent);
            flightOf.set(error, flight!);
            return void reject(error);
          }
          timer = setTimeout(tick, Math.min(capped - past, 25)); timer.unref?.();
        };
        timer = setTimeout(tick, Math.min(capped, 25)); timer.unref?.();
      });
      // An answer within the bound is this call's own, applied now: nothing is kept for a retry.
      return Promise.race([flight.promise, expired]).finally(() => { stopped = true; clearTimeout(timer); if (!carried && pending.get(key) === flight) pending.delete(key); });
    };
  };
  // An effect object named in `calls` (the merge writer's reads, the acceptance role, the planner) is bounded method by method as `object.method`, its nested ports (`acceptance.writer.merged`) included, so every external call beneath it waits under the same bound.
  const proxy: DaemonEffects = new Proxy(effects, { get: (target, property, receiver) => {
    const fn = Reflect.get(target, property, receiver);
    if (!bounded.has(property)) return fn;
    if (typeof fn === 'function') return wrap(String(property), target, fn);
    if (!fn || typeof fn !== 'object') return fn;
    return throughMethods(fn, String(property), wrap);
  } });
  beneath.set(proxy, effects);
  return proxy;
}

/** What a carried record needs of the cycle: its cursor, clock, journal and the persist beneath its effects. */
type CarriedCycle = Pick<Cycle, 'state' | 'now' | 'performed' | 'effects'>;
/** A carried row's identity: what the row is about. */
interface CarriedRow { kind: DaemonActionKind; work: string | null; principal?: string | null; epoch?: number | null }

/**
 * Record a carried call on its row as `waiting` — the outcome is still in flight, so the row gates
 * nothing and the work is asked again next cycle (readyToRetry) — with its attempt counted and no
 * fault. A `started` row the call left is replaced, so no restart reconciles it as interrupted.
 * The attempts a row counts are the sends actually made: a retry that joined the call still in
 * flight, or that found the budget spent, made none, so a cap on failed attempts never counts polls.
 */
export async function recordCarried(cycle: CarriedCycle, key: string, row: CarriedRow, error: unknown, what: string) {
  const { state, now, performed, effects } = cycle, previous = state.actions[key];
  oweCarried(key, error); // the row owes the call's answer to its retry, kept until that retry consumes it
  // A `started` row already counted this attempt, and a call never sent (a join, or a spent budget) takes that count off again; a row of any other state counts it here, unless nothing was sent.
  const attempts = previous?.state === 'started' ? Math.max(0, previous.attempts - (carriedCallSent(error) ? 0 : 1)) : !previous ? (carriedCallSent(error) ? 1 : 0) : carriedCallSent(error) ? previous.attempts + 1 : previous.attempts;
  performed.push(await record(state, key, { kind: row.kind, work: row.work, principal: row.principal ?? null, epoch: row.epoch ?? null, state: 'waiting', detail: `${what} was carried to the next cycle: ${message(error)}`.slice(0, 2000), attempts, cycle: state.cycle }, now(), effects.persist, null));
}
/** Retire a carried row once its call answered, or its handling ran through without it: the row is done, with the carried attempts it counted, so nothing stays carried past the answer, and an answer the row still owed is released to the cycle keep. */
export async function retireCarried(cycle: CarriedCycle, key: string, previous: DaemonAction, detail: string) {
  const { state, now, performed, effects } = cycle;
  if (state.actions[key] !== previous) return; // recorded anew meanwhile: carried again, or settled by the caller's own row
  performed.push(await record(state, key, { kind: previous.kind, work: previous.work, principal: previous.principal, epoch: previous.epoch, state: 'done', detail: detail.slice(0, 2000), attempts: previous.attempts, cycle: state.cycle }, now(), effects.persist, null));
  releaseOwed(state, key);
}

/**
 * The step's isolation, carried-aware: a carried call that reaches it is recorded `waiting` on the
 * item's row, no fault, and the cycle goes on; the next cycle's handling retries the call, joining it
 * or consuming its answer, and running through retires the row. Anything else is the step's own failure as before.
 */
export const carriedIsolate = (cycle: Cycle, step: BoundedStep): Cycle['isolate'] => (kind, item, name, body) => cycle.isolate(kind, item, name, async () => {
  const key = `carried:${kind}:${item?.id ?? name}`, previous = cycle.state.actions[key];
  try {
    const result = await body();
    if (carriedRow(previous)) await retireCarried(cycle, key, previous, `Handling ${name} in the ${step} step, carried on cycle ${previous.cycle}, was retried and ran through`);
    return result;
  } catch (error) {
    if (!stepCallCarried(error)) throw error;
    await recordCarried(cycle, key, { kind, work: item?.key ?? null, epoch: item?.epoch ?? null }, error, `Handling ${name} in the ${step} step`);
    return undefined;
  }
});

/**
 * A step-level call outside any item's isolation — an inventory or health reading, the host's reclaim,
 * a fence assessment: carried, it is recorded `waiting` on the step's row for the call and answered
 * with `fallback`, so the step goes on with what it has; the next cycle makes the call again, joining
 * it or consuming its answer, and the answer retires the row. Any other rejection is the caller's as before.
 */
export async function carriedCall<T>(cycle: CarriedCycle, step: BoundedStep, kind: DaemonActionKind, call: keyof DaemonEffects, make: () => Promise<T> | T, fallback: (error: unknown) => T): Promise<T> {
  const key = `carried:${step}:${call}`, previous = cycle.state.actions[key];
  try {
    const result = await make();
    if (carriedRow(previous)) await retireCarried(cycle, key, previous, `The ${step} step's ${call} call, carried on cycle ${previous.cycle}, answered on its retry`);
    return result;
  } catch (error) {
    if (!stepCallCarried(error)) throw error;
    await recordCarried(cycle, key, { kind, work: null }, error, `The ${step} step's ${call} call`);
    return fallback(error);
  }
}

/** A best-effort write carried past its bound, owed to the next start of a step that bounds its call: the write to retry, through that step's bound, and the row that records it. */
interface OwedWrite { call: keyof DaemonEffects; row: CarriedRow; what: string; write: (effects: DaemonEffects) => Promise<unknown> | unknown }
const owedWrites = new WeakMap<object, Map<string, OwedWrite>>();
const owedPrefix = 'owed:';
/**
 * A best-effort write that follows an action already done — the session handle a re-prompt or close
 * records, an escalation handler's idle mark — is never re-sent with its action: refused, it is let
 * go as before; carried, it is owed, recorded `waiting` under `owed:KEY`, and the next start of a
 * step that bounds the call writes it again (`retryOwedWrites`), joining the write still in flight
 * or consuming its answer, which retires the row. The write takes the effects of the step retrying
 * it, so it waits under that step's bound, never the ended one's.
 */
export async function owedWrite(cycle: CarriedCycle, key: string, row: CarriedRow, what: string, call: keyof DaemonEffects, write: OwedWrite['write']): Promise<void> {
  const { state } = cycle, rowKey = `${owedPrefix}${key}`, previous = state.actions[rowKey], owed = owedWrites.get(state) ?? owedWrites.set(state, new Map()).get(state)!;
  // A write that throws before it is made is the caller's own failure, as it always was; only its answer is best effort.
  const pending = write(cycle.effects);
  try { await pending; }
  catch (error) {
    if (stepCallCarried(error)) { owed.set(rowKey, { call, row, what, write }); await recordCarried(cycle, rowKey, row, error, what); return; }
    owed.delete(rowKey);
    if (carriedRow(previous)) await retireCarried(cycle, rowKey, previous, `${what}, carried on cycle ${previous.cycle}, was refused on its retry and is let go, as a refused record always was: ${message(error)}`);
    return;
  }
  owed.delete(rowKey);
  if (carriedRow(previous)) await retireCarried(cycle, rowKey, previous, `${what}, carried on cycle ${previous.cycle}, answered on its retry`);
}
/** A newer write of the same subject makes an owed older one moot (a running handle record once the handle is finished): it is let go unsent and its row retired, so a late retry never lands after the newer write and reopens what it ended. */
export async function supersedeOwed(cycle: CarriedCycle, key: string, why: string) {
  const rowKey = `${owedPrefix}${key}`, previous = cycle.state.actions[rowKey];
  owedWrites.get(cycle.state)?.delete(rowKey);
  if (carriedRow(previous)) await retireCarried(cycle, rowKey, previous, `${previous.detail.replace(/ was carried to the next cycle: .*$/, '')} was superseded by ${why} and is not sent`);
}
/** The owed writes a step's start retries: those its bound covers; a row owed by a loop since restarted names a write in flight when it stopped, whose landing is unknown, so it is retired unsent. */
export async function retryOwedWrites(cycle: CarriedCycle, calls: readonly (keyof DaemonEffects)[]) {
  const owed = owedWrites.get(cycle.state);
  for (const [rowKey, entry] of owed ?? []) if (calls.includes(entry.call)) await owedWrite(cycle, rowKey.slice(owedPrefix.length), entry.row, entry.what, entry.call, entry.write);
  for (const [rowKey, row] of Object.entries(cycle.state.actions)) if (rowKey.startsWith(owedPrefix) && carriedRow(row) && !owed?.has(rowKey))
    await retireCarried(cycle, rowKey, row, `${row.detail.replace(/ was carried to the next cycle: .*$/, '')} was in flight when the loop last stopped: whether it landed is unknown, and a best-effort record is not sent again`);
}

/**
 * Run a step under its budget (GY-1774): the step's calls named in `calls` are bounded by the lesser
 * of the per-call bound and the budget left, a carried one reaching the step's isolation is recorded
 * `waiting` and retried next cycle, the best-effort writes owed to the step's calls are retried first,
 * and once the step returns the budget ends, so a launch it handed to the launcher passes through unbounded.
 */
export async function withinStepBudget<T>(cycle: Cycle, step: BoundedStep, calls: readonly (keyof DaemonEffects)[], body: (bounded: Cycle, budgetLeft: () => number | null) => Promise<T>, identity: Pick<BoundOptions, 'key'> = {}, outerLeft?: () => number): Promise<T> {
  const budget = stepBudget(cycle.now, (cycle.config?.run?.intervalSeconds ?? 20) * 1000, outerLeft); // a cycle built by hand (a step's own test) may carry no run settings
  // Nested steps (the resume step runs inside the sessions step) bound the effects beneath every earlier bound, never a bound's own race.
  const effects = boundedCalls(unboundedEffects(cycle.effects), cycle.state as DaemonState, cycle.now, budget.left, { step, calls, ...identity });
  const bounded: Cycle = { ...cycle, effects, isolate: carriedIsolate({ ...cycle, effects }, step) };
  try { await retryOwedWrites(bounded, calls); return await body(bounded, budget.left); } finally { budget.end(); }
}

/** The nested phases still running when their step's budget passed, per kept state: one phase runs once at a time, and a later cycle joins it instead of starting it again. */
const phases = new WeakMap<object, Map<string, { promise: Promise<void>; gate: PhaseGate }>>();
/** The calls a nested phase makes wait at its gate, open only while a cycle's step awaits the phase: a phase answered after its step returned starts no fresh call behind it, and resumes under the next cycle's budget that joins it. */
interface PhaseGate { open: boolean; over: boolean; waiters: (() => void)[] }
const openGate = (gate: PhaseGate) => { gate.open = true; for (const release of gate.waiters.splice(0)) release(); };
const gated = (cycle: Cycle, gate: PhaseGate): Cycle => ({ ...cycle, effects: new Proxy(cycle.effects, { get: (target, property, receiver) => {
  const fn = Reflect.get(target, property, receiver);
  const hold = (owner: object, member: (...args: unknown[]) => unknown) => async (...args: unknown[]) => { while (!gate.open) await new Promise<void>(resolve => gate.waiters.push(resolve)); return member.apply(owner, args); };
  if (typeof fn === 'function') return property !== 'persist' ? hold(target, fn) : fn;
  // The acceptance role's and the planner's effects are objects of calls, the merge-writer ports under `acceptance.writer` among them: each waits at the gate too, so a landing whose `merged` read answered after the step returned starts no fetch, merge or push behind it.
  if (fn && typeof fn === 'object' && (property === 'acceptance' || property === 'planner')) return throughMethods(fn, String(property), (_name, owner, member) => hold(owner, member));
  return fn;
} }) });
/**
 * A nested phase whose calls the effects' bound does not reach (the acceptance role's and the planner's own goals, headless runs and posts)
 * waits under the step's budget: past it the phase keeps running, the step goes on, and the phase is recorded `waiting` on the step's row;
 * the next cycle joins the run still in flight (or finds it settled) rather than starting a second, so a slow answer never holds a later phase.
 */
export async function boundedPhase(cycle: Cycle, step: BoundedStep, name: string, budgetLeft: () => number | null, run: (gated: Cycle) => Promise<void>): Promise<void> {
  const running = phases.get(cycle.state) ?? phases.set(cycle.state, new Map()).get(cycle.state)!, key = `${step}:${name}`, previous = cycle.state.actions[`carried:${key}`];
  let entry = running.get(key), sent = false;
  // A step whose budget is spent starts no phase: it stays owed to the next cycle, which starts it on a fresh budget.
  if (!entry && budgetLeft() === 0) {
    await recordCarried(cycle, `carried:${key}`, { kind: 'decision', work: null }, new StepCallCarriedError(`the ${step} step's budget passed before the ${name} phase was made (${stepCallBoundMs} ms per call, 0 ms left); the phase stays owed and is retried next cycle`, false), `The ${step} step's ${name} phase`);
    return;
  }
  if (!entry) {
    sent = true;
    const gate: PhaseGate = { open: true, over: false, waiters: [] };
    // A phase that has run through holds nothing: a call it detached (a draft still running) goes on, behind no gate.
    const own: Promise<void> = run(gated(cycle, gate)).finally(() => { gate.over = true; openGate(gate); if (running.get(key)?.promise === own) running.delete(key); });
    own.catch(() => {});
    running.set(key, entry = { promise: own, gate });
  }
  const { gate } = entry, flight = entry.promise;
  openGate(gate);
  const left = budgetLeft(), boundMs = stepCallBoundMs, capped = left === null ? boundMs : Math.max(0, Math.min(boundMs, left)), startedAt = cycle.now(), wall = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined, stopped = false, carried = false;
  const expired = new Promise<never>((_, reject) => {
    const tick = () => {
      if (stopped) return;
      if (Math.max(cycle.now() - startedAt, Date.now() - wall) >= capped) { carried = true; return void reject(new StepCallCarriedError(`the ${step} step's budget passed before the ${name} phase answered (${boundMs} ms per call, ${capped} ms left); the phase stays owed and is retried next cycle${sent ? '' : ', joining the run still in flight'}`, sent)); }
      timer = setTimeout(tick, 25); timer.unref?.();
    };
    timer = setTimeout(tick, Math.min(capped, 25)); timer.unref?.();
  });
  try { await Promise.race([flight, expired]); }
  catch (error) {
    if (!carried) throw error;
    await recordCarried(cycle, `carried:${key}`, { kind: 'decision', work: null }, error, `The ${step} step's ${name} phase`);
    return;
  } finally { stopped = true; clearTimeout(timer); if (!gate.over) gate.open = false; }
  if (carriedRow(previous)) await retireCarried(cycle, `carried:${key}`, previous, `The ${step} step's ${name} phase, carried on cycle ${previous.cycle}, ran through on its retry`);
}
