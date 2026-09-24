import { isDelivered, type Work } from '../src/model';
import { phaseOf, phases, plainStatus, type Phase } from './plain-status';

const week = 7 * 24 * 60 * 60 * 1000;

/**
 * Every number on the home page, from one pass over the work list. Each counts one named
 * thing, and no thing is counted twice: `byPhase` is the one count row, the stages; `open` is
 * the sum of its open phases and is drawn once, in the page heading; `stuck` is the subset of
 * `open` that needs attention and is drawn once, on the Stuck list. Delivered work is only
 * ever counted under `shippedThisWeek`, never in the row; closed work (never delivered) in neither.
 */
export function homeNumbers(work: Work[], now: number) {
  const open = work.filter(w => w.stage !== 'done');
  const byPhase = Object.fromEntries(phases.map(phase => [phase, 0])) as Record<Phase, number>;
  for (const w of open) byPhase[phaseOf(w, now)]++;
  const shipped = work.filter(isDelivered);
  const shippedAt = (w: Work) => Date.parse(w.observation?.mergedAt ?? w.stageEnteredAt);
  return {
    /** Items not delivered yet. */
    open: open.length,
    /** Open items, per phase of the stage strip (`shipped` is always 0 here). A phase at 0 is
     * counted but takes no tile: the row draws the non-empty stages only. */
    byPhase,
    /** Open items that will not move until somebody decides or fixes something. */
    stuck: open.filter(w => plainStatus(w, now).tone === 'stuck').length,
    /** Delivered items merged in the last seven days. */
    shippedThisWeek: shipped.filter(w => now - shippedAt(w) <= week).length,
  };
}
export type HomeNumbers = ReturnType<typeof homeNumbers>;
