// Concern: a split or research record carried past its step bound (GY-1774) holds its item and is retried next cycle, never read as a failed run.
import type { Work } from '../model.js';
import type { Cycle } from './cycle.js';
import { carriedRow, recordCarried, retireCarried, stepCallCarried } from './step-budget.js';

/**
 * A guard for the record the split or research step writes: a write carried past its bound is
 * remembered by item and rethrown, so the step's own handling (a failed action, a run never
 * started) does not read a slow plane as a failed run.
 */
export function guardCarried<E>(write: (work: Work, event: E) => Promise<unknown>) {
  const carried = new Map<string, unknown>();
  return { carried, write: async (work: Work, event: E) => { try { return await write(work, event); } catch (error) { if (stepCallCarried(error)) carried.set(work.id, error); throw error; } } };
}

/**
 * Record each carried item `waiting` on its own row and retire the row of an item that ran
 * through; the caller holds the carried items this cycle, and the next cycle's step writes the
 * record again, joining the call in flight or consuming its answer.
 */
export async function settleCarriedWrites(cycle: Cycle, step: 'decomposition' | 'research', items: readonly Work[], carried: ReadonlyMap<string, unknown>) {
  const prefix = `carried:dispatch:${step}:`;
  for (const item of items) {
    const key = `${prefix}${item.id}`, error = carried.get(item.id), previous = cycle.state.actions[key];
    if (error !== undefined) await recordCarried(cycle, key, { kind: 'dispatch', work: item.key, epoch: item.epoch }, error, `Recording ${item.key}'s ${step} run`);
    else if (carriedRow(previous)) await retireCarried(cycle, key, previous, `Recording ${item.key}'s ${step} run, carried on cycle ${previous.cycle}, was retried and ran through`);
  }
}
