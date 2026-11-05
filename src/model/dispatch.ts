import type { ProducerGroup } from './mechanical-proofs.js';
import type { Work } from './work.js';
import { exactApproval } from './review.js';
import { carriedApproval } from './carry.js';
import { behindBaseHold } from './behind-base.js';
/**
 * Automatic dispatch at submit.
 *
 * The moment a candidate passes the build gate, the control plane records what the exact head
 * still needs from the outside: one review request when the policy expects a GitHub verdict and
 * none binds the head, and one producer request per group of automatable proofs that no trusted
 * evidence binds. Each request is bound to head, base and policy revision, so a head change
 * cancels it (with the reason) and a fresh head requests again — unless the merge queue carried
 * the approval or the proof across a Graphyard-authored tip, in which case nothing is asked for.
 * The master loop launches at most one session per request id; the record here is what makes
 * that idempotent, and the resolved requests kept in `history` are what `master status` reads
 * back. Nothing in this file authorizes progression: a request is a fact about what is missing,
 * and the gates still decide from evidence and verdicts alone.
 */

export const dispatchKinds = ['review', 'producer', 'product'] as const;
export type DispatchKind = typeof dispatchKinds[number];
export const dispatchStates = ['requested', 'satisfied', 'cancelled'] as const;
export type DispatchState = typeof dispatchStates[number];

export interface DispatchRequest {
  id: string; kind: DispatchKind;
  sha: string; baseSha: string; policyRevision: number; pr: number;
  /** Review only: the provider whose verdict the request waits for. Only `github` requests are launched by the master; the control plane dispatches the others through GitHub itself. */
  provider?: 'github';
  /** Producer only: the proof group and the proofs the launched session must produce. */
  group?: ProducerGroup; proofs?: string[];
  requestedAt: string; reason: string;
  state: DispatchState; resolvedAt?: string; resolution?: string;
}
export interface AutoDispatch {
  review: DispatchRequest | null;
  producers: DispatchRequest[];
  /** GY-2989: the product review a user-facing feature owes before its merge, one per head. Absent on records written before it existed. */
  product?: DispatchRequest | null;
  /** Resolved requests, newest last, bounded; the events ledger holds the complete sequence. */
  history: DispatchRequest[];
}
export type DispatchEvent = 'dispatch.requested' | 'dispatch.satisfied' | 'dispatch.cancelled';
export interface DispatchTransition { event: DispatchEvent; request: DispatchRequest }
export const dispatchHistoryLimit = 50;

// Which proofs a machine settles and what the head's evidence says of them live in a module the
// browser bundle can load (the gates read them); re-exported here for every existing reader.
export { behindBaseHold } from './behind-base.js';
export { automatableOutcomes, automatableProof, dispatchIneligibility, mechanicalFailure, mechanicalHold, mechanicalProof, mechanicalVerdicts, openProducerRequest, producerGroupDecisions, producerGroupOf, producerGroups, type MechanicalVerdict, type ProducerGroup, type ProducerGroupDecision, type ProducerGroupState, type ProofOutcome } from './mechanical-proofs.js';


export const short = (sha: string) => sha.slice(0, 12);
export const binds = (request: Pick<DispatchRequest, 'sha' | 'baseSha' | 'policyRevision'>, work: Work) =>
  !!work.candidate && request.sha === work.candidate.sha && request.baseSha === work.candidate.baseSha && request.policyRevision === work.policyRevision;

/**
 * Why the current head does or does not need a launched reviewer.
 *
 * `needed` answers the dispatcher; `state` names *which* answer it is, because most of the
 * negative ones are not "nothing to do" at all. A standing change request and a head that does
 * not contain the base tip both mean no review can be asked for this head — the item needs a new
 * one — and a caller that reads only the review gate's first refusal ("approval is required")
 * would keep asking for a review nobody can give. `model/next-action.ts` maps these states to the
 * action that actually moves the item, so the two readings cannot drift apart.
 */
export type ReviewState = 'required' | 'not-required' | 'approved' | 'carried' | 'changes-requested'
  | 'base-not-contained' | 'proofs-pending' | 'proof-failed';
export function reviewNeed(work: Work, all: Work[] = [work], now: Date): { needed: boolean; reason: string; state: ReviewState } {
  const approval = exactApproval(work);
  if (approval) return { needed: false, state: 'approved', reason: `approved by ${approval.reviewer} on ${short(approval.sha)}` };
  const carried = carriedApproval(work);
  if (carried) return { needed: false, state: 'carried', reason: `approval of ${short(carried.originalSha)} by ${carried.reviewer} carried to this head` };
  const candidate = work.candidate!, observation = work.observation!;
  const changes = observation.reviews.find(review => review.sha === candidate.sha && review.state === 'CHANGES_REQUESTED');
  if (changes) return { needed: false, state: 'changes-requested', reason: `${changes.reviewer} requested changes on ${short(candidate.sha)}; the next head is reviewed afresh` };
  const behind = behindBaseHold(work);
  if (behind) return { needed: false, state: 'base-not-contained', reason: behind };
  // Review is never held for proofs: CI runs the unit tests on the head and no producer is
  // requested, so the reviewer is asked as soon as the build gate passes.
  return { needed: true, state: 'required', reason: `independent approval of ${short(candidate.sha)} against ${short(candidate.baseSha)} under policy revision ${work.policyRevision} is required` };
}

/**
 * Why the current head does or does not need a launched product reviewer (GY-2989): a user-facing
 * feature's head owes one until a product review approves it, carries one across a non-UI delta,
 * or is answered by a change request (rework) or a reject (the master closes the item). Only a
 * head the control plane observed itself launches one — the session judges the preview and the
 * served app, not a pull request.
 */
export type ProductReviewState = 'required' | 'not-required' | 'approved' | 'carried' | 'changes-requested' | 'rejected';

/**
 * The handle ids the sessions this item is currently asking for may record for themselves.
 *
 * A launched reviewer or producer holds no lease, and its handle is keyed on the dispatch request
 * that asked for it (`launchedSessionHandle`). So a live request is the item naming that session:
 * it is what lets the session fill in the tab and transcript its launcher could not know, without
 * opening handle creation to every credential that can read the item.
 */
export const liveDispatchHandleIds = (work: Work): string[] =>
  [work.autoDispatch?.review ?? null, work.autoDispatch?.product ?? null, ...(work.autoDispatch?.producers ?? [])]
    .filter((request): request is DispatchRequest => !!request && request.state === 'requested')
    .map(request => request.id);

/** Every request the record holds for one head, live first, for readers that report per candidate. */
export function dispatchRequestsFor(work: Pick<Work, 'autoDispatch'>, sha: string): DispatchRequest[] {
  const state = work.autoDispatch;
  if (!state) return [];
  return [...(state.review ? [state.review] : []), ...(state.product ? [state.product] : []), ...state.producers, ...state.history].filter(request => request.sha === sha);
}

/**
 * The live review request the current candidate holds, or null. A launch by hand answers this
 * request — the same one the loop would launch — so the session it starts counts as that
 * request's next attempt instead of a session the record knows nothing about.
 */
export function liveReviewRequest(work: Work): DispatchRequest | null {
  const request = work.autoDispatch?.review;
  return request && request.state === 'requested' && binds(request, work) ? request : null;
}
