// Concern: the gh login's rate limit as a wait — a refusal is classified, the reset read once, and every ungoverned gh read of the loop is skipped until then.
import type { ChildRun } from './child-runner.js';

const refusal = /API rate limit exceeded|secondary rate limit|abuse detection/i;
const fallbackMs = 5 * 60_000, ceilingMs = 60 * 60_000;
let pausedUntil = 0;

/** True when the error is gh's refusal for the login's quota (primary or secondary), not a failure of the read itself. */
export function isGhRateLimit(error: unknown): boolean {
  return refusal.test(errorText(error));
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.message}\n${(error as { stderr?: unknown }).stderr ?? ''}` : String(error);
}

/** The epoch milliseconds until which gh reads are paused, 0 when none are. */
export function ghPausedUntil(now: number = Date.now()): number { return pausedUntil > now ? pausedUntil : 0; }

/** The error a skipped read fails with, so callers treat it as any other failed read. */
export class GhPausedError extends Error {
  constructor(readonly until: number) { super(`gh reads are paused until ${new Date(until).toISOString()}: the login's API rate limit was exceeded`); this.name = 'GhPausedError'; }
}

/** Fails fast while a rate-limit pause stands; the read is not attempted, so it spends none of the quota. */
export function assertGhNotPaused(now: number = Date.now()): void {
  const until = ghPausedUntil(now);
  if (until) throw new GhPausedError(until);
}

/**
 * Starts the pause for a rate-limit refusal: until the reset the login's `rate_limit` endpoint
 * reports (that read does not count against the quota), else a fixed five minutes, never more
 * than an hour. Any other error leaves the pause alone.
 */
export async function notePossibleGhRateLimit(error: unknown, run: ChildRun, now: number = Date.now()): Promise<boolean> {
  if (!isGhRateLimit(error)) return false;
  let until = now + fallbackMs;
  // A secondary limit or abuse-detection refusal is not the primary quota: its reset is not `core.reset`, and
  // the probe is itself a request, so the fixed backoff stands without it.
  if (/secondary rate limit|abuse detection/i.test(errorText(error))) { pausedUntil = Math.max(pausedUntil, until); return true; }
  try {
    const reset = Number(String(await run('gh', ['api', 'rate_limit', '--jq', '.resources.core.reset'])).trim());
    if (Number.isFinite(reset) && reset * 1000 > now) until = Math.min(reset * 1000 + 1000, now + ceilingMs);
  } catch { /* the fallback stands */ }
  pausedUntil = Math.max(pausedUntil, until);
  return true;
}

/** Test seam: forgets any standing pause. */
export function resetGhPause(): void { pausedUntil = 0; }
