import type { Work } from '../model.js';
import type { StepState } from './pr-steps.js';

/**
 * The research step's state, from the item's own record (GY-434). A running run is current within
 * its time limit plus the loop's grace (src/research.ts `researchHold`), pending past it until the
 * failure is recorded. A recorded brief is done; a failed run is skipped, never failed. With no run,
 * research is skipped — never missing — for a bug without `"research": true`, an item opted out, a
 * loop that does not research (`configured`: its published `run.research`, src/model/release.ts),
 * and an item already building or handed in; only a released feature on a researching loop is pending.
 */
/** How long past its timeout a run recorded as running still counts as live: the runner stops it at the timeout, and its failure is posted within this. src/research.ts `researchHold` holds dispatch by the same bound. */
export const researchHoldGraceMs = 60_000;
export function researchStepState(work: Pick<Work, 'type' | 'research' | 'researchBrief' | 'submission' | 'candidate' | 'lease'>, now: number, configured = false): StepState {
  const record = work.researchBrief ?? null;
  if (record?.state === 'running')
    return Number.isFinite(Date.parse(record.startedAt)) && now < Date.parse(record.startedAt) + record.timeoutMs + researchHoldGraceMs ? 'current' : 'pending';
  if (record?.state === 'recorded') return 'done';
  if (record?.state === 'failed') return 'skipped';
  const wanted = work.research === true || work.type === 'feature' && work.research !== false;
  if (!wanted || !configured || work.lease || work.submission || work.candidate) return 'skipped';
  return 'pending';
}
