import type { Work } from '../model/work.js';
import { neededDecision, withheldDecision, type ReviewCapConfig } from '../daemon/decisions.js';
import { systemDriven } from './hand-actions.js';

/**
 * GY-1389. A hand `master decide GY-N rework` that restates the loop's own round. The loop's
 * decisions step requests a rework itself, with its grounds binding, whenever the record shows one
 * — a change request standing against the head, a failed required check, a base conflict, a failed
 * or unexercised proof — and its risk lane or launched approver applies it, so the round is no
 * intervention. Fifteen of the 26 hand reworks in the week GY-1389 counted were exactly that: a
 * master session reaching the same round a cycle before the loop, and each was then counted as a
 * coordinator stepping in. On a system-driven item such a request is refused, naming the round the
 * loop requests. It stays open where the loop sends the master: to answer a refusal (`--precedent`),
 * when the loop withholds the round because the stopped worker is unverified, when the loop has no
 * operator-agent identity to request decisions, and on any ground the loop does not read. A hand
 * request never carries a grounds binding: that is how the intervention report tells the two apart.
 */
export interface HandReworkLoop { now: number; requestsDecisions: boolean; precedent?: string | null }

/** Why a hand rework restates the loop's own round, or null when it is the master's to request. */
export function loopRework(work: Work, action: string, input: unknown, config: ReviewCapConfig, loop: HandReworkLoop): string | null {
  if (action !== 'rework') return null;
  // The binding marks the loop's own request (GY-407), which the intervention report reads as its round.
  if ((input as { binding?: unknown } | null)?.binding !== undefined) return `${work.key}: a grounds binding marks the loop's own rework request; a hand rework carries none, and is recorded as the master's`;
  if (!systemDriven(work) || !loop.requestsDecisions || loop.precedent) return null;
  const needed = neededDecision(work, config);
  if (needed?.action !== 'rework' || withheldDecision(work, config, loop.now)) return null;
  return `${work.key} is system-driven: the loop's decisions step requests this rework itself on its recorded grounds (${needed.binding}): ${needed.reason.slice(0, 600)} `
    + 'Its risk lane or the approver it launches applies the round, so a hand rework of it is refused. Watch it with master status; a loop that is not running is restarted, never stood in for by hand. '
    + 'A hand rework stays open to answer a refusal (--precedent ID).';
}

/** Throws the refusal for a hand rework the loop requests itself. */
export function assertHandRework(...args: Parameters<typeof loopRework>) {
  const refusal = loopRework(...args);
  if (refusal) throw new Error(refusal);
}
