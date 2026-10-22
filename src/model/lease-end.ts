import type { Work } from './work.js';

/** Whether `epoch` is the one the item's submission was made under: its lease ended at `submit`. */
export function submittedEpoch(work: Pick<Work, 'submission'>, epoch: number) { return !!work.submission && work.submission.epoch === epoch; }
/**
 * A session whose launch failed before the session started (GY-1375): it never ran, so neither its
 * lapse nor the minute its attempt's lease outlives it is a session-liveness instance of its own.
 */
export function launchFailedBeforeStart(session: { state?: string; pane?: string | null; outcome?: string | null } | null | undefined): boolean {
  return !!session && session.state === 'finished' && !session.pane && !!session.outcome?.startsWith('the launch failed before the session started');
}
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
