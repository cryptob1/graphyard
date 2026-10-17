/**
 * The answer a launch's record callback resolves with when the control plane did not answer the
 * write (GY-1895): the payload stays stashed owed for the next cycle's retry (`step-budget.ts`
 * `launchWrite`), so the launch helpers treat the write as unanswered — not failed — and stop
 * retrying into a silent plane. A plain record callback never resolves it. This module imports
 * nothing, so both the model's launch helpers and the daemon's write ledger can hold it without a
 * cycle between them.
 */
export const coordinateOwed = Symbol('coordinate-write-owed');
