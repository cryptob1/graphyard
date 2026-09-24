import { actionClaimMs, claimable, claimLive, settling, waitingToRetry, type ActionRow } from '../model/actions.js';
import { automatableProof } from '../model/mechanical-proofs.js';
import { liveReviewRequest } from '../model/dispatch.js';
import type { Work } from '../model/work.js';
import { sessionRetry } from '../producer.js';
import { dispatchFailureLimit } from '../auto-dispatch.js';
import { mergedWithoutAuthorization } from '../master.js';

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
 * Three hand actions stay open on a system-driven item because the loop itself sends the master to
 * them: `master review` for a review request the loop has stopped relaunching (its session settled
 * unanswered, its sessions or launch refusals are exhausted), `master decide merge` for a merge
 * the loop cannot request (`mergeDecisionRecovery`), and `master decide attest` for a
 * `manual:` proof no producer session runs, or whose producer request the loop has likewise stopped
 * relaunching, which then only an attestation can satisfy.
 * The executor's own dispatch goes through its handler (src/executor.ts), never this path.
 */

export const handActions = ['dispatch', 'merge', 'review', 'evidence', 'merge-decision'] as const;
export type HandAction = typeof handActions[number];

/** The command a master types for each hand action, and the loop step that performs it instead. */
export const loopOwned: Record<HandAction, { command: string; step: string }> = {
  dispatch: { command: 'master dispatch', step: "the loop's dispatch step: master run's dispatcher claims the item's dispatch action and launches a worker" },
  merge: { command: 'master merge', step: "the loop's merge step: master run performs the guarded merge of the authorized candidate" },
  review: { command: 'master review', step: "the loop's dispatch step: master run launches the bound reviewer on every submitted head; master review is open only as the recovery of a review request the loop has stopped relaunching" },
  evidence: { command: 'master decide attest', step: "the loop's dispatch step: master run launches an independent proof producer on the exact head; only a manual proof no producer runs, or whose producer request the loop stopped relaunching, is attested" },
  'merge-decision': { command: 'master decide merge', step: "the loop's decisions step: master run requests the merge decision when automatic merging is off" },
};

/** The `master decide` actions that are hand actions the loop owns. */
export const loopOwnedDecisions: Partial<Record<string, HandAction>> = { attest: 'evidence', merge: 'merge-decision' };

/**
 * The hand action a `master decide` would be, or null when it is not one the loop owns. An
 * attestation of a `manual:` proof no producer session runs is the only way that proof is ever
 * satisfied, so it is left to the two-party decision; so is one of a proof whose producer request
 * the loop has stopped relaunching (`producerRecovery`). An attestation that names no proof, or a
 * proof a producer still runs, is the loop's.
 */
export function handDecision(work: Work, action: string | undefined, input: unknown, loop: LoopSessions = { sessions: [], failures: {}, now: Date.now() }): HandAction | null {
  const owned = action ? loopOwnedDecisions[action] ?? null : null;
  if (owned === 'merge-decision') return mergeDecisionRecovery(work, loop) ? null : owned;
  if (owned !== 'evidence') return owned;
  const proof = (input as { proof?: unknown } | null)?.proof;
  if (typeof proof !== 'string' || !proof.startsWith('manual:')) return owned;
  return !automatableProof(work, proof) || producerRecovery(work, proof, loop) ? null : owned;
}
/**
 * Why a hand merge decision is the one the loop sends the master to, or null while the loop
 * requests it itself. Two cases: a merge GitHub already made without a valid execution, which
 * only a two-party decision reconciles and the loop names rather than requests; and a loop with
 * no operator-agent identity (`requestsDecisions: false`), whose merge step says the master puts
 * the decision to the approver by hand.
 */
export function mergeDecisionRecovery(work: Work, loop: Pick<LoopSessions, 'requestsDecisions'>): string | null {
  if (mergedWithoutAuthorization(work)) return `${work.key} was merged on GitHub without a valid merge execution; only a two-party merge decision reconciles it`;
  if (loop.requestsDecisions === false) return 'no master operator-agent identity is provisioned, so the loop cannot request the merge decision itself';
  return null;
}

/** One session as the loop's reviewer or producer ledger records it (a reviewer's with the verdict it posted), and the launches of each request the loop's cursor saw refused. */
type LoopSession = Parameters<typeof sessionRetry>[0][number] & { verdict?: { state: string } };
type ReviewSession = LoopSession;
export interface LoopSessions {
  sessions: LoopSession[]; failures: Record<string, { attempts: number }>; now: number;
  /** False when the loop has no operator-agent identity and so cannot request decisions itself. */
  requestsDecisions?: boolean;
}

/**
 * Why the loop has stopped relaunching a live request, or null while it still launches it: its
 * last session settled without satisfying it, its sessions are exhausted, or its launch was
 * refused `dispatchFailureLimit` times. These are the states in which the loop's dispatch step
 * says no further automatic attempt follows.
 *
 * A session closed `completed` on the verdict it posted has answered the request even while the
 * snapshot still carries it: the control plane has not ingested that GitHub review yet. A second
 * session would post a second verdict for the same request, which review-conflict.ts withholds
 * together with the first, so the request is stopped only once that verdict is dismissed — and
 * a dismissal reopens the record as `failed`, which the loop relaunches itself.
 */
function stoppedRequest(label: string, request: { id: string }, sessions: LoopSession[], failure: { attempts: number } | undefined, now: number): string | null {
  const retry = sessionRetry(sessions, request.id, now);
  const answered = sessions.filter(session => session.requestId === request.id).at(-1);
  if (answered?.state === 'completed' && answered.verdict && answered.verdict.state !== 'DISMISSED') return null;
  if (retry.settled && retry.last && retry.last.state !== 'pending') return `${label} request ${request.id}'s session attempt ${retry.attempts} ${retry.last.state} without satisfying it`;
  if (retry.exhausted) return `${label} request ${request.id} exhausted its ${retry.attempts} automatic sessions`;
  if (failure && failure.attempts >= dispatchFailureLimit) return `the loop's launch of ${label} request ${request.id} was refused ${failure.attempts} time(s)`;
  return null;
}

/**
 * Why a hand review launch is the recovery the loop sends the master to, or null when the loop
 * still launches the item's review itself: the candidate holds a live review request the loop has
 * stopped relaunching. These are the states whose recovery text names `master review`.
 */
export function reviewRecovery(work: Work, sessions: ReviewSession[], failure: { attempts: number } | undefined, now: number): string | null {
  const request = liveReviewRequest(work);
  return request ? stoppedRequest('review', request, sessions, failure, now) : null;
}

/**
 * Why a hand attestation of a produced `manual:` proof is the only way left to satisfy it, or null
 * while the loop still launches a producer for it: the live producer request for the proof has no
 * further automatic attempt, and nothing launches a producer by hand, so without the two-party
 * attestation the candidate could never satisfy the proof.
 */
export function producerRecovery(work: Pick<Work, 'autoDispatch'>, proof: string, loop: LoopSessions): string | null {
  const request = work.autoDispatch?.producers.find(entry => entry.state === 'requested' && entry.proofs?.includes(proof));
  return request ? stoppedRequest('producer', request, loop.sessions, loop.failures[request.id], loop.now) : null;
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
 * How long a hand dispatch may take from this guard to its lease claim. `master dispatch` reads the
 * worker credential, Herdr and the account registry before `prepareWorkerLaunch` claims the item,
 * and nothing reserves the queued dispatch row meanwhile; a row whose failure backoff ends inside
 * this window would be claimed by the executor while the hand launch is still on its way to the
 * lease, and the two would launch one item twice. It is the executor's own claim bound: the time
 * one dispatch attempt is given before its row is offered to the next.
 */
export const handDispatchFenceMs = actionClaimMs;
/**
 * The headroom a hand launch keeps before the row's backoff ends. Its lease claim is one child
 * `graphyard claim` process whose HTTP request may run for the CLI's whole request timeout
 * (`AbortSignal.timeout(30_000)`, src/cli/context.ts), plus the process's startup; a claim begun
 * inside this margin could still be in flight when the executor may claim the row.
 */
export const handDispatchClaimTimeoutMs = 30_000;
export const handDispatchClaimMarginMs = handDispatchClaimTimeoutMs + 15_000;

/** When the item's backed-off implementation dispatch row is offered to the executor again, or null when it is not in a backoff. */
export function dispatchRetryAt(work: Pick<Work, 'actionQueue'>, now: Date): number | null {
  const row = (work.actionQueue?.actions ?? []).find(implementationDispatch);
  return row && waitingToRetry(row, now) ? Date.parse(row.retryAt!) : null;
}

/**
 * Why a hand dispatch of this item would race the executor's, or null when it would not. The
 * action named is the row the dispatcher runs. A row waiting out a failure backoff is not about to
 * run only while its backoff outlasts the hand launch's way to its lease claim
 * (`handDispatchFenceMs`); a hand dispatch then is the recovery it is for, and it claims nothing
 * once the backoff is about to end (`assertHandDispatch`'s `claimBy`).
 */
export function dispatchRaceRefusal(work: Pick<Work, 'key' | 'actionQueue'>, now: Date, window: { intervalMs: number; releasedAt: string | null }): string | null {
  const row = (work.actionQueue?.actions ?? []).find(implementationDispatch);
  const named = (row: ActionRow) => `dispatch action ${row.id} (${row.reason})`;
  if (row && claimLive(row, now)) return `${work.key}: ${named(row)} is claimed by executor ${row.claim!.executor} on ${row.claim!.host} until ${row.claim!.expiresAt}; the executor's dispatch is in progress, so master dispatch is refused`;
  if (row && settling(row, now)) return `${work.key}: ${named(row)} was completed at ${row.resolvedAt} and is settling; the executor's dispatch already launched a worker, so master dispatch is refused`;
  if (row && claimable(row, now)) return `${work.key}: ${named(row)} is pending and claimable; the loop's dispatcher claims it on its next tick, so master dispatch is refused`;
  const retryAt = dispatchRetryAt(work, now);
  if (row && retryAt !== null && retryAt - now.getTime() < handDispatchFenceMs)
    return `${work.key}: ${named(row)} is in a failure backoff that ends at ${row.retryAt}, inside the ${Math.round(handDispatchFenceMs / 1000)}s a hand dispatch has to reach its lease claim; the dispatcher claims it then, so master dispatch is refused`;
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

/**
 * Every refusal `master dispatch` owes before it launches anything: system-driven first, then the
 * race with the executor. Returns `claimBy`, the local instant after which the hand launch must not
 * claim the lease because the backed-off dispatch row is about to be offered to the executor again;
 * undefined when no row is backing off.
 *
 * `now` is the snapshot's control-plane clock and `requestedAt` the local instant the snapshot was
 * requested, taken before it was read. Every local instant spent since — the snapshot's transit,
 * the events read — is added to `now` before the race is judged, and the deadline is carried from
 * `requestedAt`, so a slow read only ever brings the refusal and the deadline earlier, never later.
 */
export async function assertHandDispatch(work: Work, now: string, intervalSeconds: number, read: (path: string) => Promise<any>, requestedAt = Date.now()): Promise<{ claimBy?: number }> {
  assertHandAction(work, 'dispatch');
  const events: { created_at?: string }[] = await read(releaseEventsPath(work));
  const releasedAt = events[0]?.created_at ? new Date(events[0].created_at).toISOString() : null;
  const snapshotAt = Date.parse(now), judgedAt = new Date(snapshotAt + Math.max(0, Date.now() - requestedAt));
  const refusal = dispatchRaceRefusal(work, judgedAt, { intervalMs: intervalSeconds * 1000, releasedAt });
  if (refusal) throw new Error(refusal);
  const retryAt = dispatchRetryAt(work, judgedAt);
  // The row's backoff is on the control plane's clock; the deadline is carried onto this host's from before the snapshot was read.
  return retryAt === null ? {} : { claimBy: requestedAt + (retryAt - snapshotAt) - handDispatchClaimMarginMs };
}
