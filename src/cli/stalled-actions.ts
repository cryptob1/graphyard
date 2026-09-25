import { agentOwner, type AttentionItem } from '../master.js';
import { actionStallMaxMs, actionStallRecheckMs, queueSnapshot } from '../model/action-progress.js';
import type { Work } from '../model.js';

/**
 * What `master status` says about an action row that is stalling rather than retrying (GY-110).
 *
 * A typed action that fails is retried with a widening backoff, and a row inside that backoff is
 * claimable by nobody — so every count and every list the report printed used to pass over it. On
 * 21 September 2026 three items each held a `request-review` action failing for the identical
 * reason, one reviewer profile behind all three, and for ninety-seven minutes `master status`
 * reported eight pending actions, none of them those three, while the board showed the items at
 * review. The fleet read as idle with nothing to do while three reviews were owed.
 *
 * A row whose failures stop changing (`actionStall`) is not waiting out a fault, it is re-running
 * an impossibility, and the one thing typed actions exist to prevent is an item owing something
 * with nobody told. It is still retried, on a backoff that widens with each identical failure
 * (GY-185): the line used to say "not retrying" of rows claimed every two minutes for days. Reporting only: the classification is the control plane's, made when the
 * failure was recorded.
 */

/** Long waits read in the unit the reader thinks in; a row measured in seconds is still young. */
const elapsed = (ms: number) => ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)}h${Math.floor(ms % 3_600_000 / 60_000)}m` : ms >= 60_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 1000)}s`;

/**
 * One attention item per stalled row: the item, the action kind, the unchanged reason, what its
 * attempts have come to and how long it has been open. It is addressed to the master because
 * clearing the condition the reason names is the whole of the fix — reviewer or producer capacity,
 * an overlap ahead of a dispatch, a credential, a provider — and nothing needs a forced retry
 * afterwards: a stalled row rechecks on its own fixed interval whatever its attempt count.
 *
 * Raised as soon as the row is classified, which is inside the idle bound the fleet applies to a
 * row nobody is acting on: a row being attempted and getting nowhere is never the quieter failure.
 */
export function stalledActionAttention(snapshot: { work: Work[]; now: string }): AttentionItem[] {
  return queueSnapshot(snapshot.work, new Date(snapshot.now)).stalled.map(entry => ({
    subject: entry.key,
    text: `${entry.key}'s ${entry.kind} action is stalled, retried only on a widening backoff: ${entry.stall!.failures} attempts in a row failed for one unchanged reason — ${entry.stall!.reason} — and it has been open ${elapsed(entry.waitedMs)} over ${entry.attempts} attempt(s)${entry.retryAt ? `; next attempt at ${entry.retryAt}` : ''}. Nothing changes by attempting it again while that condition stands`,
    ...agentOwner('master', `Clear what that reason names: the row rechecks ${Math.round(actionStallRecheckMs / 1000)}s after the third identical failure and twice as long after each further one, up to ${Math.round(actionStallMaxMs / 60_000)} minutes, so it is claimed within one such interval of the condition clearing and needs no forced retry. master status lists it under actions.stalled`),
  }));
}
