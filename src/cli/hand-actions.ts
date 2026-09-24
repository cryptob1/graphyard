import { readFile } from 'node:fs/promises';
import { claimable, claimLive, settling, type ActionRow } from '../model/actions.js';
import { automatableProof } from '../model/mechanical-proofs.js';
import { liveReviewRequest } from '../model/dispatch.js';
import type { Work } from '../model/work.js';
import { sessionRetry } from '../producer.js';
import { dispatchFailureLimit } from '../auto-dispatch.js';

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
 * Two hand actions stay open on a system-driven item because the loop itself sends the master to
 * them: `master review` for a review request the loop has stopped relaunching (its session settled
 * unanswered, its sessions or launch refusals are exhausted), and `master decide attest` for a
 * `manual:` proof no producer session runs, which only an attestation can satisfy.
 * The executor's own dispatch goes through its handler (src/executor.ts), never this path.
 */

export const handActions = ['dispatch', 'merge', 'review', 'evidence', 'merge-decision'] as const;
export type HandAction = typeof handActions[number];

/** The command a master types for each hand action, and the loop step that performs it instead. */
export const loopOwned: Record<HandAction, { command: string; step: string }> = {
  dispatch: { command: 'master dispatch', step: "the loop's dispatch step: master run's dispatcher claims the item's dispatch action and launches a worker" },
  merge: { command: 'master merge', step: "the loop's merge step: master run performs the guarded merge of the authorized candidate" },
  review: { command: 'master review', step: "the loop's dispatch step: master run launches the bound reviewer on every submitted head; master review is open only as the recovery of a review request the loop has stopped relaunching" },
  evidence: { command: 'master decide attest', step: "the loop's dispatch step: master run launches an independent proof producer on the exact head; only a manual proof no producer runs is attested" },
  'merge-decision': { command: 'master decide merge', step: "the loop's decisions step: master run requests the merge decision when automatic merging is off" },
};

/** The `master decide` actions that are hand actions the loop owns. */
export const loopOwnedDecisions: Partial<Record<string, HandAction>> = { attest: 'evidence', merge: 'merge-decision' };

/**
 * The hand action a `master decide` would be, or null when it is not one the loop owns. An
 * attestation of a `manual:` proof no producer session runs is the only way that proof is ever
 * satisfied, so it is left to the two-party decision; an attestation that names no proof, or a
 * proof a producer runs, is the loop's.
 */
export function handDecision(work: Pick<Work, 'producerProofs'>, action: string | undefined, input: unknown): HandAction | null {
  const owned = action ? loopOwnedDecisions[action] ?? null : null;
  if (owned !== 'evidence') return owned;
  const proof = (input as { proof?: unknown } | null)?.proof;
  return typeof proof === 'string' && proof.startsWith('manual:') && !automatableProof(work, proof) ? null : owned;
}
/** The JSON a `master decide` names, inline or as `@FILE`; unreadable input is no input. */
export async function decisionPayload(argument: string | undefined): Promise<unknown> {
  if (!argument || !/^[{@]/.test(argument)) return null;
  try { return JSON.parse(argument.startsWith('@') ? await readFile(argument.slice(1), 'utf8') : argument); } catch { return null; }
}

/** One reviewer session as the loop's ledger records it, and one launch the loop's cursor saw refused. */
type ReviewSession = Parameters<typeof sessionRetry>[0][number];
/**
 * Why a hand review launch is the recovery the loop sends the master to, or null when the loop
 * still launches the item's review itself. It is the recovery exactly when the candidate holds a
 * live review request and the loop has stopped relaunching it: its last session settled without
 * satisfying it, its sessions are exhausted, or its launch was refused `dispatchFailureLimit`
 * times. These are the states whose recovery text names `master review`.
 */
export function reviewRecovery(work: Work, sessions: ReviewSession[], failure: { attempts: number } | undefined, now: number): string | null {
  const request = liveReviewRequest(work);
  if (!request) return null;
  const retry = sessionRetry(sessions, request.id, now);
  if (retry.settled && retry.last && retry.last.state !== 'pending') return `review request ${request.id}'s session attempt ${retry.attempts} ${retry.last.state} without satisfying it`;
  if (retry.exhausted) return `review request ${request.id} exhausted its ${retry.attempts} automatic sessions`;
  if (failure && failure.attempts >= dispatchFailureLimit) return `the loop's launch of review request ${request.id} was refused ${failure.attempts} time(s)`;
  return null;
}

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

/** Refuses `master review` on a system-driven item unless it is the recovery of a request the loop stopped relaunching. */
export function assertHandReview(work: Work, sessions: ReviewSession[], failures: Record<string, { attempts: number }>, now: number) {
  if (!systemDriven(work)) return;
  const request = liveReviewRequest(work);
  if (reviewRecovery(work, sessions, request ? failures[request.id] : undefined, now)) return;
  assertHandAction(work, 'review');
}

/** Every refusal `master dispatch` owes before it launches anything: system-driven first, then the race with the executor. */
export async function assertHandDispatch(work: Work, now: string, intervalSeconds: number, read: (path: string) => Promise<any>) {
  assertHandAction(work, 'dispatch');
  const events: { created_at?: string }[] = await read(releaseEventsPath(work));
  const releasedAt = events[0]?.created_at ? new Date(events[0].created_at).toISOString() : null;
  const refusal = dispatchRaceRefusal(work, new Date(now), { intervalMs: intervalSeconds * 1000, releasedAt });
  if (refusal) throw new Error(refusal);
}
