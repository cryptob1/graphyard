// Concern: cycle step 4c's observation wakes (GY-1865) — the rework waker's `observe` and the waiting refusal's `wakeObservation`, run under the decisions step's bound, carried across cycles, retried once and retired when moot.
import { observationWaker } from '../master/base-break-refresh.js';
import type { Work } from '../model.js';
import { type DaemonAction, type DaemonState, message } from './state.js';
import { readyToRetry } from './sessions.js';
import { observationWakeDue } from './decisions.js';
import { type DaemonEffects, record } from './effects.js';
import type { Cycle } from './cycle.js';
import { boundedCalls, callKey, carriedRow, recordCarried, retireCarried, stepCallCarried } from './step-budget.js';

/** GY-1865: the decisions step's observation wakes — the rework waker's `observe` and the waiting refusal's `wakeObservation` — are the same slow `resync` write the decisions wait behind, so they wait under the step's bound with every other call it makes: one past the bound is carried to the next cycle, which joins it or consumes its answer so a wake starts once, and a spent budget wakes nothing new, so a slow control plane can no longer stack one 30s resync POST after another inside the step and hold the cycle past its 60s bound. */
const wakeCalls: readonly (keyof DaemonEffects)[] = ['observe', 'wakeObservation'];
/** GY-1865 review: per loop cursor, each item's observation-wake generation, bumped when its carried wake is retired as moot: the generation is part of the wake's flight key, so a later wake never joins, nor consumes the answer of, the retired one. */
const wakeGenerations = new WeakMap<DaemonState, Map<string, number>>();
const wakeGeneration = (state: DaemonState, id: string | undefined) => (id && wakeGenerations.get(state)?.get(id)) || 0;
const nextWakeGeneration = (state: DaemonState, id: string) => { const generations = wakeGenerations.get(state) ?? new Map<string, number>(); wakeGenerations.set(state, generations); generations.set(id, wakeGeneration(state, id) + 1); };
/** The item's one wake row (GY-710): one per item, whatever wake it records. */
const rowPrefix = 'wake:observation:', wakeKey = (item: Work) => `${rowPrefix}${item.id}`;
/** The detail prefix of a wake row that records the waker's own `observe`, as against the refusal's `wakeObservation`. */
const observeWake = (work: Work) => `Observing ${work.key}'s reading`;
const carriedObserve = (row: DaemonAction | undefined, work: Work) => carriedRow(row) && row!.detail.startsWith(observeWake(work));

/**
 * The step's effects with its observation wakes under its bound. The wake is the item's — the waker's
 * remaining wait (`observe`'s second argument) moves between retries, so the key drops it and a retry
 * joins the wake still in flight instead of starting a second one. GY-1865 review: the wake's flights
 * are kept on the cursor, the state its carried rows stand on and `retireCarried` releases them from,
 * so they age by its cycles; the item's wake generation, bumped when a moot row is retired, parts a
 * later wake from the obsolete flight, so it is a fresh send, never the retired wake's answer.
 */
export const boundWakes = (cycle: Cycle, base: DaemonEffects, budgetLeft: () => number) =>
  boundedCalls(base, cycle.state, cycle.now, budgetLeft, { step: 'decisions', calls: wakeCalls, key: (call, args) => callKey(call, [args[0], wakeGeneration(cycle.state, (args[0] as Work | undefined)?.id)]), wording: (_call, args) => ({ what: `${(args[0] as Work | undefined)?.key ?? 'the item'}'s observation wake`, owed: 'wake', per: 'call' }) });

/**
 * GY-1865 review: a carried wake whose item no longer waits is retired, never left `waiting` forever —
 * nothing would retry it, `pruneDaemonState` drops only settled rows, and the row would keep the flight
 * and its answer in memory while status counted a call nothing will make. An item still open is retired
 * where its decision is read (`retireMootWake`); one that left the loop's items is retired here, its row's last reader.
 */
export async function retireDepartedWakes(cycle: Cycle) {
  const { state, snapshot } = cycle, present = new Set(snapshot.work.map(work => work.id));
  for (const [rowKey, row] of Object.entries(state.actions)) if (rowKey.startsWith(rowPrefix) && carriedRow(row) && !present.has(rowKey.slice(rowPrefix.length)))
    { await retireCarried(cycle, rowKey, row, `Waking ${row.work ?? 'the item'}'s observation job, carried on cycle ${row.cycle}, is moot: the item left the loop's items`); nextWakeGeneration(state, rowKey.slice(rowPrefix.length)); }
}

/**
 * The decisions step's wakes for one cycle, on `effects` already bounded by `boundWakes`:
 * - `wake`: the rework waker's `observe`. GY-1865 review: an `observe` past its bound is recorded carried on the
 *   item's wake row before the waker reads it as no reading, so the cycle sends no `wakeObservation` resync beside
 *   the one still in flight, and the next cycle's retry joins that `observe` flight. An answer the waker's own call
 *   takes for a row carried on an earlier cycle is that row's retry: it joined the flight or consumed its answer,
 *   so the row is retired then, and `wakeJob` never sends the carried observe a second time.
 * - `wakeJob`: the waiting refusal's wake, this step's own bounded `wakeObservation` call — its `resync` once held
 *   the step for one 30s timeout after another, one waiting item at a time. A wake past the bound is carried to
 *   the next cycle (recorded waiting on its row, no fault), which joins the wake still in flight or consumes its
 *   answer; anything else fails the row as the delivery step's wake did. GY-1865 review: a carried wake is owed its
 *   retry — due on the very next cycle, joining the call in flight, consuming its kept answer, or making the first
 *   send a spent budget never made. It is never held for the re-wake interval as a finished wake would be: its row's
 *   `at` stamps a carry, not a wake. A row carried this very cycle is the next cycle's to retry: retried now, it would
 *   wait a second per-call bound on the same resync. A carried `observe` is retried as `observe`, so the retry joins
 *   its flight or consumes its answer instead of sending a second resync.
 * - `wakeCarried`: whether the item's carried row is a `wakeObservation` still owed its retry — that wake is the
 *   item's one resync in flight, so the waker sends no `observe` beside it; `wakeJob` joins or consumes it instead.
 * - `retireMootWake`: retire the item's carried wake row once its wake is moot — no rework wait, a fresher observation,
 *   or the item gone — so no carried call stays owed with nothing left to retry it.
 */
export function observationWakes(cycle: Cycle, effects: DaemonEffects) {
  const { state, now, clock, performed } = cycle;
  const wake = effects.observe && observationWaker((work, waitMs) => effects.observe!(work, waitMs).then(async fresh => {
    const key = wakeKey(work), row = state.actions[key];
    if (row && carriedRow(row) && row.cycle < state.cycle && row.detail.startsWith(observeWake(work))) await retireCarried(cycle, key, row, `${observeWake(work)}, carried on cycle ${row.cycle}, answered on its retry`);
    return fresh;
  }, async (error: unknown) => {
    if (stepCallCarried(error)) await recordCarried(cycle, wakeKey(work), { kind: 'refresh', work: work.key, epoch: work.epoch }, error, observeWake(work));
    throw error;
  }));
  const wakeJob = async (item: Work, why: string) => {
    const key = wakeKey(item), previous = state.actions[key], carried = carriedRow(previous), observed = carried && !!effects.observe && carriedObserve(previous, item);
    if (!effects.wakeObservation && !observed) return;
    if (carried && previous!.cycle === state.cycle) return;
    if (previous && !carried && (previous.state === 'failed' ? !readyToRetry(previous, state.cycle) : !observationWakeDue(item, previous?.at, clock))) return;
    // GY-1865 review: a carried row's attempts are the sends already made (recordCarried); consuming its rejection makes none, so a failure keeps that count — and the backoff it grows — adding one only for the first send a spent budget had never made.
    const sends = carried ? previous!.attempts + (/ budget passed before .+ was made /.test(previous!.detail) ? 1 : 0) : (previous?.state === 'failed' ? previous.attempts : 0) + 1;
    const noteWake = async (outcome: 'done' | 'failed', detail: string, at: number) =>
      performed.push(await record(state, key, { kind: 'refresh', work: item.key, principal: null, state: outcome, detail, attempts: outcome === 'failed' ? Math.max(1, sends) : 1, epoch: item.epoch, cycle: state.cycle }, at, effects.persist));
    try { await (observed ? effects.observe!(item, 0) : effects.wakeObservation!(item)); }
    catch (error) {
      if (stepCallCarried(error)) { await recordCarried(cycle, key, { kind: 'refresh', work: item.key, epoch: item.epoch }, error, observed ? observeWake(item) : `Waking ${item.key}'s observation job`); return; }
      return void await noteWake('failed', `Could not wake the observation job of ${item.key}: ${message(error)}`, now());
    }
    await noteWake('done', `Woke the observation job of ${item.key}: its ${why} waits for an observation newer than ${item.observation?.at ?? 'none'}`, clock);
  };
  const wakeCarried = (item: Work) => { const row = state.actions[wakeKey(item)]; return carriedRow(row) && !carriedObserve(row, item); };
  const retireMootWake = async (item: Work, why: string) => {
    const key = wakeKey(item), row = state.actions[key];
    if (row && carriedRow(row)) { await retireCarried(cycle, key, row, `Waking ${item.key}'s observation job, carried on cycle ${row.cycle}, is moot: ${why}`); nextWakeGeneration(state, item.id); }
  };
  return { wake, wakeJob, wakeCarried, retireMootWake };
}
