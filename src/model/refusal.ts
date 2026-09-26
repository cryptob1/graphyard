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
export class SpeculativeConflict extends Refusal {}
export function requireCurrent(value: unknown, message: string): asserts value {
  if (!value) throw new ReconciliationRetry(message, 409);
}
export function demand(value: unknown, message: string, status = 409): asserts value {
  if (!value) throw new Refusal(message, status);
}
export function admin(actor: Principal) { demand(actor.role === 'admin', 'Operator permission required', 403); }
