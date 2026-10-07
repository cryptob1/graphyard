import type { Work } from '../model.js';

/* The single authority for the containment grace window: fault counting here, and settlement and status through
   src/quarantine.ts, which imports it. It lives in this dependency-free module so the browser bundle can load it (GY-1214). */
export const containmentGraceMs = 120_000;
/** How long a lapsed containment fence may wait, past its grace window, for the loop to verify and settle it: inside it the fence is a step the loop is taking, past it a fault (GY-1299) and an intervention (GY-1392). */
export const containmentSettleWaitBoundMs = 10 * 60_000;

export type ContainmentPhase =
  | { state: 'live'; owner: string; epoch: number; expiresAt: string }
  | { state: 'grace'; lapsedAt: string; remainingMs: number }
  | { state: 'lapsed'; lapsedAt: string | null };

/**
 * Where a containment quarantine stands against its worker's lease. Every supervised launch
 * records one, so while its owner still holds the quarantined epoch's lease it is a session at
 * work, not something to act on. Once the lease lapses, the grace window runs from the later of
 * the lease and launch deadlines, and only then can supervisor absence be verified.
 */
export function containmentPhase(work: Work, now: number, graceMs = containmentGraceMs): ContainmentPhase | null {
  const quarantine = work.containmentQuarantine;
  if (!quarantine) return null;
  const lease = work.lease;
  if (lease && lease.owner === quarantine.owner && lease.epoch === quarantine.epoch && Date.parse(lease.expiresAt) > now)
    return { state: 'live', owner: lease.owner, epoch: lease.epoch, expiresAt: lease.expiresAt };
  const deadlines = [lease?.epoch === quarantine.epoch ? lease.expiresAt : undefined, quarantine.leaseExpiresAt, quarantine.launchExpiresAt]
    .map(value => value ? Date.parse(value) : NaN).filter(Number.isFinite);
  if (!deadlines.length) return { state: 'lapsed', lapsedAt: null };
  const lapsed = Math.max(...deadlines), lapsedAt = new Date(lapsed).toISOString();
  return lapsed + graceMs > now ? { state: 'grace', lapsedAt, remainingMs: lapsed + graceMs - now } : { state: 'lapsed', lapsedAt };
}
