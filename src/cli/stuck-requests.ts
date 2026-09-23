import { agentOwner, type AttentionItem } from '../master.js';
import { stuckRequestLine, stuckRequests, type StuckRequest } from '../request-settlement.js';

/**
 * What `master status` says about a reviewer or producer request that is pending past its token's
 * expiry, or holding a failure to close its pane (GY-137). Such a request refuses every later
 * launch for its item, and before this it showed only as that refusal, at the next launch: the
 * reconcile counters said nothing. Status reconciles the ledgers first, so what is still pending
 * here is genuinely stuck, and it is counted under `dispatch.sessionReconcile.stuck` and raised.
 */
export function stuckRequestReport(records: Parameters<typeof stuckRequests>[0], now: number): { stuck: StuckRequest[]; attentionItems: AttentionItem[] } {
  const stuck = stuckRequests(records, now);
  return { stuck, attentionItems: stuck.map(stuckRequestLine).map(line => ({ subject: line.subject, text: line.text, ...agentOwner('master', line.next) })) };
}

/** The dispatcher summary with the stuck requests counted beside the sweep's own counters. */
export function withStuckRequests<T extends object>(dispatch: T, stuck: StuckRequest[]): T {
  if (!('sessionReconcile' in dispatch)) return dispatch;
  return { ...dispatch, sessionReconcile: { ...(dispatch.sessionReconcile as object), stuck: stuck.length,
    stuckRequests: stuck.map(entry => ({ role: entry.role, work: entry.key, request: entry.request, record: entry.record, since: entry.since, stuckMs: entry.stuckMs, expired: entry.expired, closeFailure: entry.closeFailure })) } };
}
