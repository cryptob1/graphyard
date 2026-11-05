import type { Work } from '../model/work.js';
import { type ProductReviewState, short, type DispatchTransition, type AutoDispatch, type DispatchRequest, dispatchHistoryLimit, binds, reviewNeed } from '../model/dispatch.js';
import { needsProductReview } from '../model/product-review.js';
import { standingProductReview } from './product-review.js';
import { createHash } from 'node:crypto';
import { dispatchIneligibility, automatableOutcomes, producerGroupDecisions } from '../model/mechanical-proofs.js';
export function productReviewNeed(work: Work): { needed: boolean; reason: string; state: ProductReviewState } {
  if (!needsProductReview(work)) return { needed: false, state: 'not-required', reason: `${work.type} items and items without an e2e: proof owe no product review` };
  const candidate = work.candidate, observation = work.observation;
  if (observation?.source !== 'control-plane' || !candidate || !observation || observation.candidate.sha !== candidate.sha || observation.candidate.baseSha !== candidate.baseSha)
    return { needed: false, state: 'not-required', reason: 'a product review launches for a head the control plane observed itself' };
  const standing = standingProductReview(work);
  if (standing?.review.verdict === 'approved') return standing.carried
    ? { needed: false, state: 'carried', reason: `product review of ${short(standing.review.sha)} carried: only non-UI files changed since` }
    : { needed: false, state: 'approved', reason: `product approved ${short(candidate.sha)}` };
  if (standing) return { needed: false, state: standing.review.verdict, reason: `product review ${standing.review.verdict === 'changes-requested' ? 'requested changes' : 'rejected'} on ${short(candidate.sha)}; ${standing.review.verdict === 'changes-requested' ? 'the next head is reviewed afresh' : 'the item is owed to the master'}` };
  return { needed: true, state: 'required', reason: `product review of ${short(candidate.sha)} is required before this user-facing feature merges` };
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
    if (state.product) { resolve(state.product, 'cancelled', ineligible); state.product = null; }
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
    // Product review (GY-2989): one live request per head, raised beside the code review's. A
    // verdict on the head resolves it; a carried approval satisfies it; a change request or a
    // reject cancels it — no session is asked for a head those verdicts have already answered.
    if (state.product && !binds(state.product, work)) { resolve(state.product, 'cancelled', staleReason(state.product)); state.product = null; }
    const productNeed = productReviewNeed(work);
    if (state.product && !productNeed.needed) {
      resolve(state.product, productNeed.state === 'approved' || productNeed.state === 'carried' ? 'satisfied' : 'cancelled', productNeed.reason);
      state.product = null;
    }
    if (!state.product && productNeed.needed) state.product = open({ kind: 'product', sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: work.policyRevision, pr: candidate.pr, reason: productNeed.reason });
    // GY-1528: a control-plane candidate's proofs are judged by the merge writer's trial, so no
    // producer is asked for it and a request standing from before is withdrawn.
    if (work.observation?.source === 'control-plane') {
      for (const request of state.producers) resolve(request, 'cancelled', 'the control plane is the merge writer: its trial judges the proofs, so no producer is asked');
      state.producers = [];
      work.autoDispatch = state;
      return transitions;
    }
    // Producers: one live request per proof group with something left to prove. A head whose
    // trusted evidence already failed is not asked for again; the master routes that finding.
    const outcomes = automatableOutcomes(work, all, now);
    const decisions = producerGroupDecisions(work, all, now, outcomes);
    const kept: DispatchRequest[] = [];
    // A retained request answers to its whole group's decision, not only the proofs it named: a
    // sibling proof that failed since makes the group `failed`, and the planner returns the head.
    for (const request of state.producers) {
      if (!binds(request, work)) { resolve(request, 'cancelled', staleReason(request)); continue; }
      const decision = decisions.find(entry => entry.group === request.group);
      const mine = outcomes.filter(entry => request.proofs!.includes(entry.proof));
      if (decision?.state === 'failed') resolve(request, 'satisfied', `trusted evidence failed for ${decision.failed.map(entry => `${entry.proof} (${entry.producer})`).join(', ')}; the next head is requested afresh`);
      else if (decision?.state === 'request' && mine.some(entry => entry.outcome === 'unproven')) kept.push(request);
      else resolve(request, 'satisfied', `trusted passing evidence binds every proof: ${mine.map(entry => `${entry.proof} (${entry.producer})`).join(', ')}`);
    }
    state.producers = kept;
    // Proofs gate nothing under GitHub delivery, so no producer request is opened for them.
  }
  work.autoDispatch = state;
  return transitions;
}
