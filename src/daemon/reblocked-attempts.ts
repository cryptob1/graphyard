// Concern: an attempt that blocks again after its blocker was cleared (GY-867) — ended and handed on.
// GY-885: an attempt that runs past its role's maximum time box — ended and retried fresh with backoff.
import type { Work } from '../model.js';
import type { DaemonState } from './state.js';
import { roleSessionMaximumMs } from '../model/sessions.js';

/**
 * GY-867. Unblocking an attempt only re-prompts the same session (cycle-sessions 1e). When what
 * stopped it lives in that session — its sandbox, its pane's working directory, its stale view of a
 * remote branch — it blocks again within minutes and holds its lease and its profile's slot for as
 * long as it keeps renewing. On 2026-09-27 six of ten worker slots were held that way for hours
 * (GY-710 blocked six times on one epoch). So a clearance is remembered per epoch, and an attempt
 * that blocks again on the same epoch after one is ended: its partial work is kept on its branch,
 * its own blocker ends with it, and the item goes to a fresh session.
 */
export const clearedBlockerKey = (item: Pick<Work, 'id'>, epoch: number) => `resume:cleared:${item.id}:${epoch}`;
export const reblockedKey = (item: Pick<Work, 'id'>, epoch: number) => `resume:reblocked:${item.id}:${epoch}`;

/** The blocker the attempt's earlier clearance answered, when this epoch had one; null otherwise. */
export function clearedBefore(state: DaemonState, item: Pick<Work, 'id'>, epoch: number): string | null {
  const cleared = state.actions[clearedBlockerKey(item, epoch)];
  return cleared?.state === 'done' ? cleared.detail : null;
}

/** Why the attempt is ended, naming both blockers so the item's history shows the pattern. */
export function reblockedReason(item: Pick<Work, 'key'>, epoch: number, cleared: string, blocker: string) {
  const quote = (text: string) => `"${text.length > 300 ? `${text.slice(0, 299)}…` : text}"`;
  return `blocked again on epoch ${epoch} after its blocker was cleared (${cleared}); it now reports ${quote(blocker)}, so the cause lives in this session and ${item.key} goes to a fresh one`;
}
/** The marker a reblocked attempt's end carries in its capacity record, read back by dispatch. */
export const reblockedMarker = 'blocked again on epoch ';

/**
 * The runtime the next attempt should avoid: the runtime of the attempt that was just ended as
 * reblocked, when that is the item's latest worker end. A session-local cause (a sandbox's file
 * ownership, a runtime's permission model) is likeliest to recur on the same runtime.
 */
export function runtimeToAvoid(item: Pick<Work, 'capacity'>): string | null {
  const last = item.capacity?.exhaustions.filter(entry => entry.role === 'worker').at(-1);
  return last?.cause === 'interrupted' && last.reason.startsWith(reblockedMarker) ? last.runtime ?? null : null;
}

/**
 * Orders candidate profiles for a dispatch: those on another runtime than `avoid` first, then the
 * rest, each group in its given order. With nothing to avoid the order is unchanged.
 */
export function preferOtherRuntime<T extends { profile: { kind?: string | null; mode?: string } }>(entries: T[], avoid: string | null): T[] {
  if (!avoid) return entries;
  const runtime = (entry: T) => entry.profile.kind ?? entry.profile.mode ?? null;
  return [...entries.filter(entry => runtime(entry) !== avoid), ...entries.filter(entry => runtime(entry) === avoid)];
}

/**
 * GY-885: An attempt that has run past its role's time box is ended and retried with backoff.
 * Returns the number of failed attempts (ended without submitting) in sequence before this one,
 * capped at maxFailedAttempts.
 */
export function failedAttemptCount(item: Pick<Work, 'capacity' | 'submission'>): number {
  if (!item.capacity?.exhaustions) return 0;
  let count = 0;
  for (const exhaustion of [...item.capacity.exhaustions].reverse()) {
    if (exhaustion.role !== 'worker') continue;
    if (exhaustion.cause !== 'interrupted') break;
    if (!exhaustion.reason.startsWith('overlong attempt')) break;
    count++;
    if (count >= maxFailedAttempts) return maxFailedAttempts;
  }
  return count;
}

/** The backoff durations for retries: 5 min, 15 min, 45 min. Cap at 3 attempts. */
export const retryBackoffMs = [5 * 60_000, 15 * 60_000, 45 * 60_000];

/** The maximum number of failed attempts before holding the item. */
export const maxFailedAttempts = 3;

/** Why an attempt is ended for running past its role's time box. */
export function overlongReason(item: Pick<Work, 'key'>, epoch: number, ageMs: number, maximumMs: number, failedCount: number) {
  const hours = (ms: number) => Math.floor(ms / 3_600_000);
  const minutes = (ms: number) => Math.floor((ms % 3_600_000) / 60_000);
  const elapsed = `${hours(ageMs)}h${minutes(ageMs)}m`;
  const limit = `${hours(maximumMs)}h${minutes(maximumMs)}m`;
  const cause = failedCount > 0 ? `; retry ${failedCount + 1} of ${maxFailedAttempts}` : '';
  return `overlong attempt on epoch ${epoch}: ran ${elapsed}, past the ${limit} maximum for its role${cause}`;
}

/** The key under which a session's overlong detection is tracked. */
export const overlongKey = (item: Pick<Work, 'id'>, epoch: number) => `session:overlong:${item.id}:${epoch}`;

/** The marker an overlong attempt's end carries in its capacity record, read back by dispatch. */
export const overlongMarker = 'overlong attempt';

/** Whether dispatch should hold the item because it has failed 3 times in a row. */
export function shouldHoldForMaxRetries(item: Pick<Work, 'capacity' | 'submission'>): boolean {
  return failedAttemptCount(item) >= maxFailedAttempts;
}
