import type { Work } from '../model.js';

/* Must equal src/quarantine.ts containmentGraceMs (settlement and status); kept here because the browser
   bundle cannot load quarantine.ts's node-only imports. tests/containment-followups.test.ts pins them equal (GY-1179). */
export const containmentGraceMs = 120_000;

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
