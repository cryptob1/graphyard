// Concern: the coordination snapshot read's one jittered retry, so a single failed read never fails a cycle.
import { setTimeout as delay } from 'node:timers/promises';

/** The pause before the one retry of a failed snapshot read: a second or so, jittered so loops never retry in step. */
export const snapshotRetryDelayMs = (random: () => number = Math.random) => Math.round(500 + random() * 1000);
/**
 * The coordination snapshot read, retried once. The read is an idempotent GET, and one timed-out or
 * refused read is usually the network or a busy server, not a fault worth a failed cycle and its
 * backoff: it is tried again after a jittered pause, and only a second failure fails the cycle
 * (GY-187). `master run` wraps its snapshot effect in this.
 */
export function retriedSnapshot<T>(read: () => Promise<T>, pause: () => number = snapshotRetryDelayMs): () => Promise<T> {
  return async () => {
    try { return await read(); }
    catch { await delay(pause()); return read(); }
  };
}
