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

/**
 * GY-1299. Whether a containment fence is still in motion: its owner's lease has lapsed and the
 * fence is inside its grace window or within `containmentSettleWaitBoundMs` after it. The reclaim
 * step probes the host and settles a verified-dead fence on its own (settleQuarantine; cycleFaults
 * reads a fence whose settle action is done as gone, even in the cycle that settled it), so a fence
 * that recent is a step the loop is already taking, not a fault: on 5 October 2026 GY-1147 counted
 * 11s past its grace window and autosettled 28s later, and GY-1289 counted twice for one fence —
 * once as verified settleable while its grace window still ran, once as a hold 90s later, in the
 * very cycle that settled it. Neither kind counts inside the bound, so a fence the loop settles
 * opens no instance, and one standing past it counts once, as the item's own `containment` fault
 * (the settleable line restates it). A fence with no deadline to date it counts at once.
 * It is also the window in which the fence is the loop's alone to settle (GY-1633): master status
 * names no hand command for it and `master settle-containment` refuses it.
 */
export function containmentInMotion(work: Work | undefined, now: number): boolean {
  const phase = work ? containmentPhase(work, now) : null;
  if (!phase || phase.state === 'live') return false;
  if (phase.state === 'grace') return true;
  return !!phase.lapsedAt && now - Date.parse(phase.lapsedAt) - containmentGraceMs <= containmentSettleWaitBoundMs;
}

/**
 * Why a hand settlement of `work`'s fence is refused at `now`, or null when one may proceed (GY-1633):
 * while the fence is in motion the loop's reclaim step is already verifying the host and settling it,
 * and a second executor for the same fence is what the intervention report counted on GY-1410.
 */
export function handSettlementRefusal(work: Work, now: number): string | null {
  if (!work.containmentQuarantine || !containmentInMotion(work, now)) return null;
  return `${work.key}'s containment fence of epoch ${work.containmentQuarantine.epoch} is the loop's to settle: its reclaim step verifies the host and settles it within ${containmentSettleWaitBoundMs / 60_000} minutes of its grace window ending. Settle it by hand only past that bound`;
}
