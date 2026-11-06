import { setTimeout as delay } from 'node:timers/promises';
import { type Work } from '../model.js';
/**
 * How often a free worker session asks the control plane for its next assignment.
 *
 * The pull model's latency is the wait for the next poll plus the time the pull itself takes, so
 * this interval is the bound on ready-to-claim. Thirty seconds keeps p90 inside the two-minute
 * target with room to spare, and costs one cheap request per idle worker per half minute — no
 * central runtime-health tracking, no dispatcher deciding which session is free, and no session
 * sitting idle because the thing that would have dispatched it is not running.
 */
export const workerPullIntervalMs = 30_000;

export interface PulledAssignment { at: string; assigned: Work | null; offered: number; refused: { key: string; reason: string }[]; waitedMs: number; polls: number }
/**
 * The worker side of the pull model: ask for the next assignment, and keep asking until there is
 * one or the caller stops.
 *
 * A free session runs this instead of waiting to be dispatched into. It holds no state between
 * polls, registers nothing, and is invisible to the control plane until it claims — which is what
 * removes central runtime-health tracking: nothing has to know this session exists, or is alive,
 * for it to be given work. The wait for the next assignment is one poll interval plus the time
 * the claim itself takes, so the published interval is the bound on ready-to-claim.
 */
export async function runWorkerPull(pull: () => Promise<{ assigned: Work | null; offered?: number; refused?: { key: string; reason: string }[] }>, options: { intervalMs?: number; signal?: AbortSignal; once?: boolean; now?: () => number; maxPolls?: number; log?: (line: string) => void } = {}): Promise<PulledAssignment> {
  const intervalMs = options.intervalMs ?? workerPullIntervalMs, now = options.now ?? Date.now, log = options.log ?? (() => {});
  const startedAt = now();
  let polls = 0, last: { assigned: Work | null; offered?: number; refused?: { key: string; reason: string }[] } = { assigned: null };
  const done = (): PulledAssignment => ({ at: new Date(now()).toISOString(), assigned: last.assigned ?? null, offered: last.offered ?? 0, refused: last.refused ?? [], waitedMs: Math.max(0, now() - startedAt), polls });
  while (!options.signal?.aborted) {
    polls++;
    last = await pull();
    if (last.assigned) { log(`[graphyard-worker] claimed ${last.assigned.key} after ${polls} poll(s)`); return done(); }
    if (options.once || (options.maxPolls !== undefined && polls >= options.maxPolls)) return done();
    try { await delay(intervalMs, undefined, { signal: options.signal }); } catch { /* woken to stop */ }
  }
  return done();
}
