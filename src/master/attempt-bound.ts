// Concern: the attempt bound (GY-2961) — how long one worker attempt may run, its extension by worktree progress, and the remaining time every reader names.
import type { MasterRun } from './profiles.js';
import type { Work } from '../model.js';
import type { SessionHandle } from '../model/sessions.js';
import { attemptClaimedAt, attemptProgressFresh, workerNoSubmissionRefusalMs } from '../model/attempt-bound.js';

/**
 * The attempt bound is a progress bound (GY-2961): an attempt whose worktree shows a new commit or
 * changed files inside the progress window (`attemptProgressWindowMs`) and whose lease renews runs
 * past the no-submission bound, and is stopped only at the ceiling; one with neither is stopped at
 * the bound. `run.attemptBoundMinutes` and `run.attemptCeilingMinutes` set both per install; the
 * defaults are the no-submission bound the control plane already refused renewals at, and an eight
 * hour ceiling.
 */
export const defaultAttemptBoundMinutes = Math.round(workerNoSubmissionRefusalMs / 60_000);
export const defaultAttemptCeilingMinutes = 8 * 60;
export const attemptBoundMs = (run: Pick<MasterRun, 'attemptBoundMinutes'> | undefined) => (run?.attemptBoundMinutes ?? defaultAttemptBoundMinutes) * 60_000;
export const attemptCeilingMs = (run: Pick<MasterRun, 'attemptCeilingMinutes'> | undefined) => (run?.attemptCeilingMinutes ?? defaultAttemptCeilingMinutes) * 60_000;

/** A duration in plain words: `47m`, `1.5h`, `8h`. */
export const boundMinutes = (ms: number) => ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : `${Math.round(ms / 60_000)}m`;

/** How an attempt's bound reads: the instant each stop falls at and the time left to it. */
export interface AttemptBoundSummary {
  epoch: number; claimedAt: string;
  /** The bound stop: when it falls, how long is left, and the configured bound. */
  boundAt: string; boundIn: string; bound: string;
  /** The ceiling stop: when it falls, how long is left, and the configured ceiling. */
  ceilingAt: string; ceilingIn: string; ceiling: string;
  /** The newest worktree progress on the record, and whether it is fresh enough to extend. */
  progressAt: string | null; fresh: boolean;
}

/** The attempt bound of a live implementation session, for `master status` and the brief: the remaining time of the attempt, and what extends it. */
export function attemptBoundSummary(item: Work, session: Pick<SessionHandle, 'principal' | 'epoch' | 'id'>, run: Pick<MasterRun, 'attemptBoundMinutes' | 'attemptCeilingMinutes'> | undefined, now: number): AttemptBoundSummary | null {
  const epoch = session.epoch ?? Number(/:(\d+)$/.exec(session.id)?.[1]);
  const lease = item.lease;
  if (!lease || lease.owner !== session.principal || lease.epoch !== epoch || Date.parse(lease.expiresAt) <= now) return null;
  const claimedAt = attemptClaimedAt(item, epoch);
  if (!claimedAt || !Number.isFinite(Date.parse(claimedAt))) return null;
  const claimed = Date.parse(claimedAt), bound = attemptBoundMs(run), ceiling = attemptCeilingMs(run);
  const readings = (item.sessions ?? [])
    .filter(handle => handle.kind === 'implementation' && handle.principal === session.principal && (handle.epoch === epoch || handle.id === `${session.principal}:${epoch}`))
    .map(handle => handle.workTree?.at).filter((at): at is string => !!at);
  const progressAt = readings.sort().at(-1) ?? null;
  return {
    epoch, claimedAt,
    boundAt: new Date(claimed + bound).toISOString(), boundIn: boundMinutes(Math.max(0, claimed + bound - now)), bound: boundMinutes(bound),
    ceilingAt: new Date(claimed + ceiling).toISOString(), ceilingIn: boundMinutes(Math.max(0, claimed + ceiling - now)), ceiling: boundMinutes(ceiling),
    progressAt, fresh: attemptProgressFresh(item, epoch, session.principal, claimedAt, now),
  };
}
