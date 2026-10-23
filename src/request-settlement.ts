
import { herdrErrorCode } from './master.js';

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
  // Herdr names the code on the error, or in the JSON it printed on stdout or stderr.
  if (herdrErrorCode(error) === paneAbsentCode) return true;
  return error instanceof Error && error.message.includes(paneAbsentCode);
}
export const paneGoneNote = (pane: string) => `pane ${pane} was already gone when the session was closed, so there was nothing left to close`;
/** A resolution with the absent pane named after it, within the ledgers' resolution bound; the resolution is shortened, never the note. */
export function withPaneGone(resolution: string | undefined, pane: string, max = 900) {
  const note = paneGoneNote(pane);
  return resolution ? `${resolution.slice(0, Math.max(0, max - note.length - 2))}; ${note}` : note.slice(0, max);
}
/** Whether Herdr's listing still reports the session; an unreadable listing (null) is not evidence either way. */
export const sessionReported = (agents: { name?: string }[] | null | undefined, agentName: string) => !agents || agents.some(agent => agent.name === agentName);
