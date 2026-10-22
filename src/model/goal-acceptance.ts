// Concern: how a goal's acceptance change is named, classified and moved on once accepted — a pull request in github mode, a merge-writer change under the control-plane merger (GY-1535).
import type { Goal } from './goal.js';
import { classifyRisk, sensitiveReason, type RiskVerdict } from './risk-class.js';

/** How a goal's acceptance is named: its pull request, or the merge-writer change at its head (GY-1535). */
export const acceptanceName = (goal: Pick<Goal, 'acceptance'>) => goal.acceptance?.pr != null ? `acceptance pull request #${goal.acceptance.pr}` : `acceptance change ${goal.acceptance?.head.slice(0, 12) ?? '(none)'}`;

/** The rule every acceptance change is sensitive by, whatever paths it touches: it is the goal's customer contract. */
export const acceptanceChangeRule = 'customer acceptance: required cases and contract bindings';
/**
 * The class of an acceptance change (GY-1535): always sensitive — it writes the required cases and
 * contract bindings every later item is judged by — and the merge writer lands only its cases and
 * contract. Each path names the acceptance rule beside any
 * rule risk-class.ts itself matches.
 */
export function acceptanceChangeRisk(paths: readonly string[]): RiskVerdict {
  const verdict = classifyRisk(paths.map(path => ({ path })));
  return { risk: 'sensitive', reasons: [...new Set([...verdict.reasons, ...paths.map(path => sensitiveReason(path, acceptanceChangeRule))])] };
}

/** Who acts next on an accepted goal: the loop lands it, or — `stuck`, drafted a day ago and still unmerged — the master reads why and closes or lands it. */
export function acceptedNext(goal: Goal, stuck: boolean): { who: string; command: string } {
  if (stuck)
    return goal.acceptance!.pr === null
      ? { who: `master: ${acceptanceName(goal)} was drafted ${goal.acceptance!.draftedAt} and the merge writer has not landed it; read the loop's acceptance action for why, then close it (the loop drafts again) or let the writer land it`, command: `graphyard goal closed ${goal.key} change -- REASON` }
      : { who: `master: acceptance pull request #${goal.acceptance!.pr} was drafted ${goal.acceptance!.draftedAt} and has not merged; read why on the pull request, then close it (the loop drafts again) or land it`, command: `graphyard goal closed ${goal.key} ${goal.acceptance!.pr} -- REASON` };
  return goal.acceptance!.pr === null
    ? { who: `the loop: the merge writer merges ${acceptanceName(goal)} onto the base at its drafted head and records it merged`, command: `graphyard goal land ${goal.key}` }
    : { who: `the loop: Graphyard publishes its gate verdicts on acceptance pull request #${goal.acceptance!.pr} and merges it at its drafted head, once its required checks pass`, command: `graphyard goal land ${goal.key}` };
}
