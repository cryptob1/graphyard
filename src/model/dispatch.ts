import { createHash } from 'node:crypto';
import type { Work } from './work.js';
import { exactApproval, reviewProviderOf } from './review.js';
import { carriedApproval } from './carry.js';
import { currentEvidence } from './evidence.js';
import { requiredProofs } from './bootstrap.js';

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
/** One producer session runs one group: every automatable proof of one kind, on one head. */
export const producerGroups = ['unit', 'integration', 'manual'] as const;
export type ProducerGroup = typeof producerGroups[number];

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

/** A proof a launched producer session can run: every unit and integration proof, and a manual proof the item marks producer-runnable. */
export const automatableProof = (work: Pick<Work, 'producerProofs'>, proof: string) =>
  /^(unit|integration):/.test(proof) || proof.startsWith('manual:') && (work.producerProofs ?? []).includes(proof);
export const producerGroupOf = (proof: string): ProducerGroup => proof.slice(0, proof.indexOf(':')) as ProducerGroup;

const short = (sha: string) => sha.slice(0, 12);
const binds = (request: Pick<DispatchRequest, 'sha' | 'baseSha' | 'policyRevision'>, work: Work) =>
  !!work.candidate && request.sha === work.candidate.sha && request.baseSha === work.candidate.baseSha && request.policyRevision === work.policyRevision;

/** Why no request may stand for the candidate right now, or null when the head is a live, observed, buildable candidate. */
export function dispatchIneligibility(work: Work): string | null {
  if (work.stage === 'done') return 'the work is delivered';
  if (work.observation?.merged) return 'the pull request is merged';
  if (!work.submission) return 'no candidate is submitted';
  if (work.reworkRequested) return 'rework was requested; the next submitted candidate is requested afresh';
  const candidate = work.candidate, observation = work.observation;
  if (!candidate || !observation || observation.candidate.sha !== candidate.sha || observation.candidate.baseSha !== candidate.baseSha) return 'the candidate has not been independently observed';
  if (observation.prState === 'closed') return 'the pull request is closed';
  if (observation.draft) return 'the pull request is a draft';
  const build = work.gates.find(gate => gate.name === 'build');
  if (build && !build.passed) return `the build gate refuses: ${build.reasons[0]}`;
  return null;
}

/** Whether the current head needs a launched reviewer, with the reason either way. */
export function reviewNeed(work: Work): { needed: boolean; reason: string } {
  if (!work.policy.review) return { needed: false, reason: 'the policy requires no independent review' };
  const provider = reviewProviderOf(work.policy);
  if (provider !== 'github') return { needed: false, reason: `the control plane dispatches ${provider} review through GitHub itself` };
  const approval = exactApproval(work);
  if (approval) return { needed: false, reason: `approved by ${approval.reviewer} on ${short(approval.sha)}` };
  const carried = carriedApproval(work);
  if (carried) return { needed: false, reason: `approval of ${short(carried.originalSha)} by ${carried.reviewer} carried to this head` };
  const candidate = work.candidate!, observation = work.observation!;
  const changes = observation.reviews.find(review => review.sha === candidate.sha && review.state === 'CHANGES_REQUESTED');
  if (changes) return { needed: false, reason: `${changes.reviewer} requested changes on ${short(candidate.sha)}; the next head is reviewed afresh` };
  if (observation.baseTipContained === false) return { needed: false, reason: `head ${short(candidate.sha)} does not contain the base tip ${short(observation.baseTip ?? '')}; a review of it would be dismissed when GitHub recomputes the merge base` };
  return { needed: true, reason: `independent approval of ${short(candidate.sha)} against ${short(candidate.baseSha)} under policy revision ${work.policyRevision} is required` };
}

export type ProofOutcome = 'proven' | 'unproven' | 'failed';
/** Every automatable required proof with what the trusted evidence bound to this head says about it. */
export function automatableOutcomes(work: Work, all: Work[], now: Date): { proof: string; group: ProducerGroup; outcome: ProofOutcome; producer?: string }[] {
  return requiredProofs(work, all).filter(proof => automatableProof(work, proof)).map(proof => {
    const evidence = currentEvidence(work, proof, now);
    const outcome: ProofOutcome = !evidence ? 'unproven' : evidence.result === 'pass' && evidence.executed > 0 && evidence.skipped === 0 ? 'proven' : 'failed';
    return { proof, group: producerGroupOf(proof), outcome, ...(evidence ? { producer: evidence.producer } : {}) };
  });
}

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
    const need = reviewNeed(work);
    if (state.review && !need.needed) { resolve(state.review, 'satisfied', need.reason); state.review = null; }
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
    for (const group of producerGroups) {
      if (state.producers.some(request => request.group === group)) continue;
      const mine = outcomes.filter(entry => entry.group === group);
      if (!mine.length || mine.some(entry => entry.outcome === 'failed') || !mine.some(entry => entry.outcome === 'unproven')) continue;
      state.producers.push(open({ kind: 'producer', group, proofs: mine.filter(entry => entry.outcome === 'unproven').map(entry => entry.proof), sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: work.policyRevision, pr: candidate.pr,
        reason: `no trusted evidence binds ${short(candidate.sha)} for ${mine.filter(entry => entry.outcome === 'unproven').map(entry => entry.proof).join(', ')}` }));
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

/** Every live request of one candidate that nothing is going to answer, review first. */
export function unansweredRequests(dispatch: { review: RequestProgress | null; producers: RequestProgress[] } | null | undefined): UnansweredRequest[] {
  if (!dispatch) return [];
  return [...(dispatch.review ? [unansweredRequest(dispatch.review, 'review')] : []), ...dispatch.producers.map(request => unansweredRequest(request, 'producer'))]
    .filter((entry): entry is UnansweredRequest => !!entry);
}
