// Concern: the wording of a routine decision — its bounded reason and detail, and the refused or standing decisions a retry cites.
import { RefusedResponse, type Work } from '../model.js';
import { actionDetailMax } from './state.js';
import type { RoutineDecisionAction } from './decisions.js';

/** The control plane's bound on a decision's reason (`src/model/approval.ts`); a longer one is refused on every retry. */
export const decisionReasonMax = 2000;
/**
 * A decision reason within the control plane's bound. What the requester adds around the loop's own
 * grounds — the observation it decided from, the refusals it answers — is kept whole, because the
 * server reads the cited refusals from it; the grounds are shortened to make room.
 */
export function fitDecisionReason(prefix: string, grounds: string, suffix: string): string {
  const room = decisionReasonMax - prefix.length - suffix.length;
  return prefix + (grounds.length <= room ? grounds : `${grounds.slice(0, Math.max(0, room - 1))}…`) + suffix;
}
/**
 * An action detail within its bound. A scope request carries up to 50 paths of up to 500 characters,
 * so a detail that lists them — or quotes an error that does — is cut, never left to fail record()
 * after the action it records has already happened. record() applies it to every detail it stores.
 */
export function boundDetail(detail: string, max = actionDetailMax): string {
  return detail.length <= max ? detail : `${detail.slice(0, max - 1)}…`;
}

/**
 * Whether a detail differs from the one an action already stores. record() stores the bounded form,
 * so a stable detail over the bound compares equal and is not re-recorded every cycle (GY-179).
 */
export function detailChanged(previous: { detail: string } | undefined, detail: string): boolean {
  return previous?.detail !== boundDetail(detail);
}

/** Paths named in a detail: every one while short, else the first few and a count of the rest. */
export function namePaths(paths: readonly string[], room = 600): string {
  const named: string[] = [];
  let used = 0;
  for (const path of paths) {
    const text = path.length > 200 ? `${path.slice(0, 199)}…` : path;
    if (named.length && used + text.length + 2 > room) break;
    named.push(text);
    used += text.length + 2;
  }
  const more = paths.length - named.length;
  return `${paths.length} file${paths.length === 1 ? '' : 's'} (${named.join(', ')}${more ? ` and ${more} more` : ''})`;
}
/** The least of its own grounds a rework request keeps beside the refusals it cites; below it the request would not say why. */
export const reworkGroundsMin = 160;
/**
 * A rework reason that cites every refused rework decision on the item — the server refuses a
 * request of the same input unless its reason names each one by id — within the control plane's
 * bound. The citations are written out in prose while they leave the grounds room, then as a bare
 * id list; when even that leaves the grounds less than `reworkGroundsMin`, no reason can satisfy
 * both the bound and the server's check, and this is null: the loop escalates rather than sending a
 * request the server refuses on every retry.
 */
export function reworkDecisionReason(prefix: string, grounds: string, refused: string[], action: 'rework' | 'recover' = 'rework'): string | null {
  if (!refused.length) return fitDecisionReason(prefix, grounds, '');
  const prose = ` This rests on different grounds from refused ${action} decision${refused.length === 1 ? '' : 's'} ${refused.join(', ')}, which ${refused.length === 1 ? 'was' : 'were'} judged on earlier grounds.`;
  const bare = ` Answers refused ${action} decisions ${refused.join(' ')}.`;
  const suffix = [prose, bare].find(text => decisionReasonMax - prefix.length - text.length >= Math.min(reworkGroundsMin, grounds.length));
  return suffix === undefined ? null : fitDecisionReason(prefix, grounds, suffix);
}
/** How many standing refusals the server names that a rework or recover request answers by citing them before it gives up. */
export const maxRefusalAnswers = 3;
const decisionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * The refused decision of `action` the server's refusal of a request names as standing against it,
 * or null. The server returns it as a field of the 409 body (`standingRefusal`, GY-265), so the
 * loop's retry does not depend on how the message is worded. Only a server that predates the field
 * is read from its message, and a rewording there fails closed: the refusal is recorded, not retried.
 */
export function refusalNamedIn(error: unknown, action: 'rework' | 'recover' = 'rework'): string | null {
  const field = error instanceof RefusedResponse ? (error.body as any)?.standingRefusal : undefined;
  if (field && typeof field === 'object') return field.action === action && typeof field.decision === 'string' && decisionId.test(field.decision) ? field.decision : null;
  const text = error instanceof Error ? error.message : String(error);
  return new RegExp(`Decision ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) \\(${action}\\) with this input\\b`).exec(text)?.[1] ?? null;
}
/**
 * The applied rework a refused request names as already holding the item (GY-1579), or null. The
 * server returns it as a field of the 409 body (`heldRework`), so the loop adopts the hold the
 * record answers instead of repeating a request the control plane refuses on every retry — each
 * refusal a counted decision fault (GY-1888, GY-1846's put). Only a server that predates the field
 * is read from its message, and a rewording there fails closed, as refusalNamedIn's does.
 */
export function heldReworkNamedIn(error: unknown): string | null {
  const field = error instanceof RefusedResponse ? (error.body as any)?.heldRework : undefined;
  if (field && typeof field === 'object') return typeof field.decision === 'string' && decisionId.test(field.decision) ? field.decision : null;
  const text = error instanceof Error ? error.message : String(error);
  return /already holds rework: decision ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) was applied/.exec(text)?.[1] ?? null;
}
/**
 * The pane a refused approver launch names as holding the session's own name (GY-1884), or null:
 * the runtime refuses the rename with `agent_name_taken` and names the holder (`pane_id=…`), so
 * the loop can recover the launch instead of repeating it every retry. The name is matched exactly,
 * so a refusal of some other session's name is never read as this one's.
 */
export function heldApproverPaneIn(error: unknown, name: string): string | null {
  const text = error instanceof Error ? error.message : String(error);
  if (!text.includes('agent_name_taken') || !text.includes(`as ${JSON.stringify(name)}`)) return null;
  return /pane_id=([A-Za-z0-9:_-]+)/.exec(text)?.[1] ?? null;
}
/**
 * The actions whose standing request the loop adopts on the server's word alone (GY-1374): they bind
 * nothing a standing one could disagree with, unlike a merge or attest (its candidate), a resolve (its
 * trigger) or a requirements decision (its scope request), each of which the history read must judge.
 */
export const adoptedOnRefusal: readonly RoutineDecisionAction[] = ['rework', 'recover', 'close'];
/**
 * The requested decision of `action` a refused request names as already standing on the item, or
 * null (GY-1374). The server keeps one request per action and refuses a second "Decision ID (ACTION)
 * is already requested on GY-N; wait for it". The loop's history read can miss it — a rework or
 * recover read that failed is taken as empty — and GY-1352's rework round was then logged failed
 * while the very decision it asked for stood, requested and awaiting its approver.
 */
export function standingNamedIn(error: unknown, action: RoutineDecisionAction): string | null {
  const text = error instanceof Error ? error.message : String(error);
  return new RegExp(`Decision ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) \\(${action}\\) is already requested on `).exec(text)?.[1] ?? null;
}
