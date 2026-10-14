// Concern: which contract outcomes are still pending at a cut (GY-1802), distilled from the plane's goal and work records.
import type { Goal } from './model/goal.js';
import { parseContract, type ReleaseContract } from './e2e/case.js';
import { isDelivered } from './model/closure.js';
import type { Work } from './model.js';
import { pendingOutcomeIds, type GoalDelivery } from './release-candidate.js';

/**
 * The plane's goal record as the cut's pending-outcome check reads it: every merged goal, or approved one whose merge may sit on the candidate before it is recorded (one
 * with no approved plan yet has no items, so its outcomes are all pending), its protected outcomes, and each plan item's serving outcomes with the work item
 * created for it (null until the plan is released).
 */
export function goalDeliveries(goals: readonly Goal[]): GoalDelivery[] {
  return goals.filter(goal => goal.merged || (goal.stage === 'accepted' && goal.approval && goal.acceptance)).map(goal => ({
    // An approved acceptance whose merge reached main before `goal land` recorded it still protects what it drafted.
    outcomes: goal.merged ? goal.protected.outcomes : (goal.acceptance?.outcomes ?? []).map(outcome => outcome.id),
    items: (goal.plan?.items ?? []).map(item => ({ outcomes: item.outcomes, key: goal.items?.find(released => released.ref === item.ref)?.key ?? null })),
  }));
}

/** The stage the cut reads for a work item: `done` only when it was delivered; one closed without delivery (duplicate, superseded, obsolete) serves nothing, so reads as `closed`. */
export const servingStage = (work: Pick<Work, 'stage' | 'closure'> | undefined | null): string | undefined => !work ? undefined : isDelivered(work) ? 'done' : work.stage === 'done' ? 'closed' : work.stage;

/** The plane read once before a cut: goal deliveries and the stage of each serving item; null when any read fails. */
export interface PlaneSnapshot { deliveries: GoalDelivery[]; stages: Map<string, string | undefined> }
export async function readPlane(input: { goals: () => Promise<readonly Goal[]>; stage: (key: string) => Promise<string | undefined> }): Promise<PlaneSnapshot | null> {
  try {
    const deliveries = goalDeliveries(await input.goals());
    const keys = [...new Set(deliveries.flatMap(goal => goal.items.map(item => item.key)).filter((key): key is string => !!key))];
    return { deliveries, stages: new Map(await Promise.all(keys.map(async key => [key, await input.stage(key)] as const))) };
  } catch { return null; }
}

/**
 * The outcomes pending at a cut, from the plane read beforehand and the contract source at the
 * candidate's own SHA. An item whose merge lies after the candidate (queued) is still undelivered
 * there. A plane or contract that cannot be read names none, so the candidate blocks exactly as
 * before rather than passing on a guess.
 */
export function pendingFromPlane(plane: PlaneSnapshot | null, source: string | null, cut: { undelivered: ReadonlySet<string> }): string[] {
  try {
    if (!plane || !source) return [];
    const contract: ReleaseContract = parseContract(source);
    return pendingOutcomeIds(contract, plane.deliveries, key => cut.undelivered.has(key) ? undefined : plane.stages.get(key));
  } catch { return []; }
}

/** Async form for the loop's cut: reads the plane, then the contract at the candidate's SHA. */
export async function pendingAtCut(input: { contract: (sha: string) => Promise<string | null>; goals: () => Promise<readonly Goal[]>; stage: (key: string) => Promise<string | undefined> }, cut: { sha: string; undelivered: ReadonlySet<string> }): Promise<string[]> {
  const plane = await readPlane(input);
  let source: string | null = null;
  try { source = await input.contract(cut.sha); } catch { source = null; }
  return pendingFromPlane(plane, source, cut);
}
