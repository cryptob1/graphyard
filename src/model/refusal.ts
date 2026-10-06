import type { Principal } from './work.js';

// Refusals carry the HTTP status a route answers with; the reconciliation variants tell
// callers that the same command may succeed once the current state is re-read.

export class Refusal extends Error {
  /** `details` travel beside `error` in the response body, so a caller reads them without parsing the prose. */
  constructor(message: string, public status = 409, public details?: Record<string, unknown>) { super(message); }
}
/**
 * A control-plane response a client was refused, keeping the response body: a caller reads its
 * structured fields (such as `standingRefusal`) rather than matching the message's wording (GY-265).
 */
export class RefusedResponse extends Error {
  constructor(message: string, public status: number, public body: unknown) { super(message); }
}
export class ReconciliationRetry extends Refusal {}
/** GitHub refused a merge Graphyard asked for because it conflicts (409). */
export class MergeConflict extends Refusal {}
export function requireCurrent(value: unknown, message: string): asserts value {
  if (!value) throw new ReconciliationRetry(message, 409);
}
export function demand(value: unknown, message: string, status = 409): asserts value {
  if (!value) throw new Refusal(message, status);
}
/**
 * The machine-readable code on the refusal of a command against a work item the server does not
 * have (GY-448). A bare 404 can come from a mis-routed proxy during a deploy, so a client treats it
 * as transient; one carrying this code is the control plane's own answer that the item is gone.
 */
export const unknownWorkCode = 'work-not-found';
export function demandWork<T>(work: T | undefined | null): asserts work is T {
  if (!work) throw new Refusal('Work item not found', 404, { code: unknownWorkCode });
}
export function admin(actor: Principal) { demand(actor.role === 'admin', 'Operator permission required', 403); }
/**
 * GY-1344. Whether a failed request met a control plane that did not answer it at all, rather than
 * one that judged it: a proxy's 502-504 in place of the server's own refusal (Railway's 502
 * "Application failed to respond" carries no `error` field), a refused or reset connection, or the
 * request's own timeout. Between 01:39 and 02:01Z on 6 October 2026 the plane answered nothing, and
 * the loop counted each consequence — a diagnosis decide, a class filing, the dispatcher's ticks, a
 * cycle's 30s waits — as a loop fault of its own. One outage is one condition: what met it is
 * retried, and only the outage itself is a fault.
 */
const planeSilence = /Application failed to respond|ECONNREFUSED|ECONNRESET|socket hang up|(?<!git )fetch failed|operation was aborted due to timeout|\b50[234] (?:Bad Gateway|Service Unavailable|Gateway Time-?out)\b/i;
export const planeUnavailableText = (text: string | null | undefined) => !!text && planeSilence.test(text);
export function planeUnavailable(error: unknown): boolean {
  if (error instanceof RefusedResponse) return error.status >= 502 && error.status <= 504 && !(error.body && typeof (error.body as { error?: unknown }).error === 'string');
  if ((error as { name?: unknown } | null)?.name === 'TimeoutError') return true;
  return planeUnavailableText(error instanceof Error ? error.message : typeof error === 'string' ? error : null);
}
