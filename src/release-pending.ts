// Concern: which contract outcomes are still pending at a cut (GY-1802), distilled from the plane's goal and work records.
import type { Goal } from './model/goal.js';
import { parseContract, type ReleaseContract } from './e2e/case.js';
import { pendingOutcomeIds, type GoalDelivery } from './release-candidate.js';

/**
 * The plane's goal record as the cut's pending-outcome check reads it: every merged goal with an
 * approved plan, its protected outcomes, and each plan item's serving outcomes with the work item
 * created for it (null until the plan is released).
 */
export function goalDeliveries(goals: readonly Goal[]): GoalDelivery[] {
  return goals.filter(goal => goal.merged && goal.plan).map(goal => ({
    outcomes: goal.protected.outcomes,
    items: (goal.plan?.items ?? []).map(item => ({ outcomes: item.outcomes, key: goal.items?.find(released => released.ref === item.ref)?.key ?? null })),
  }));
}

/**
 * The outcomes pending at a cut, read where the cut runs with the plane in hand: the contract
 * source at the base tip, the plane's open goals, and the stage of each serving item. Any read that
 * fails names none, so the candidate blocks exactly as before rather than passing on a guess.
 */
export async function pendingAtCut(input: { contract: () => Promise<string | null>; goals: () => Promise<readonly Goal[]>; stage: (key: string) => Promise<string | undefined> }): Promise<string[]> {
  try {
    const source = await input.contract();
    if (!source) return [];
    const contract: ReleaseContract = parseContract(source);
    const deliveries = goalDeliveries(await input.goals());
    const keys = [...new Set(deliveries.flatMap(goal => goal.items.map(item => item.key)).filter((key): key is string => !!key))];
    const stages = new Map(await Promise.all(keys.map(async key => [key, await input.stage(key)] as const)));
    return pendingOutcomeIds(contract, deliveries, key => stages.get(key));
  } catch { return []; }
}
