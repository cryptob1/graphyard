// Concern: an attempt that blocks again after its blocker was cleared (GY-867) — ended and handed on.
// GY-885: an attempt that runs past its role's maximum time box — ended and retried fresh with backoff.
import type { Work } from '../model.js';
import type { ExhaustionRecord } from '../model/capacity.js';
import type { DaemonState } from './state.js';
import { credentialBlockedMarker } from '../worker-credential.js';
import { capBindingPrefix } from '../model/approval.js';

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
 * reblocked or as overlong, when that is the item's latest worker end. Both are session-local
 * causes (a sandbox's file ownership, a runtime's permission model, a runtime that hung) and are
 * likeliest to recur on the same runtime.
 */
export function runtimeToAvoid(item: Pick<Work, 'capacity'>): string | null {
  const last = item.capacity?.exhaustions.filter(entry => entry.role === 'worker').at(-1);
  return last?.cause === 'interrupted' && (last.reason.startsWith(reblockedMarker) || last.reason.startsWith(overlongMarker)) ? last.runtime ?? null : null;
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
 * Whether a worker end counts on the retry ladder: an attempt ended past its role's time box
 * (GY-885), or ended on a GitHub credential failure (GY-999) — both relaunched fresh, and both
 * able to recur on every relaunch, so both are bounded by the same backoff and cap.
 */
export const countsOnRetryLadder = (end: Pick<ExhaustionRecord, 'reason'>) => end.reason.startsWith(overlongMarker) || end.reason.startsWith(credentialBlockedMarker);

/**
 * GY-885: the consecutive attempts of this item that ended without submitting, each past its
 * role's time box or on a GitHub credential failure (GY-999) — the trailing run of worker ends
 * whose cause is an interruption and whose reason carries either marker. The run stops at the
 * first end that carries neither (a reblocked or idle hand-over breaks the row), at any attempt at or before the one
 * that submitted (a submission is what "in a row" is counted from), and at ends the item's
 * applied cap decision already approved through (older than `resumeApprovedAt`): those belong
 * to the round the approver let start, not to this one. Every one of these facts is read from
 * the item's own record, so the ladder survives a daemon restart and reads the same from any
 * host — no local cursor holds it.
 */
export function attemptEndsNeedingRetry(item: Pick<Work, 'capacity' | 'submission'>, resumeApprovedAt = 0): ExhaustionRecord[] {
  const submitted = item.submission?.epoch ?? 0;
  const run: ExhaustionRecord[] = [];
  for (const end of [...(item.capacity?.exhaustions ?? [])].reverse()) {
    if (end.role !== 'worker' || end.cause !== 'interrupted') break;
    if ((end.epoch ?? 0) <= submitted) break;
    if (!countsOnRetryLadder(end)) break;
    if (Date.parse(end.at) <= resumeApprovedAt) break;
    run.unshift(end);
  }
  return run;
}

/**
 * GY-885: how many consecutive attempts ended without submitting, capped at
 * `maxFailedAttempts`, so a reason can name the retry the next attempt stands for.
 */
export function failedAttemptCount(item: Pick<Work, 'capacity' | 'submission'>, resumeApprovedAt = 0): number {
  return Math.min(attemptEndsNeedingRetry(item, resumeApprovedAt).length, maxFailedAttempts);
}

/** The backoff durations for retries: 5 min, 15 min, 45 min. Cap at 3 attempts. */
export const retryBackoffMs = [5 * 60_000, 15 * 60_000, 45 * 60_000];

/** The maximum number of failed attempts before holding the item. */
export const maxFailedAttempts = 3;

/** One named cause per ended attempt, oldest first: what `master status` shows for why attempts die. */
export function attemptHoldCauses(ends: ExhaustionRecord[]): string[] {
  return ends.map(end => `attempt ${end.epoch} on ${end.profile} ended at ${end.at}: ${end.reason}`);
}

/** The binding a cap-resolution decision carries: the run it judged, by item and third failure. */
export { capBindingPrefix } from '../model/approval.js';
export const capBinding = (item: Pick<Work, 'key'>, boundAt: number) => `${capBindingPrefix}${item.key}:${new Date(boundAt).toISOString()}`;

/** What the dispatch step holds an item for while its retry ladder runs, or null to dispatch as usual. */
export interface AttemptRetryHold {
  /** `backoff`: dispatch waits for the next window. `held`: the cap is reached and only an approver's decision resumes it. */
  kind: 'backoff' | 'held';
  /** The consecutive failed attempts this hold counts, after the submission and applied-decision boundaries. */
  count: number;
  /** One named cause per ended attempt, oldest first. */
  causes: string[];
  /** The ends the count is taken from, oldest first. */
  ends: ExhaustionRecord[];
  /** Epoch time dispatch may resume at (backoff), or null while held. */
  resumeAt: number | null;
  /** Epoch time of the failure that reached the cap (held), or null in a backoff. */
  boundAt: number | null;
}

/**
 * GY-885: the hold an item's retry ladder puts on dispatch right now, or null. Each retry waits
 * a backoff (5, then 15 minutes) after the failure before it; when three attempts in a row have
 * ended without submitting, the item is held instead of redispatched again, with every cause
 * named, until the cap decision an independent approver judges is applied — the fresh round it
 * approves then still waits the longest backoff (45 minutes) before it dispatches.
 */
export function attemptRetryHold(item: Pick<Work, 'capacity' | 'submission'>, clock: number, resumeApprovedAt = 0): AttemptRetryHold | null {
  const ends = attemptEndsNeedingRetry(item, resumeApprovedAt);
  if (ends.length >= maxFailedAttempts) {
    const boundAt = Date.parse(ends[ends.length - 1].at);
    return { kind: 'held', count: ends.length, causes: attemptHoldCauses(ends), ends, resumeAt: null, boundAt };
  }
  if (ends.length) {
    const lastAt = Date.parse(ends[ends.length - 1].at), backoffMs = retryBackoffMs[ends.length - 1];
    return clock - lastAt < backoffMs
      ? { kind: 'backoff', count: ends.length, causes: attemptHoldCauses(ends), ends, resumeAt: lastAt + backoffMs, boundAt: null }
      : null;
  }
  // No failed attempt stands since the resume: an applied cap decision starts the approved round
  // itself, and that round waits the longest backoff before it dispatches.
  if (resumeApprovedAt) {
    const backoffMs = retryBackoffMs[retryBackoffMs.length - 1];
    return clock - resumeApprovedAt < backoffMs
      ? { kind: 'backoff', count: 0, causes: [], ends: [], resumeAt: resumeApprovedAt + backoffMs, boundAt: null }
      : null;
  }
  return null;
}

/** Why an attempt is ended for running past its role's time box. */
export function overlongReason(item: Pick<Work, 'key'>, epoch: number, ageMs: number, maximumMs: number, failedCount: number) {
  const hours = (ms: number) => Math.floor(ms / 3_600_000);
  const minutes = (ms: number) => Math.floor((ms % 3_600_000) / 60_000);
  const elapsed = `${hours(ageMs)}h${minutes(ageMs)}m`;
  const limit = `${hours(maximumMs)}h${minutes(maximumMs)}m`;
  const cause = failedCount > 0 ? `; retry ${Math.min(failedCount + 1, maxFailedAttempts)} of ${maxFailedAttempts}` : '';
  return `overlong attempt on epoch ${epoch}: ran ${elapsed}, past the ${limit} maximum for its role${cause}`;
}

/** The marker an overlong attempt's end carries in its capacity record, read back by dispatch. */
export const overlongMarker = 'overlong attempt';

/** The key under which a session's overlong detection is tracked. */
export const overlongKey = (item: Pick<Work, 'id'>, epoch: number) => `session:overlong:${item.id}:${epoch}`;
