import type { Principal } from './work.js';

// Refusals carry the HTTP status a route answers with; the reconciliation variants tell
// callers that the same command may succeed once the current state is re-read.

export class Refusal extends Error {
  constructor(message: string, public status = 409) { super(message); }
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
