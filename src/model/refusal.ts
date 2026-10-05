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
