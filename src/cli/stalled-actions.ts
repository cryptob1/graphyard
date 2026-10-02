import { agentOwner, humanOwner, type AttentionItem } from '../master.js';
import { describeRemedyRecord, stallRemedy, standingRemedy } from '../stall-remedies.js';
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
 *
 * A reason the registry binds to a remedy (GY-949, src/stall-remedies.ts) names that remedy as the
 * next step instead — the one the loop applies itself, with what its attempt did once the row
 * records one, or the bounded decision that owns it. Only a reason the registry does not recognise
 * keeps the generic instruction.
 */
export function stalledActionAttention(snapshot: { work: Work[]; now: string }): AttentionItem[] {
  return queueSnapshot(snapshot.work, new Date(snapshot.now)).stalled.map(entry => {
    const bound = stallRemedy(entry.stall!.reason);
    const work = snapshot.work.find(item => item.id === entry.work);
    const attempt = bound?.applies === 'loop' && work ? standingRemedy(work, entry.id, entry.stall!.reason) : null;
    const next = !bound ? generic
      : !attempt ? bound.next
      : attempt.outcome === 'refused' ? `Nothing to retry: ${describeRemedyRecord(attempt)}. The loop does not apply it again for this unchanged run; the row is escalated once with the refusal and the remedy named, and clearing what the refusal names (master status shows a pending sudo code) lets the row's recheck pick the change up`
      : `Nothing to run by hand: ${describeRemedyRecord(attempt)}. The row's recheck picks the change up; should the reason stand, the run is escalated with the remedy named rather than the remedy applied again`;
    return {
      subject: entry.key,
      kind: 'stalled-action' as const,
      text: `${entry.key}'s ${entry.kind} action is stalled, retried only on a widening backoff: ${entry.stall!.failures} attempts in a row failed for one unchanged reason — ${entry.stall!.reason} — and it has been open ${elapsed(entry.waitedMs)} over ${entry.attempts} attempt(s)${entry.retryAt ? `; next attempt at ${entry.retryAt}` : ''}. Nothing changes by attempting it again while that condition stands`,
      ...(bound?.owner === 'human' ? humanOwner('spending money or opening third-party accounts', next) : agentOwner('master', next)),
    };
  });
}

/** The instruction for a stall reason no registry entry recognises. */
const generic = `Clear what that reason names: the row rechecks ${Math.round(actionStallRecheckMs / 1000)}s after the third identical failure and twice as long after each further one, up to ${Math.round(actionStallMaxMs / 60_000)} minutes, so it is claimed within one such interval of the condition clearing and needs no forced retry. master status lists it under actions.stalled`;
