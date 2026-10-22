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
/**
 * The structural read of a refusal's status and body, shared by every client that keeps both
 * (GY-1895): a 502-504 whose body carries no `error` field of its own is the plane not answering —
 * a proxy answered in the server's place, and Railway's 502 body names `message`, not `error` —
 * while an answer the server judged itself (its own `error` string) is the item's.
 */
export function planeUnavailableStatus(status: unknown, body: unknown): boolean {
  return typeof status === 'number' && status >= 502 && status <= 504 && !(body && typeof (body as { error?: unknown }).error === 'string');
}
export function planeUnavailable(error: unknown): boolean {
  if (error instanceof RefusedResponse) return planeUnavailableStatus(error.status, error.body);
  if ((error as { name?: unknown } | null)?.name === 'TimeoutError') return true;
  return planeUnavailableText(error instanceof Error ? error.message : typeof error === 'string' ? error : null);
}

// A memory failure is the control plane's only when it names the server: a worker's own build or
// test running out of memory is about the item, not the plane.
const planeMemory = String.raw`\b(?:server|postgres(?:ql)?|database|control plane)\b[^.\n]*\b(?:out of memory|ENOMEM)\b|\b(?:out of memory|ENOMEM)\b[^.\n]*\b(?:on|in|from|at) (?:the )?(?:graphyard )?(?:server|postgres(?:ql)?|database|control plane)\b`;
const planeWideShape = new RegExp(String.raw`\bHTTP 50[234]\b|\(50[234]\)|\b50[234] (?:Bad Gateway|Service Unavailable|Gateway)|"(?:status|code)":\s*50[234]\b|ECONNREFUSED|ECONNRESET|socket hang up|(?<!git )fetch failed|Application failed to respond|server (?:is )?(?:down|unavailable|unreachable)|${planeMemory}`, 'i');
// A server call that ran into its own timeout: while the plane is slow, every call does.
const serverCallTimeout = /\bThe operation was aborted due to timeout\b/;
// GY-1375: the server's own 503 while it is restarting (src/server/main.ts, GY-1127).
const startupReadiness = /\bStartup validation has not completed\b/;
/**
 * Whether a failure is the control plane's as a whole (GY-1345): down, unreachable or overloaded, the
 * server out of memory, its startup-readiness 503 (GY-1375), or a server call that ran into its own
 * timeout. The loop rides such a window out and retries; it is no failure of the step that met it.
 */
export const planeWideFailure = (text: string | null | undefined) => !!text && (planeWideShape.test(text) || serverCallTimeout.test(text) || startupReadiness.test(text));
/** Whether a thrown failure is plane-wide: a refusal that keeps its status and body is read structurally (GY-1344, GY-1895), anything else from its text. */
export const planeWideRefusal = (error: unknown) => {
  if (error instanceof RefusedResponse) return planeUnavailable(error) || startupReadiness.test(error.message);
  const structural = error as { status?: unknown; body?: unknown } | null;
  if (structural && typeof structural.status === 'number' && structural.body !== undefined && planeUnavailableStatus(structural.status, structural.body)) return true;
  return planeWideFailure(error instanceof Error ? error.message : typeof error === 'string' ? error : null);
};
/**
 * Whether a failure is the deploy's own release-skew window (GY-2177): the refusal a CLI behind the
 * served release throws (src/cli/context.ts `versionSkewMessage`) until the loop realigns its held
 * CLI (GY-2169). The loop rides it out like a plane-wide failure.
 */
export const deploySkewFailure = (failure: string | null | undefined) =>
  !!failure && /\bCLI [^\n]* and server [^\n]* differ: run graphyard upgrade/.test(failure);
