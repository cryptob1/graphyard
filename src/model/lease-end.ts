import type { Work } from './work.js';

/** Whether `epoch` is the one the item's submission was made under: its lease ended at `submit`. */
export function submittedEpoch(work: Pick<Work, 'submission'>, epoch: number) { return !!work.submission && work.submission.epoch === epoch; }
/**
 * One gap in the control plane's own reconciliation ticks (engine.ts `recordPlaneLiveness`), read from
 * the ledger: from the last tick before the gap to the tick that recovered, the plane was not
 * answering. A lease that runs out inside one keeps a short renewal grace (GY-1801).
 */
export interface PlaneStall { from: string; to: string }
/** The stall that covers `at`, when one does. */
export function stallCovering(stalls: readonly PlaneStall[], at: number): PlaneStall | null {
  return stalls.find(stall => at >= Date.parse(stall.from) && at <= Date.parse(stall.to)) ?? null;
}
