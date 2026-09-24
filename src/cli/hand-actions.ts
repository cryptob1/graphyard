import { claimable, claimLive, settling, type ActionRow } from '../model/actions.js';
import type { Work } from '../model/work.js';

/**
 * The master-side rules the loop depends on, enforced where the master acts rather than
 * remembered by whichever agent holds the master seat (GY-175).
 *
 * Two rules. A hand dispatch never races the executor's: while the item's implementation
 * dispatch action is claimable or claimed, or inside the loop's dispatch interval after the item
 * was released, `master dispatch` is refused naming the action the dispatcher is about to run —
 * two launches of one item would be two workers on one lease. And a system-driven item
 * (`systemDriven`, on by default for new items) is never pushed through its gates by hand: the
 * master CLI refuses the actions the loop owns for it, naming the loop step that performs each.
 * Monitoring commands and `master run` itself are not hand actions and are never refused here.
 * The executor's own dispatch goes through its handler (src/executor.ts), never this path.
 */

export const handActions = ['dispatch', 'merge', 'review', 'evidence', 'merge-decision'] as const;
export type HandAction = typeof handActions[number];

/** The command a master types for each hand action, and the loop step that performs it instead. */
export const loopOwned: Record<HandAction, { command: string; step: string }> = {
  dispatch: { command: 'master dispatch', step: "the loop's dispatch step: master run's dispatcher claims the item's dispatch action and launches a worker" },
  merge: { command: 'master merge', step: "the loop's merge step: master run performs the guarded merge of the authorized candidate" },
  review: { command: 'master review', step: "the loop's dispatch step: master run launches the bound reviewer on every submitted head" },
  evidence: { command: 'master decide attest', step: "the loop's dispatch step: master run launches an independent proof producer on the exact head" },
  'merge-decision': { command: 'master decide merge', step: "the loop's decisions step: master run requests the merge decision when automatic merging is off" },
};

/** The `master decide` actions that are hand actions the loop owns. */
export const loopOwnedDecisions: Partial<Record<string, HandAction>> = { attest: 'evidence', merge: 'merge-decision' };

export const systemDriven = (work: Pick<Work, 'systemDriven'>) => work.systemDriven === true;

export function systemDrivenRefusal(work: Pick<Work, 'key' | 'systemDriven'>, action: HandAction): string | null {
  if (!systemDriven(work)) return null;
  const owned = loopOwned[action];
  return `${work.key} is system-driven: ${owned.command} is a hand action the loop owns, and ${owned.step}. Watch it with master status; a stalled step is repaired in the loop, never by hand`;
}

/** Ledger events after which the dispatcher's next tick picks the item up: backlog release, unblock, and a lease that ended. */
export const releaseEventKinds = ['ready', 'unblock', 'release', 'lease.expired'] as const;
export const releaseEventsPath = (work: Pick<Work, 'id'>) => `events?work=${encodeURIComponent(work.id)}&kind=${releaseEventKinds.join(',')}&limit=1&payload=none`;

const implementationDispatch = (row: ActionRow) => row.kind === 'dispatch' && row.inputs.kind === 'dispatch' && row.inputs.target === 'implementation';

/**
 * Why a hand dispatch of this item would race the executor's, or null when it would not. The
 * action named is the row the dispatcher runs; a row waiting out a failure backoff is not about to
 * run, so a hand dispatch then is the recovery it is for.
 */
export function dispatchRaceRefusal(work: Pick<Work, 'key' | 'actionQueue'>, now: Date, window: { intervalMs: number; releasedAt: string | null }): string | null {
  const row = (work.actionQueue?.actions ?? []).find(implementationDispatch);
  const named = (row: ActionRow) => `dispatch action ${row.id} (${row.reason})`;
  if (row && claimLive(row, now)) return `${work.key}: ${named(row)} is claimed by executor ${row.claim!.executor} on ${row.claim!.host} until ${row.claim!.expiresAt}; the executor's dispatch is in progress, so master dispatch is refused`;
  if (row && settling(row, now)) return `${work.key}: ${named(row)} was completed at ${row.resolvedAt} and is settling; the executor's dispatch already launched a worker, so master dispatch is refused`;
  if (row && claimable(row, now)) return `${work.key}: ${named(row)} is pending and claimable; the loop's dispatcher claims it on its next tick, so master dispatch is refused`;
  const released = window.releasedAt ? Date.parse(window.releasedAt) : NaN;
  if (Number.isFinite(released) && now.getTime() - released < window.intervalMs)
    return `${work.key} was released at ${window.releasedAt}, within the loop's ${Math.round(window.intervalMs / 1000)}s dispatch interval; the dispatcher's next tick claims its dispatch action, so master dispatch is refused`;
  return null;
}

/** Throws the refusal for a hand action on a system-driven item. */
export function assertHandAction(work: Pick<Work, 'key' | 'systemDriven'>, action: HandAction) {
  const refusal = systemDrivenRefusal(work, action);
  if (refusal) throw new Error(refusal);
}

/** Every refusal `master dispatch` owes before it launches anything: system-driven first, then the race with the executor. */
export async function assertHandDispatch(work: Work, now: string, intervalSeconds: number, read: (path: string) => Promise<any>) {
  assertHandAction(work, 'dispatch');
  const events: { created_at?: string }[] = await read(releaseEventsPath(work));
  const releasedAt = events[0]?.created_at ? new Date(events[0].created_at).toISOString() : null;
  const refusal = dispatchRaceRefusal(work, new Date(now), { intervalMs: intervalSeconds * 1000, releasedAt });
  if (refusal) throw new Error(refusal);
}
