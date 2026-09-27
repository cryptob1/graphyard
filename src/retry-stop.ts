import { agentOwner, type AttentionItem } from './master/attention.js';

/**
 * When a loop retry stops (GY-598).
 *
 * A 4xx is the other side saying the request itself is wrong: asking again with the same request
 * gets the same answer. A loop retry that failed with one unchanged 4xx error on
 * `repeatedClientErrorLimit` consecutive attempts is therefore stopped rather than retried every
 * cycle, and raises one attention item naming the step, the error and the item, so the condition
 * reaches somebody instead of scrolling past in the log. A different error, or one that is not a
 * 4xx, starts the count again.
 *
 * The stop belongs to the loop's unbounded retries — one repeated for as long as its condition
 * stands, as the follow-up filing that created no item is retried while its approval stands, and
 * the filing refused 84 times over as an idempotency key reuse, a request and a log line per
 * cycle, is the case this ends. A retry already bounded by an attempt cap — thread resolution's
 * `threadResolutionAttempts`, a producer session's `sessionRetryLimit` — stops by construction and
 * carries no 4xx stop, and a retry is not made unbounded without adopting this one (GY-603).
 */
export const repeatedClientErrorLimit = 10;

/** The 4xx status a failure names — `(409)`, `HTTP 422` or `status 403` — or null for any other failure. */
export function clientErrorStatus(failure: string | undefined): number | null {
  const match = failure?.match(/(?:\(|\bHTTP |\bstatus )(4\d\d)\b/);
  return match ? Number(match[1]) : null;
}

/** The unchanged 4xx error a retry has failed with, and on how many consecutive attempts. */
export interface ClientErrorRun { error: string; count: number }

/** The run after one more attempt: extended by the same 4xx error, restarted by another, ended by anything else. */
export function nextClientErrorRun(previous: ClientErrorRun | undefined, failure: string | undefined): ClientErrorRun | undefined {
  if (!failure || clientErrorStatus(failure) === null) return undefined;
  return { error: failure, count: previous?.error === failure ? previous.count + 1 : 1 };
}

/** Whether the run has reached the stop. */
export const retryStopped = (run: ClientErrorRun | undefined) => !!run && run.count >= repeatedClientErrorLimit;

/** The one attention item a stopped retry raises: the step, the error and the item, and the command that resumes it (GY-603). */
export function retryStopAttention(stop: { step: string; item: string; error: string; count: number; at: string }): AttentionItem {
  return {
    subject: stop.item,
    text: `The loop stopped retrying ${stop.step} for ${stop.item}: ${stop.count} consecutive attempts failed with the same client error, so another attempt would get the same answer — ${stop.error}`.slice(0, 1000),
    ...agentOwner('master', `Fix what the error names for ${stop.item}, then graphyard master retry-resume ${stop.item} clears the stop and the loop retries; it does not retry ${stop.step} on its own again (stopped ${stop.at})`),
  };
}
