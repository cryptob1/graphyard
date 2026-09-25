import type { Work } from './work.js';
import { reviewProviderOf } from './review.js';

/**
 * One request, one verdict (GY-124).
 *
 * A review request is answered by exactly one reviewer session and exactly one verdict. GitHub
 * keeps every review an identity posts, but reports the latest one per identity as its current
 * word, and the observation reads it the same way (github.ts keeps one review per reviewer). Two
 * verdicts from the same identity on the same head for the same request would therefore be read
 * as a sequence, the later one silently replacing the earlier — which is how an approval was
 * overturned a minute after it was posted by a second session nobody had meant to launch.
 *
 * Here two such verdicts are a conflict instead. Every verdict the control plane observes on the
 * current binding (head, base, policy revision) is recorded on the item with the request it
 * answered, so a verdict that GitHub no longer reports as the latest is still on the record. When
 * a second standing verdict from the same identity answers the same request, the item is marked
 * `conflicted` with both verdicts, the ledger records `review.conflicted`, and neither verdict is
 * acted on: both are withheld from the observation the gates read, so no approval passes the
 * review gate or is carried onto a queue tip, and no change request asks for rework. The review
 * gate then asks for an approval again, the control plane opens a fresh review request for the
 * head, and the first verdict posted after the conflict — the fresh review — resolves it and is
 * the one the gates act on.
 *
 * Only the reviewer identity's verdicts are recorded and can conflict (see `reviewerIdentity`),
 * and only two that answered the same recorded request: a person's verdicts, and verdicts that
 * answered no request, pass through to the gates exactly as GitHub reports them.
 *
 * A dismissed review is withdrawn, not given, so it is never one of the two: the relaunch that
 * follows a dismissal answers the same request afresh. A new head, base or policy revision starts
 * a new binding and supersedes a conflict on the old one.
 */

export const conflictingVerdictStates = ['APPROVED', 'CHANGES_REQUESTED'];
/**
 * The reviewer identity: a launched reviewer session posts through a GitHub App, whose account
 * GitHub names `<slug>[bot]` — a login no person can hold. Only its verdicts can conflict. A
 * person, or any identity that is not an App, reviewing a head twice is a sequence, as GitHub reads
 * it: the latest word stands and blocks or passes the gate untouched, so a change request a person
 * posted after approving is never withheld or overridden by a fresh reviewer verdict.
 */
export const reviewerIdentity = (login: string) => /\[bot\]$/i.test(login);
/** Verdicts kept per binding; a head collecting more than this is already conflicted many times over. */
export const verdictHistoryLimit = 20;

export interface ObservedVerdict {
  id: number; reviewer: string; state: string; submittedAt: string | null; observedAt: string;
  /** The review request the verdict answered: the live one when it was observed, else the latest one for the head. */
  requestId: string | null;
  /** GitHub dismissed it: withdrawn, never a verdict that conflicts. */
  dismissed?: boolean;
  /** One of a conflict a fresh review resolved: kept on the record, never acted on. */
  superseded?: boolean;
}
export interface ReviewVerdicts { sha: string; baseSha: string; policyRevision: number; verdicts: ObservedVerdict[] }
export interface ReviewConflict {
  state: 'conflicted' | 'resolved' | 'superseded';
  key: string; pr: number; sha: string; baseSha: string; policyRevision: number;
  reviewer: string; requestId: string | null;
  /** Every standing verdict the identity posted on the head for the request, oldest first. */
  verdicts: ObservedVerdict[];
  at: string; reason: string;
  resolvedAt?: string; resolution?: string;
  /** The fresh review that resolved the conflict; the gates act on it alone. */
  resolvedBy?: ObservedVerdict;
}
export interface ReviewConflictTransition { event: 'review.conflicted' | 'review.conflict-resolved' | 'review.conflict-superseded'; conflict: ReviewConflict }

declare module './work.js' { interface Work { reviewVerdicts?: ReviewVerdicts | null; reviewConflict?: ReviewConflict | null } }

const short = (sha: string) => sha.slice(0, 12);
const describe = (verdict: ObservedVerdict) => `${verdict.state} (review ${verdict.id}${verdict.submittedAt ? ` at ${verdict.submittedAt}` : ''})`;
const binds = (binding: Pick<ReviewVerdicts, 'sha' | 'baseSha' | 'policyRevision'>, work: Work) =>
  !!work.candidate && binding.sha === work.candidate.sha && binding.baseSha === work.candidate.baseSha && binding.policyRevision === work.policyRevision;

/** The request a verdict observed now answers: the live review request, else the newest one recorded for the head. */
function answeredRequest(work: Work): string | null {
  const state = work.autoDispatch, sha = work.candidate!.sha;
  if (state?.review && state.review.sha === sha) return state.review.id;
  return state?.history.filter(request => request.kind === 'review' && request.sha === sha).at(-1)?.id ?? null;
}

/** Whether the item's conflict stands: two verdicts on the current head, neither acted on. */
export function openReviewConflict(work: Pick<Work, 'reviewConflict'>): ReviewConflict | null {
  return work.reviewConflict?.state === 'conflicted' ? work.reviewConflict : null;
}

/**
 * Record the verdicts the current observation carries, raise or resolve the conflict, and withhold
 * every conflicting verdict from the observation the gates read. Idempotent: re-evaluating the
 * same observation changes nothing. Returns the transitions for the ledger.
 */
export function reconcileReviewConflict(work: Work, now: Date): ReviewConflictTransition[] {
  const transitions: ReviewConflictTransition[] = [];
  const at = now.toISOString();
  const candidate = work.candidate, observation = work.observation;
  const current = !!candidate && !!observation && observation.candidate.sha === candidate.sha && observation.candidate.baseSha === candidate.baseSha;
  const open = openReviewConflict(work);
  // A new head, base or policy revision is a new request altogether: the conflict on the old
  // binding answers nothing about it, and is closed with the reason.
  if (open && (!current || !binds(open, work))) {
    work.reviewConflict = { ...open, state: 'superseded', resolvedAt: at,
      resolution: !candidate ? 'the item no longer has a candidate' : candidate.sha !== open.sha ? `head changed from ${short(open.sha)} to ${short(candidate.sha)}` : candidate.baseSha !== open.baseSha ? `base changed from ${short(open.baseSha)} to ${short(candidate.baseSha)}` : `policy revision changed from ${open.policyRevision} to ${work.policyRevision}` };
    transitions.push({ event: 'review.conflict-superseded', conflict: work.reviewConflict });
  }
  if (!current || reviewProviderOf(work.policy) !== 'github') return transitions;
  const record: ReviewVerdicts = work.reviewVerdicts && binds(work.reviewVerdicts, work) ? work.reviewVerdicts
    : { sha: candidate!.sha, baseSha: candidate!.baseSha, policyRevision: work.policyRevision, verdicts: [] };
  const requestId = answeredRequest(work);
  for (const review of observation!.reviews) {
    if (review.sha !== candidate!.sha || !Number.isSafeInteger(review.id)) continue;
    const known = record.verdicts.find(verdict => verdict.id === review.id);
    if (review.state === 'DISMISSED') { if (known) known.dismissed = true; continue; }
    if (!conflictingVerdictStates.includes(review.state) || known || !reviewerIdentity(review.reviewer)) continue;
    record.verdicts.push({ id: review.id!, reviewer: review.reviewer, state: review.state, submittedAt: review.submittedAt ?? null, observedAt: at, requestId });
  }
  record.verdicts = record.verdicts.slice(-verdictHistoryLimit);
  work.reviewVerdicts = record;
  const standing = record.verdicts.filter(verdict => !verdict.dismissed && !verdict.superseded && reviewerIdentity(verdict.reviewer));
  const conflict = openReviewConflict(work);
  if (conflict) {
    // The fresh review: the first standing verdict on the head that is not one of the conflict.
    const fresh = standing.find(verdict => !conflict.verdicts.some(entry => entry.id === verdict.id));
    if (fresh) {
      for (const verdict of record.verdicts) if (conflict.verdicts.some(entry => entry.id === verdict.id)) verdict.superseded = true;
      work.reviewConflict = { ...conflict, state: 'resolved', resolvedAt: at, resolvedBy: fresh,
        resolution: `a fresh review of ${short(conflict.sha)} by ${fresh.reviewer}, ${describe(fresh)}, resolved the conflict; the gates act on it alone` };
      transitions.push({ event: 'review.conflict-resolved', conflict: work.reviewConflict });
    }
  } else {
    // Only verdicts that answered a recorded review request can be two answers to one request.
    const groups = new Map<string, ObservedVerdict[]>();
    for (const verdict of standing) {
      if (!verdict.requestId) continue;
      const key = `${verdict.reviewer.toLowerCase()}\0${verdict.requestId}`;
      groups.set(key, [...(groups.get(key) ?? []), verdict]);
    }
    const pair = [...groups.values()].find(group => group.length > 1);
    if (pair) {
      work.reviewConflict = { state: 'conflicted', key: work.key, pr: candidate!.pr, sha: candidate!.sha, baseSha: candidate!.baseSha, policyRevision: work.policyRevision,
        reviewer: pair[0].reviewer, requestId: pair[0].requestId, verdicts: pair, at,
        reason: `${pair[0].reviewer} posted ${pair.length} verdicts on ${short(candidate!.sha)} for ${pair[0].requestId ? `review request ${pair[0].requestId}` : 'one review'}: ${pair.map(describe).join(', then ')}. One request yields one verdict, so neither is acted on until a fresh review of the head resolves it` };
      transitions.push({ event: 'review.conflicted', conflict: work.reviewConflict });
    }
  }
  // Withhold every conflicting verdict from the observation the gates, the dispatcher and the
  // rework decision read: the record above keeps them, nothing downstream acts on them.
  const withheld = new Set(record.verdicts.filter(verdict => verdict.superseded || openReviewConflict(work)?.verdicts.some(entry => entry.id === verdict.id)).map(verdict => verdict.id));
  if (withheld.size && observation!.reviews.some(review => review.id !== undefined && withheld.has(review.id))) observation!.reviews = observation!.reviews.filter(review => review.id === undefined || !withheld.has(review.id));
  return transitions;
}

/**
 * The attention line for every item whose review request is conflicted: the item, the head, both
 * verdicts and the sessions that posted them, read from the reviewer ledger by review id (a
 * session the ledger has no record of is named as such — that is the launcher fault itself).
 */
export function reviewConflictAttention(work: Pick<Work, 'key' | 'reviewConflict'>[], records: { id: string; agentName: string; profile: string; requestId?: string; verdict?: { reviewId: number } }[]): { subject: string; text: string; next: string }[] {
  return work.flatMap(item => {
    const conflict = openReviewConflict(item);
    if (!conflict) return [];
    const session = (verdict: ObservedVerdict) => {
      const record = records.find(entry => entry.verdict?.reviewId === verdict.id);
      return `${describe(verdict)} from ${record ? `session ${record.agentName} (${record.profile}, record ${record.id.slice(0, 8)})` : 'a session the reviewer ledger has no record of'}`;
    };
    return [{ subject: item.key, text: `Review of ${item.key} head ${short(conflict.sha)} (PR #${conflict.pr}) is conflicted: ${conflict.reviewer} posted ${conflict.verdicts.map(session).join(' and ')}${conflict.requestId ? ` for request ${conflict.requestId}` : ''}. Neither verdict is acted on — no rework, no approval, no carry — until a fresh review of the head resolves it`,
      next: `Nothing to run by hand: the control plane requests a fresh review of ${short(conflict.sha)} and the loop launches it; once the loop stops relaunching it (its session settled unanswered or its attempts are spent), graphyard master review ${item.key}` }];
  });
}
