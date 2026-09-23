import { agentOwner, type AttentionItem } from '../master.js';
import { elapsed } from '../model/sessions.js';
import { unansweredRequests, unobtainableReview, unobtainableReviewLine, type RequestProgress, type SettledReviewSession, type UnansweredRequest, type UnobtainableReview } from '../model/dispatch.js';

/** Who answers a request whose session settled unanswered, and with which command. */
export function unansweredRequestOwner(key: string, request: Pick<UnansweredRequest, 'kind'>) {
  return request.kind === 'review'
    ? agentOwner('master', `graphyard master review ${key} [PROFILE] forces the next attempt for the open request`)
    : agentOwner('master', `graphyard master decide ${key} rework REASON, approved by the approver agent, so the group's proofs are requested afresh on the next head`, 'approver');
}

/**
 * One attention item per live request whose session settled without satisfying its gate. Such a
 * request is the one state `master status` used to show as nothing at all: no session running, no
 * launch refused, no failure — just a `sinceMs` climbing past the hour while the gate goes on
 * refusing. It is named here with the verdict that settled the session, how long the request has
 * stood, and the command that gets it answered, and counted apart from the requests with a
 * session actually running (`counts.dispatchRunning`).
 */
export function unansweredRequestAttention(rows: { key: string; dispatch: { review: RequestProgress | null; producers: RequestProgress[] } | null }[]): (AttentionItem & { requestId: string })[] {
  return rows.flatMap(row => unansweredRequests(row.dispatch).map(request => {
    const subject = request.kind === 'review' ? 'Review request' : `Producer request for ${request.group ?? 'its'} proofs`;
    const verdict = request.verdict ? `with verdict ${request.verdict}` : 'without a verdict';
    return { subject: row.key, requestId: request.requestId, text: `${subject} for ${row.key} has stood unanswered for ${elapsed(request.sinceMs)}: its session ${request.state} ${verdict} after attempt ${request.attempts} — ${request.resolution ?? 'no reason recorded'}; nothing is running for it and no further attempt is scheduled`,
      ...unansweredRequestOwner(row.key, request) };
  }));
}

/**
 * One attention item per candidate that cannot obtain a review of its commit (`unobtainableReview`
 * decides which; GY-100): the review GitHub dismissed, how many sessions settled on it, the commit
 * no verdict was ever obtained on, and the command that launches the next attempt. Counted in
 * `counts.dispatchUnobtainableReview`, apart from the reviews genuinely running.
 */
export function unobtainableReviewAttention(rows: { key: string; dispatch: { review: RequestProgress | null; producers: RequestProgress[] } | null }[], settled: SettledReviewSession[]): (AttentionItem & { review: UnobtainableReview })[] {
  return rows.flatMap(row => {
    const review = unobtainableReview(row.dispatch?.review, settled);
    return review ? [{ subject: row.key, review, text: unobtainableReviewLine(row.key, review, elapsed), ...unansweredRequestOwner(row.key, { kind: 'review' }) }] : [];
  });
}
