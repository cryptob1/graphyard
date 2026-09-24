import { createHash } from 'node:crypto';
import type { Work } from './work.js';
import { exactApproval, exhaustedReviewerProfiles, reviewProviderOf, reviewerProfileFor } from './review.js';
import { carriedApproval } from './carry.js';
import { automatableOutcomes, dispatchIneligibility, mechanicalHold, producerGroupDecisions, type ProducerGroup } from './mechanical-proofs.js';

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

export const dispatchKinds = ['review', 'producer'] as const;
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
  /** Resolved requests, newest last, bounded; the events ledger holds the complete sequence. */
  history: DispatchRequest[];
}
export type DispatchEvent = 'dispatch.requested' | 'dispatch.satisfied' | 'dispatch.cancelled';
export interface DispatchTransition { event: DispatchEvent; request: DispatchRequest }
export const dispatchHistoryLimit = 50;

// Which proofs a machine settles and what the head's evidence says of them live in a module the
// browser bundle can load (the gates read them); re-exported here for every existing reader.
export { automatableOutcomes, automatableProof, dispatchIneligibility, mechanicalFailure, mechanicalHold, mechanicalProof, mechanicalVerdicts, openProducerRequest, producerGroupDecisions, producerGroupOf, producerGroups, type MechanicalVerdict, type ProducerGroup, type ProducerGroupDecision, type ProducerGroupState, type ProofOutcome } from './mechanical-proofs.js';


const short = (sha: string) => sha.slice(0, 12);
const binds = (request: Pick<DispatchRequest, 'sha' | 'baseSha' | 'policyRevision'>, work: Work) =>
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
 *
 * The provider is decided last, and deliberately. Only a `github` review is answered by a session
 * a dispatcher launches; a `codex` or `agent` review is dispatched by the control plane's own
 * durable observation job (`processJob`), and an `agent` policy that has exhausted every reviewer
 * profile has nobody left to ask at all. Testing the provider first — as this function once did —
 * made the approval, change-request and base-tip states unreachable for those providers, so the
 * one refusal they can raise fell through to "a review is required" for a review no session will
 * ever be launched for. Every state below is therefore reachable under every provider, and the
 * three that cannot be answered by a launched reviewer say so in their own name.
 */
export type ReviewState = 'required' | 'not-required' | 'approved' | 'carried' | 'changes-requested'
  | 'base-not-contained' | 'provider-dispatched' | 'provider-exhausted' | 'proofs-pending' | 'proof-failed';
export function reviewNeed(work: Work, all: Work[] = [work], now = new Date()): { needed: boolean; reason: string; state: ReviewState } {
  if (!work.policy.review) return { needed: false, state: 'not-required', reason: 'the policy requires no independent review' };
  const provider = reviewProviderOf(work.policy);
  const approval = exactApproval(work);
  if (approval) return { needed: false, state: 'approved', reason: `approved by ${approval.reviewer} on ${short(approval.sha)}` };
  const carried = carriedApproval(work);
  if (carried) return { needed: false, state: 'carried', reason: `approval of ${short(carried.originalSha)} by ${carried.reviewer} carried to this head` };
  const candidate = work.candidate!, observation = work.observation!;
  const changes = observation.reviews.find(review => review.sha === candidate.sha && review.state === 'CHANGES_REQUESTED');
  if (changes) return { needed: false, state: 'changes-requested', reason: `${changes.reviewer} requested changes on ${short(candidate.sha)}; the next head is reviewed afresh` };
  // An agent reviewer records its change request as a verdict on the dispatched request rather
  // than as a GitHub review, and it stands for exactly the same thing: this head is answered.
  const verdict = observation.agentReview;
  if (verdict?.verdict === 'changes-requested' && verdict.provider === provider && verdict.sha === candidate.sha)
    return { needed: false, state: 'changes-requested', reason: `${verdict.profile ?? provider} requested changes on ${short(candidate.sha)}; the next head is reviewed afresh` };
  if (observation.baseTipContained === false) return { needed: false, state: 'base-not-contained', reason: `head ${short(candidate.sha)} does not contain the base tip ${short(observation.baseTip ?? '')}; a review of it would be dismissed when GitHub recomputes the merge base` };
  // Mechanical verification precedes judgment, for every provider: no reviewer is asked about a
  // head whose unit and integration proofs have not run, and a head that fails one goes back to
  // its worker (the build gate names the criterion) instead of consuming a reviewer session.
  const held = mechanicalHold(work, all, now);
  if (held) return held;
  // No reviewer identity is left to ask: the roster is spent for this candidate, and adding
  // capacity or selecting another provider is the operator's judgment, not a step anyone runs.
  if (provider === 'agent' && !reviewerProfileFor(work))
    return { needed: false, state: 'provider-exhausted', reason: `every configured reviewer profile is exhausted for ${short(candidate.sha)} (${exhaustedReviewerProfiles(work).join(', ') || 'none configured'}); adding reviewer capacity or selecting another review provider is the operator's decision` };
  if (provider !== 'github') return { needed: false, state: 'provider-dispatched', reason: `the control plane dispatches ${provider} review through GitHub itself; a fresh reading requests it and observes the verdict` };
  return { needed: true, state: 'required', reason: `independent approval of ${short(candidate.sha)} against ${short(candidate.baseSha)} under policy revision ${work.policyRevision} is required` };
}

/**
 * The handle ids the sessions this item is currently asking for may record for themselves.
 *
 * A launched reviewer or producer holds no lease, and its handle is keyed on the dispatch request
 * that asked for it (`launchedSessionHandle`). So a live request is the item naming that session:
 * it is what lets the session fill in the tab and transcript its launcher could not know, without
 * opening handle creation to every credential that can read the item.
 */
export const liveDispatchHandleIds = (work: Work): string[] =>
  [work.autoDispatch?.review ?? null, ...(work.autoDispatch?.producers ?? [])]
    .filter((request): request is DispatchRequest => !!request && request.state === 'requested')
    .map(request => request.id);

const requestId = (parts: (string | number)[]) => createHash('sha256').update(['dispatch', ...parts].join('\0')).digest('hex').slice(0, 32);

/**
 * Bring `work.autoDispatch` in line with the record as it stands and return what changed. Pure
 * over the work item and the clock: the same inputs always produce the same requests, and a
 * request id is a function of what it binds and when it was made.
 */
export function reconcileAutoDispatch(work: Work, all: Work[], now: Date): DispatchTransition[] {
  const state: AutoDispatch = work.autoDispatch ?? { review: null, producers: [], history: [] };
  const at = now.toISOString();
  const transitions: DispatchTransition[] = [];
  const resolve = (request: DispatchRequest, outcome: 'satisfied' | 'cancelled', resolution: string) => {
    const resolved: DispatchRequest = { ...request, state: outcome, resolvedAt: at, resolution };
    state.history = [...state.history, resolved].slice(-dispatchHistoryLimit);
    transitions.push({ event: outcome === 'satisfied' ? 'dispatch.satisfied' : 'dispatch.cancelled', request: resolved });
  };
  const open = (request: Omit<DispatchRequest, 'id' | 'requestedAt' | 'state'>): DispatchRequest => {
    const created: DispatchRequest = { ...request, id: requestId([request.kind, request.group ?? '', request.sha, request.baseSha, request.policyRevision, at]), requestedAt: at, state: 'requested' };
    transitions.push({ event: 'dispatch.requested', request: created });
    return created;
  };
  const staleReason = (request: DispatchRequest) => {
    const candidate = work.candidate!;
    if (request.sha !== candidate.sha) return `head changed from ${short(request.sha)} to ${short(candidate.sha)}`;
    if (request.baseSha !== candidate.baseSha) return `base changed from ${short(request.baseSha)} to ${short(candidate.baseSha)}`;
    return `policy revision changed from ${request.policyRevision} to ${work.policyRevision}`;
  };
  const ineligible = dispatchIneligibility(work);
  if (ineligible) {
    if (state.review) { resolve(state.review, 'cancelled', ineligible); state.review = null; }
    for (const request of state.producers) resolve(request, 'cancelled', ineligible);
    state.producers = [];
  } else {
    const candidate = work.candidate!;
    // Review: one live request per head, resolved by the verdict that lands on it.
    if (state.review && !binds(state.review, work)) { resolve(state.review, 'cancelled', staleReason(state.review)); state.review = null; }
    const need = reviewNeed(work, all, now);
    // A standing request over a head whose mechanical proofs are not all passing is withdrawn, not
    // answered: nothing reviewed it. (A request raised before GY-115 is the only way to hold one.)
    if (state.review && !need.needed) { resolve(state.review, need.state === 'proofs-pending' || need.state === 'proof-failed' ? 'cancelled' : 'satisfied', need.reason); state.review = null; }
    if (!state.review && need.needed) state.review = open({ kind: 'review', provider: 'github', sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: work.policyRevision, pr: candidate.pr, reason: need.reason });
    // Producers: one live request per proof group with something left to prove. A head whose
    // trusted evidence already failed is not asked for again; the master routes that finding.
    const outcomes = automatableOutcomes(work, all, now);
    const kept: DispatchRequest[] = [];
    for (const request of state.producers) {
      if (!binds(request, work)) { resolve(request, 'cancelled', staleReason(request)); continue; }
      const mine = outcomes.filter(entry => request.proofs!.includes(entry.proof));
      const failed = mine.filter(entry => entry.outcome === 'failed'), unproven = mine.filter(entry => entry.outcome === 'unproven');
      if (failed.length) resolve(request, 'satisfied', `trusted evidence failed for ${failed.map(entry => `${entry.proof} (${entry.producer})`).join(', ')}; the next head is requested afresh`);
      else if (!unproven.length) resolve(request, 'satisfied', `trusted passing evidence binds every proof: ${mine.map(entry => `${entry.proof} (${entry.producer})`).join(', ')}`);
      else kept.push(request);
    }
    state.producers = kept;
    // Opened exactly for the groups the shared decision calls `request` — the same predicate the
    // planner reads before it names a proof dispatch (next-action.ts).
    for (const decision of producerGroupDecisions(work, all, now, outcomes)) {
      if (decision.state !== 'request' || state.producers.some(request => request.group === decision.group)) continue;
      state.producers.push(open({ kind: 'producer', group: decision.group, proofs: decision.unproven, sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: work.policyRevision, pr: candidate.pr, reason: decision.reason }));
    }
  }
  work.autoDispatch = state;
  return transitions;
}

/** Every request the record holds for one head, live first, for readers that report per candidate. */
export function dispatchRequestsFor(work: Pick<Work, 'autoDispatch'>, sha: string): DispatchRequest[] {
  const state = work.autoDispatch;
  if (!state) return [];
  return [...(state.review ? [state.review] : []), ...state.producers, ...state.history].filter(request => request.sha === sha);
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

/** One live request as a reader joins it onto the session launched for it and that session's retry schedule. */
export interface RequestProgress {
  requestId: string; sinceMs: number; group?: string;
  /** The head the request binds, when the reader carries it; a review reader names the commit no verdict can be obtained on. */
  sha?: string;
  /** `verdict` is the session's recorded verdict state, as a status reader summarizes it: `DISMISSED`, `APPROVED`, or null. */
  session: { state: string; attempt?: number; resolution?: string | null; verdict?: string | null } | null;
  retry?: { attempts: number; limit: number; nextAt: string | null; exhausted: boolean } | null;
}
/**
 * Verdicts that answer a review request. The gate accepts one and refuses the other, and either
 * resolves the request on the next observation, so a session that posted one is not unanswered
 * while the control plane catches up. A dismissal answers nothing: GitHub withdrew it.
 */
export const answeringVerdicts = ['APPROVED', 'CHANGES_REQUESTED'];
/** A live request whose session settled leaving its gate unsatisfied, with nothing scheduled to answer it. */
export interface UnansweredRequest { requestId: string; kind: DispatchKind; group?: string; sinceMs: number; state: string; verdict: string | null; attempts: number; resolution: string | null }

/**
 * A request nothing is going to answer: its session settled — with a verdict the gate cannot
 * accept, such as an approval GitHub dismissed, or without one at all — and no further attempt
 * is scheduled for it. Such a request is not running and not refused; left unnamed it simply
 * waits, which is how an item sits at the review stage for an hour with nothing to show for it.
 * A session still pending, and one whose next attempt is already due, are answers in progress.
 */
export function unansweredRequest(request: RequestProgress, kind: DispatchKind): UnansweredRequest | null {
  const session = request.session;
  if (!session || session.state === 'pending') return null;
  if (request.retry && !request.retry.exhausted && request.retry.nextAt) return null;
  if (session.verdict && answeringVerdicts.includes(session.verdict)) return null;
  return { requestId: request.requestId, kind, ...(request.group ? { group: request.group } : {}), sinceMs: request.sinceMs,
    state: session.state, verdict: session.verdict ?? null, attempts: request.retry?.attempts ?? session.attempt ?? 1, resolution: session.resolution ?? null };
}

/** One settled reviewer session as a status reader summarizes it (summarizeReviews), for the judgement below. */
export interface SettledReviewSession { requestId?: string | null; sha: string; state: string; verdict?: string | null; reviewId?: number | null; resolution?: string | null }
/**
 * A review nobody can obtain on this commit, as opposed to one that is merely running or waiting.
 *
 * A dismissed review is a verdict GitHub withdrew, so it satisfies nothing and answers nothing —
 * and while reconcile matched one as the verdict of every session launched afterwards (GY-100), a
 * candidate that collected one could never be reviewed again on the same commit: each attempt
 * settled on the same withdrawn verdict the moment it started, one session after another, while
 * the row showed nothing but the review gate's ordinary `approval is required`. Every such session
 * is counted here, with the review they settled on and the commit no verdict was ever obtained on,
 * so a status reader can name the state (`unobtainableReviewAttention`), count it apart from the
 * reviews that are genuinely running, and say it of the request instead of that ordinary wait
 * (`nameUnobtainableReviews`) rather than beside it.
 */
export interface UnobtainableReview { requestId: string; sha: string; reviewIds: number[]; sessions: number; sinceMs: number; attempts: number; resolution: string | null }
export function unobtainableReview(request: RequestProgress | null | undefined, sessions: SettledReviewSession[] = []): UnobtainableReview | null {
  if (!request?.sha) return null;
  // The judgement is made from the request alone — its session settled on a verdict GitHub
  // withdrew, and nothing is scheduled to answer it — so every reader decides the same way
  // whether or not it holds the ledger. The settled sessions only say how many there were.
  const unanswered = unansweredRequest(request, 'review');
  if (!unanswered || unanswered.verdict !== 'DISMISSED') return null;
  // Every session of this exact commit that settled on a withdrawn verdict, whichever request
  // asked for it: a re-opened request is a new id, and the commit is what cannot be reviewed.
  const settled = sessions.filter(entry => entry.sha === request.sha && entry.state !== 'pending' && entry.verdict === 'DISMISSED');
  const reviewIds = [...new Set(settled.map(entry => entry.reviewId).filter((id): id is number => typeof id === 'number' && id > 0))].sort((a, b) => a - b);
  return { requestId: request.requestId, sha: request.sha, reviewIds, sessions: Math.max(1, settled.length), sinceMs: request.sinceMs, attempts: unanswered.attempts, resolution: unanswered.resolution };
}

/**
 * The one sentence that names such a review, for a reader that owns the wording of a wait and
 * measures its own elapsed time: what the state is — nothing running, and every verdict any
 * session found already withdrawn — rather than how long an approval has been required.
 */
export function unobtainableReviewLine(key: string, review: UnobtainableReview, elapsed: (ms: number) => string) {
  const named = review.reviewIds.length ? `review ${review.reviewIds.map(id => `#${id}`).join(', ')}` : 'a review whose id the ledger did not record';
  return `${key} cannot obtain a review of ${review.sha.slice(0, 12)}: ${review.sessions} reviewer session${review.sessions === 1 ? '' : 's'} settled on ${named}, which GitHub dismissed, so no verdict has ever been obtained on that commit in ${elapsed(review.sinceMs)} over ${review.attempts} attempt${review.attempts === 1 ? '' : 's'} — ${review.resolution ?? 'no reason recorded'}. This is not a review in progress: nothing is running for the request`;
}
/**
 * Say that of the request instead of its ordinary unanswered wait, never beside it. Both lines
 * come from the same judgement over the same rows, so each replacement is one item and every total
 * stays what it was. The `requestId` the unanswered items carry for the join is dropped here; an
 * unmatched review is appended rather than lost.
 */
export function nameUnobtainableReviews<T extends { requestId?: string }, R extends { review: UnobtainableReview }>(items: T[], unobtainable: R[]): (Omit<T, 'requestId'> | Omit<R, 'review'>)[] {
  const named = new Map(unobtainable.map(item => [item.review.requestId, item])), replaced = new Set<string>();
  const strip = ({ review: _review, ...item }: R) => item;
  const rewritten = items.map(({ requestId, ...item }) => {
    const match = requestId ? named.get(requestId) : undefined;
    if (match) replaced.add(requestId!);
    return match ? strip(match) : item;
  });
  return [...rewritten, ...unobtainable.filter(item => !replaced.has(item.review.requestId)).map(strip)];
}

/** Every live request of one candidate that nothing is going to answer, review first. */
export function unansweredRequests(dispatch: { review: RequestProgress | null; producers: RequestProgress[] } | null | undefined): UnansweredRequest[] {
  if (!dispatch) return [];
  return [...(dispatch.review ? [unansweredRequest(dispatch.review, 'review')] : []), ...dispatch.producers.map(request => unansweredRequest(request, 'producer'))]
    .filter((entry): entry is UnansweredRequest => !!entry);
}
