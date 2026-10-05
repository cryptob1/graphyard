// Concern: an item whose dispatch keeps failing for one unchanged cause (GY-1078).
import type { Work } from '../model.js';
import type { DaemonState, DispatchFailureRun } from './state.js';
import { fleetIdleCause } from '../model/blocker-class.js';
export { fleetIdleCause };

/**
 * How many consecutive dispatch failures of one item with the same cause, each spending an epoch,
 * stop its redispatch.
 *
 * Each failed launch claims the item, spends an epoch and releases it, so the next cycle sees a
 * fresh epoch and dispatches again on whichever profile is free. On 2026-10-01 GY-859 was
 * dispatched about forty times over 5.4 hours, every attempt failing on the same worktree that
 * held its branch. Two failures may be a transient fault; a third identical one is a condition
 * that redispatching will not change, so the cause is recorded as the item's blocker instead.
 */
export const dispatchFailureBlockAfter = 3;

/**
 * How long the loop waits before asking again for a blocker the control plane refused: five
 * minutes after the first refusal, doubling with each one to at most an hour, so a control plane
 * that keeps refusing is not asked every cycle while the item stays held in the loop.
 */
export const dispatchBlockRetryMs = (refusals: number) => Math.min(5 * 60_000 * 2 ** Math.max(0, refusals - 1), 60 * 60_000);

/**
 * A dispatch failure's cause, with what differs between attempts of one cause taken out: the
 * epoch each attempt claimed, the assignment path and branch named for it, commit ids and the
 * command line that ran. Two failures with the same cause read the same here; any other change
 * in the text is a different cause and starts a new run.
 */
export function dispatchFailureCause(item: Pick<Work, 'key'>, failure: string): string {
  const key = item.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return failure
    .replace(/^Command failed: [^\n]*\n?/gm, '')
    .replace(new RegExp(`(\\.graphyard/worktrees/${key})-\\d+`, 'g'), '$1-N')
    .replace(new RegExp(`(graphyard/${key.toLowerCase()})-\\d+`, 'g'), '$1-N')
    .replace(/\bepoch \d+/g, 'epoch N')
    .replace(/\b[0-9a-f]{40}\b/g, '<sha>')
    .trim().slice(0, 2000);
}

/**
 * Adds one failure to the item's run, starting a new run when the cause changed. `item.epoch` is
 * the epoch the snapshot showed before this dispatch; a failure counts again only when it moved
 * past the run's last one, that is when the failure before it claimed and spent an epoch, and a
 * fleet-idle cause (`fleetIdleCause`) never counts. One
 * refused before any claim (a dependency unfinished, a resource held, no account free) is a
 * condition that clears on its own, so repeating it never reaches the bound.
 */
export function noteDispatchFailure(state: DaemonState, item: Pick<Work, 'id' | 'key' | 'epoch'>, failure: string, at: string): DispatchFailureRun {
  const cause = dispatchFailureCause(item, failure), previous = state.dispatchFailures[item.id];
  // A fleet-idle cause is answered at count zero and kept nowhere: it ends any run, and starts none.
  if (fleetIdleCause(cause)) { delete state.dispatchFailures[item.id]; return { key: item.key, cause, count: 0, epoch: item.epoch, firstAt: at, lastAt: at }; }
  const run = previous && previous.cause === cause
    ? { ...previous, count: item.epoch > previous.epoch ? previous.count + 1 : previous.count, epoch: item.epoch, lastAt: at }
    : { key: item.key, cause, count: 1, epoch: item.epoch, firstAt: at, lastAt: at };
  state.dispatchFailures[item.id] = run;
  return run;
}

/** The blocker a run at the bound records: the count, since when, and the cause in git's words. */
export const dispatchFailureBlocker = (run: DispatchFailureRun) =>
  `Dispatch failed ${run.count} consecutive times with the same cause since ${run.firstAt}, so the master loop stopped redispatching ${run.key}: ${run.cause}`.slice(0, 2000);
