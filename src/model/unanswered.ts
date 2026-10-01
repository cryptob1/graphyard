/**
 * The live requests nothing is answering, as a status reader judges them from each request joined
 * onto its session and retry schedule: which are unanswered, what answers them, and which reviews
 * no session can obtain. Re-exported from model/dispatch.ts.
 */
import type { Work } from './work.js';
import type { DispatchKind, DispatchRequest } from './dispatch.js';
import { unexercisedFindings } from './mechanical-proofs.js';

/** One live request as a reader joins it onto the session launched for it and that session's retry schedule. */
export interface RequestProgress {
  requestId: string; sinceMs: number; group?: string;
  /** The head the request binds, when the reader carries it; a review reader names the commit no verdict can be obtained on. */
  sha?: string;
  /** `verdict` is the session's recorded verdict state, as a status reader summarizes it: `DISMISSED`, `APPROVED`, or null. */
  /** `settledMs` is how long ago a session that is no longer pending settled, when the reader knows. */
  session: { state: string; attempt?: number; resolution?: string | null; verdict?: string | null; settledMs?: number | null } | null;
  retry?: { attempts: number; limit: number; nextAt: string | null; exhausted: boolean } | null;
  /**
   * The decision a producer request waits on instead of another session, when its evidence on the
   * head was recorded as not exercising its criterion (GY-193 AC-3): the loop launches no producer
   * for the head again and requests rework — or, for a `manual:` proof, the attestation again.
   */
  remedy?: RequestRemedy | null;
  /** A producer request's proofs the producer recorded as not exercising their criterion on its head (GY-817), each as a rework names it. */
  unexercised?: string[];
}
export interface RequestRemedy { decision: 'rework' | 'attest'; proofs: string[] }
/** Every session one request may have in all, however each ended: the dispatch failure limit (auto-dispatch.ts). */
export const requestAttemptLimit = 12;
/**
 * GY-533. A session that settled while its request still stands is answered within moments: the
 * evidence it recorded resolves the request on the control plane's next observation, and
 * otherwise the loop relaunches the request on its next dispatch tick (GY-193) or raises the
 * decision its evidence calls for. Until this long after it settled, such a request is an answer
 * in progress, not an unanswered one.
 */
export const settledAnswerGraceMs = 5 * 60_000;
/** Sessions whose request is relaunched on the widening retry schedule (producer.ts `sessionRetry`); every other settled state is relaunched on the next tick. */
const retriedSessionStates = ['failed', 'expired'];

/** The decision a producer request waits on, or null when a session answers it (daemon/decisions.ts raises the decision). */
export function requestRemedy(work: Work, request: Pick<DispatchRequest, 'kind' | 'sha' | 'proofs'>): RequestRemedy | null {
  if (request.kind !== 'producer') return null;
  const proofs = unexercisedFindings(work, request.sha, request.proofs).map(entry => entry.proof);
  if (!proofs.length) return null;
  // An unexercised `manual:` proof is re-attested, never reworked; any other calls for the rework.
  return { decision: proofs.every(proof => proof.startsWith('manual:')) ? 'attest' : 'rework', proofs };
}
/**
 * Verdicts that answer a review request. The gate accepts one and refuses the other, and either
 * resolves the request on the next observation, so a session that posted one is not unanswered
 * while the control plane catches up. A dismissal answers nothing: GitHub withdrew it.
 */
export const answeringVerdicts = ['APPROVED', 'CHANGES_REQUESTED'];
/**
 * A live request whose session settled leaving its gate unsatisfied past the grace. `next` names
 * what answers it: the relaunch the loop owes it, the decision it waits on, or nothing at all.
 */
export interface UnansweredRequest { requestId: string; kind: DispatchKind; group?: string; sinceMs: number; state: string; verdict: string | null; attempts: number; resolution: string | null; unexercised?: string[];
  settledMs: number | null; next: UnansweredNext }
export type UnansweredNext = { kind: 'relaunch'; attempt: number; limit: number } | ({ kind: 'decision' } & RequestRemedy) | null;

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
  // GY-533: a session that settled moments ago is being answered — its evidence read, its request
  // relaunched or its decision raised — and is not a request nothing will answer.
  const settledMs = typeof session.settledMs === 'number' && Number.isFinite(session.settledMs) ? session.settledMs : null;
  if (settledMs !== null && settledMs < settledAnswerGraceMs) return null;
  const attempts = request.retry?.attempts ?? session.attempt ?? 1;
  // What answers it now: the decision its evidence calls for; else, for a session that settled
  // without failing, the relaunch the loop owes it on its next tick up to the attempt limit
  // (auto-dispatch.ts `session`); a failed or expired one has its retry schedule, which is spent.
  const next: UnansweredNext = kind === 'producer' && request.remedy ? { kind: 'decision', ...request.remedy }
    : !retriedSessionStates.includes(session.state) && attempts < requestAttemptLimit ? { kind: 'relaunch', attempt: attempts + 1, limit: requestAttemptLimit } : null;
  return { requestId: request.requestId, kind, ...(request.group ? { group: request.group } : {}), sinceMs: request.sinceMs,
    state: session.state, verdict: session.verdict ?? null, attempts, resolution: session.resolution ?? null, settledMs, next,
    ...(request.unexercised?.length ? { unexercised: request.unexercised } : {}) };
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
