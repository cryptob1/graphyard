import type { Work } from '../model/work.js';
import { cappedReview, neededDecision, workerStopped, type ExhaustedProof, type ReviewCapConfig } from '../daemon/decisions.js';
import type { MechanicalFixRequest } from '../mechanical-findings.js';
import { unactedProducerAttempts } from '../auto-dispatch.js';
import { mechanicalHoldPattern } from '../model/refusal-catalogue.js';
import { systemDriven } from './hand-actions.js';
import { conflictReworkBoundMs, conflictReworkDue } from '../model/approval.js';
import { decisionKey } from '../daemon/reconcile.js';

/**
 * GY-1389. A hand `master decide GY-N rework` that restates the loop's own round. The loop's
 * decisions step requests a rework itself, with its grounds binding, whenever the record shows one
 * — a change request standing against the head, a failed required check, a base conflict, a failed
 * or unexercised proof, a spent producer request, a mechanical-fix round — and its risk lane or launched approver applies it, so the round is no
 * intervention. Of the 26 hand reworks in the week GY-1389 counted, 15 were a master session
 * reaching the same round a cycle before the loop, and each was then counted as a coordinator
 * stepping in. On a system-driven item such a request is refused, naming the round the loop
 * requests, judged on the loop's own context: the base failures it set aside (a check the base
 * fails too is no worker's, GY-528), the producer requests it spent, the mechanical rounds the
 * review ledger planned. Past the review-round cap, a change request naming no blocking finding is
 * the loop's to withdraw, never reworked. It stays open where the loop sends the master: to answer a refusal
 * (`--precedent`), when the loop withholds the round because the stopped worker is unverified, when
 * the loop has no operator-agent identity to request decisions, and on any ground the loop does not
 * read. A hand request never carries a grounds binding: that is how the intervention report tells
 * the two apart.
 *
 * One more is refused whatever it answers: a rework for a head whose producer requests were spent
 * without any session acting — every launch refused on an account's quota, never started (GY-1153).
 * Nothing in the change is wrong, the next head needs the same producers, and the loop relaunches
 * the request once an eligible account exists; three of the 26 were that.
 */
export interface HandReworkLoop {
  now: number; requestsDecisions: boolean; precedent?: string | null;
  /** The required checks the loop set aside as the base's own failures for this head; null when the loop's state could not be read. */
  baseFailed?: ReadonlySet<string> | null;
  /** The loop's spent producer requests (the dispatch cursor's abandoned entries). */
  exhausted?: readonly ExhaustedProof[];
  /** The review ledger's planned mechanical-fix rounds (GY-971). */
  mechanical?: readonly MechanicalFixRequest[];
  /** Whether the review-cap step escalated the head's capped change request instead of withdrawing it; null when unknown. */
  capEscalated?: boolean | null;
}

/** What the loop's state says of one head's failed checks: those it set aside as the base's, or null when it is still judging them. */
export function loopBaseFailed(work: Pick<Work, 'id' | 'candidate' | 'baseRefreshRequest'>, state: { baseFailures: Record<string, { check: string; blocks: { id: string; sha: string }[] }>; actions: Record<string, { detail: string } | undefined> } | null): ReadonlySet<string> | null {
  const sha = work.candidate?.sha;
  if (!state || !sha) return null;
  // A head waiting on its base's own run, or on a refresh onto the repaired base, is not judged yet.
  if (work.baseRefreshRequest?.head === sha || state.actions[`wait:base-failure:${work.id}`]?.detail.includes(sha.slice(0, 12))) return null;
  return new Set(Object.values(state.baseFailures).filter(failure => failure.blocks.some(block => block.id === work.id && block.sha === sha)).map(failure => failure.check));
}

/**
 * GY-1434. The loop round a recorded base conflict owes, named exactly — the action key the loop's
 * decisions step records it under — with the bound it falls due by, and, past it, how overdue it is:
 * a refused hand rework then says that the step is stalled rather than leaving the stall silent.
 */
function conflictRound(work: Work, needed: { action: string; binding: string }, now: number): string {
  const due = needed.binding.endsWith(':conflict') ? conflictReworkDue(work, now) : null;
  if (!due || due.binding !== needed.binding) return '';
  const round = `The round is ${decisionKey(work, needed as Parameters<typeof decisionKey>[1])}, owed within ${conflictReworkBoundMs / 60_000} minutes of the conflict first recorded on this head at ${due.since} (due at ${due.dueAt}). `;
  return due.overdueMs > 0 ? `${round}It is ${Math.ceil(due.overdueMs / 60_000)} minute(s) overdue against that bound, so the loop's decisions step is stalled on it: master status names it as a stalled-step attention. `
    : round;
}

const refused = (work: Work, why: string) => `${work.key} is system-driven: ${why} `
  + 'Watch it with master status; a loop that is not running is restarted, never stood in for by hand.';

/** Why a hand rework restates the loop's own round, or null when it is the master's to request. */
export function loopRework(work: Work, action: string, input: unknown, config: ReviewCapConfig, loop: HandReworkLoop): string | null {
  if (action !== 'rework') return null;
  // The binding marks the loop's own request (GY-407), which the intervention report reads as its round.
  if ((input as { binding?: unknown } | null)?.binding !== undefined) return `${work.key}: a grounds binding marks the loop's own rework request; a hand rework carries none, and is recorded as the master's`;
  if (!systemDriven(work) || !loop.requestsDecisions) return null;
  const needed = neededDecision(work, config, loop.baseFailed ?? undefined, loop.exhausted ?? [], loop.mechanical ?? []);
  if (needed?.action === 'rework') {
    // Without the loop's base-failure judgement a failed check is not known to be the worker's. The
    // loop withholds any rework it needs — on whatever context grounds it — while the stopped worker
    // is unverified, so that is judged on the round already found, never re-derived without it.
    if (loop.precedent || (loop.baseFailed == null && needed.binding.includes(':ci:')) || workerStopped(work, loop.now).unverified) return null;
    return refused(work, `the loop's decisions step requests this rework itself on its recorded grounds (${needed.binding}): ${needed.reason.slice(0, 600)} `
      + `${conflictRound(work, needed, loop.now)}Its risk lane or the approver it launches applies the round, so a hand rework of it is refused. A hand rework stays open to answer a refusal (--precedent ID).`);
  }
  // The review gate holds an approval with mechanical nits for the worker bot's own round (GY-971).
  const hold = (work.gates ?? []).find(gate => gate.name === 'review')?.reasons.find(reason => mechanicalHoldPattern.test(reason));
  if (hold && !loop.precedent) return refused(work, `${hold}. The loop requests that round's rework decision itself once the review ledger plans it, so a hand rework of it is refused. A hand rework stays open to answer a refusal (--precedent ID).`);
  // Past the review-round cap a change request naming no blocking finding is the loop's to withdraw (GY-1118, GY-1249).
  const capped = cappedReview(work, config);
  if (capped?.kind === 'follow-up' && loop.capEscalated === false && !loop.precedent) return refused(work, `${capped.reason}. Past the cap the loop's review-cap step withdraws such a request and the head is reviewed again with no rework, so a hand rework of it is refused. A hand rework stays open to answer a refusal (--precedent ID).`);
  const sha = work.candidate?.sha;
  const spent = (loop.exhausted ?? []).filter(entry => entry.work === work.key && entry.sha === sha);
  if (spent.length && spent.every(entry => unactedProducerAttempts(entry.attempts)))
    return refused(work, `every producer attempt for ${spent.map(entry => entry.group ?? 'producer').join(', ')} on ${sha!.slice(0, 12)} ended without the session acting (${spent[0].attempts[0]?.slice(0, 300) ?? spent[0].reason.slice(0, 300)}). That is no defect of the head: a new one needs the same producers, so a rework only discards its review and proofs. `
      + 'The loop relaunches the request once an eligible producer account exists (GY-1153); free or add one (master status names the account), and this is refused even answering a refusal.');
  return null;
}

/** Throws the refusal for a hand rework the loop requests itself. */
export function assertHandRework(...args: Parameters<typeof loopRework>) {
  const refusal = loopRework(...args);
  if (refusal) throw new Error(refusal);
}
