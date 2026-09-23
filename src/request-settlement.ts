import { elapsed, sessionReconcileIntervalMs } from './model/sessions.js';

/**
 * Settling a reviewer or producer request whose session is over (GY-137).
 *
 * Settlement closes the session's pane first, and a request stays pending until it can. Two ways
 * that left a request pending for good, and a pending request refuses every later launch for its
 * item: the pane was already gone — Herdr answers the close with `pane_not_found`, the very state
 * the close wanted, reached by somebody else (a master tidying finished panes by hand, or the
 * runtime exiting) — and a token that expired while its pane could not be closed. The rules here
 * are what the reconcilers in `reviewer.ts` and `producer.ts` apply, and what `master status`
 * raises when a request is pending anyway.
 */

/** An absent pane satisfies the close: the settlement names it on the resolution, and records no failure. Any other close failure is still one. */
export const paneAbsentCode = 'pane_not_found';
export function paneAlreadyGone(error: unknown): boolean {
  if ((error as { herdrCode?: unknown } | null)?.herdrCode === paneAbsentCode) return true;
  return error instanceof Error && error.message.includes(paneAbsentCode);
}
export const paneGoneNote = (pane: string) => `pane ${pane} was already gone when the session was closed, so there was nothing left to close`;
/** A resolution with the absent pane named after it, within the ledgers' resolution bound; the resolution is shortened, never the note. */
export function withPaneGone(resolution: string | undefined, pane: string, max = 900) {
  const note = paneGoneNote(pane);
  return resolution ? `${resolution.slice(0, Math.max(0, max - note.length - 2))}; ${note}` : note.slice(0, max);
}

/**
 * No request outlives its own token. A request whose token has expired and whose session Herdr no
 * longer reports is settled as expired on the next reconcile pass, whatever its pane's state. The
 * pass runs on every dispatch tick (and every `master status`), so within this bound of the expiry.
 */
export const expiredRequestBoundMs = sessionReconcileIntervalMs;
/** Whether Herdr's listing still reports the session; an unreadable listing (null) is not evidence either way. */
export const sessionReported = (agents: { name?: string }[] | null | undefined, agentName: string) => !agents || agents.some(agent => agent.name === agentName);

/** A request still pending past its token's expiry, or holding a close failure: what `master status` counts and raises. */
export interface StuckRequest {
  role: 'reviewer' | 'producer'; key: string; record: string; request: string;
  agentName: string; pane: string | null; expiresAt: string; expired: boolean;
  /** How long it has been stuck: since the token expired, else since it was requested. */
  stuckMs: number; since: string; closeFailure: string | null;
}
interface PendingRecord { id: string; key: string; requestId?: string; agentName: string; pane: string | null; state: string; requestedAt: string; closeFailure?: string }
export function stuckRequests(records: { reviews: (PendingRecord & { tokenExpiresAt: string })[]; producers: (PendingRecord & { expiresAt: string })[] }, now: number): StuckRequest[] {
  const judge = (role: StuckRequest['role'], record: PendingRecord, expiresAt: string): StuckRequest[] => {
    if (record.state !== 'pending') return [];
    const expired = Date.parse(expiresAt) <= now;
    if (!expired && !record.closeFailure) return [];
    const since = expired ? expiresAt : record.requestedAt;
    return [{ role, key: record.key, record: record.id, request: record.requestId ?? record.id, agentName: record.agentName, pane: record.pane, expiresAt, expired,
      stuckMs: Math.max(0, now - Date.parse(since)), since, closeFailure: record.closeFailure ?? null }];
  };
  return [...records.reviews.flatMap(record => judge('reviewer', record, record.tokenExpiresAt)), ...records.producers.flatMap(record => judge('producer', record, record.expiresAt))]
    .sort((a, b) => b.stuckMs - a.stuckMs);
}

/** One reader's line per stuck request: the item, the request, how long, why, and the remedy. `next` names what settles it. */
export function stuckRequestLine(stuck: StuckRequest): { subject: string; text: string; next: string } {
  const why = stuck.expired ? `pending ${elapsed(stuck.stuckMs)} past its token expiry at ${stuck.expiresAt}` : `pending ${elapsed(stuck.stuckMs)} since ${stuck.since}`;
  const failure = stuck.closeFailure ? `; its pane could not be closed: ${stuck.closeFailure}` : '';
  const pane = stuck.pane ? `herdr pane close ${stuck.pane}` : `stop Herdr session ${stuck.agentName}`;
  return { subject: stuck.key,
    text: `${stuck.role} request ${stuck.request} on ${stuck.key} (session ${stuck.agentName}) is ${why}${failure}. It refuses every later ${stuck.role} launch for ${stuck.key} while it stands`,
    next: `${pane} (a pane that is already gone counts as closed), then graphyard master status settles the request${stuck.expired ? ` as expired within ${elapsed(expiredRequestBoundMs)} once Herdr no longer reports the session` : ''}` };
}
