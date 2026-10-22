

/**
 * When a loop retry stops (GY-598).
 *
 * A 4xx is the other side saying the request itself is wrong: asking again with the same request
 * gets the same answer. A loop retry that failed with one unchanged 4xx error on
 * `repeatedClientErrorLimit` consecutive attempts is therefore stopped rather than retried every
 * cycle — the follow-up filing refused 84 times over as an idempotency key reuse, a request and a
 * log line per cycle, is the case this ends — and raises one attention item naming the step, the
 * error and the item, so the condition reaches somebody instead of scrolling past in the log.
 * A different error, or one that is not a 4xx, starts the count again.
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
