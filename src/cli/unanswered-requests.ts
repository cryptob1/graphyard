import { agentOwner, type AttentionItem } from '../master.js';
import { elapsed } from '../model/sessions.js';
import { classified } from '../model/fault-classes.js';
import { unansweredRequests, unobtainableReview, unobtainableReviewLine, type RequestProgress, type SettledReviewSession, type UnansweredRequest, type UnobtainableReview } from '../model/dispatch.js';

/** Who answers a request whose session settled unanswered, and with which command. */
export function unansweredRequestOwner(key: string, request: Pick<UnansweredRequest, 'kind'>) {
  return request.kind === 'review'
    ? agentOwner('master', `graphyard master review ${key} [PROFILE] forces the next attempt for the open request`)
    : agentOwner('master', `graphyard master decide ${key} rework REASON, approved by the approver agent, so the group's proofs are requested afresh on the next head`, 'approver');
}

/** Who owes the decision a producer request waits on (GY-533), and with which command. */
export function requestRemedyOwner(key: string, remedy: { decision: 'rework' | 'attest'; proofs: string[] }) {
  return agentOwner('master', `graphyard master decide ${key} ${remedy.decision} ${remedy.decision === 'attest' ? `{"proof":"${remedy.proofs[0]}"} ` : ''}REASON, then graphyard master approver ${key} DECISION — the loop raises it itself; this is the command when its decision stalls`, 'approver');
}

/**
 * One attention item per live request whose session settled without satisfying its gate. Such a
 * request is the one state `master status` used to show as nothing at all: no session running, no
 * launch refused, no failure — just a `sinceMs` climbing past the hour while the gate goes on
 * refusing. It is named here with the verdict that settled the session, how long the request has
 * stood, and the command that gets it answered, and counted apart from the requests with a
 * session actually running (`counts.dispatchRunning`).
 *
 * GY-533: a session that settled within `settledAnswerGraceMs` is not named at all — its evidence
 * resolves the request, or the loop relaunches it, within moments — and past that the line names
 * what answers the request instead of claiming nothing will: the relaunch the loop owes it, or,
 * for evidence recorded as not exercising its criterion, the decision the request waits on, which
 * is a decision fault (`request-remedy`) rather than a session that stopped.
 */
export function unansweredRequestAttention(rows: { key: string; dispatch: { review: RequestProgress | null; producers: RequestProgress[] } | null }[]): (AttentionItem & { requestId: string })[] {
  return rows.flatMap(row => unansweredRequests(row.dispatch).map(request => {
    const subject = request.kind === 'review' ? 'Review request' : `Producer request for ${request.group ?? 'its'} proofs`;
    const verdict = request.verdict ? `with verdict ${request.verdict}` : 'without a verdict';
    const settled = `its session ${request.state} ${verdict} after attempt ${request.attempts} — ${request.resolution ?? 'no reason recorded'}`;
    const next = request.next;
    // Once the reader knows how long ago the session settled — so the grace has been measured —
    // the decision its evidence calls for is the named answer, not an unanswered request.
    if (next?.kind === 'decision' && request.settledMs !== null) return { subject: row.key, requestId: request.requestId, ...classified('request-remedy'),
      text: `${subject} for ${row.key} awaits the ${next.decision} decision its evidence calls for, ${elapsed(request.sinceMs)} after it was requested: ${settled}; ${next.proofs.join(', ')} ${next.proofs.length === 1 ? 'was' : 'were'} recorded as not exercising ${next.proofs.length === 1 ? 'its criterion' : 'their criteria'} on this head, so no producer is launched for it again and the loop raises the ${next.decision} decision instead`,
      ...requestRemedyOwner(row.key, next) };
    // A producer that recorded its proofs as not exercising their criterion answered the request
    // with a finding (GY-817): the head awaits rework, which the loop requests as it does for a
    // failing proof, and no producer is launched for it again.
    if (request.unexercised?.length) return { subject: row.key, requestId: request.requestId, kind: 'nonexercising-proof' as const,
      text: `${row.key} is awaiting rework for a non-exercising proof: ${request.unexercised.join('; ')}. The ${request.group ?? 'producer'} proofs are a defect of the candidate's tests, as a failing proof is; the loop requests the rework decision and the next head is proven afresh`,
      ...agentOwner('master', `the loop requests the rework decision for ${row.key}, approved by the approver agent; graphyard master decide ${row.key} rework REASON only when the loop cannot`, 'approver') };
    const scheduled = next?.kind === 'relaunch'
      ? `nothing is running for it, and attempt ${next.attempt} of ${next.limit} has been due on the loop's next dispatch tick since the session settled${request.settledMs === null ? '' : ` ${elapsed(request.settledMs)} ago`}`
      : 'nothing is running for it and no further attempt is scheduled';
    return { subject: row.key, requestId: request.requestId, text: `${subject} for ${row.key} has stood unanswered for ${elapsed(request.sinceMs)}: ${settled}; ${scheduled}`,
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
