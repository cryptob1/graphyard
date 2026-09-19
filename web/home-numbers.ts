import type { Work } from '../src/model';
import { phaseOf, phases, plainStatus, type Phase } from './plain-status';

const week = 7 * 24 * 60 * 60 * 1000;

/**
 * Every number on the home page, from one pass over the work list. Each counts one named
 * thing, and they reconcile by construction: `open` is the sum of the open phases on the
 * stage strip, the tiles are single phases or a subset of `open`, and delivered work is only
 * ever counted under `shippedThisWeek`, never in a tile.
 */
export function homeNumbers(work: Work[], now: number) {
  const open = work.filter(w => w.stage !== 'done');
  const byPhase = Object.fromEntries(phases.map(phase => [phase, 0])) as Record<Phase, number>;
  for (const w of open) byPhase[phaseOf(w, now)]++;
  const shipped = work.filter(w => w.stage === 'done');
  const shippedAt = (w: Work) => Date.parse(w.observation?.mergedAt ?? w.stageEnteredAt);
  return {
    /** Items not delivered yet. */
    open: open.length,
    /** Open items, per phase of the stage strip (`shipped` is always 0 here). */
    byPhase,
    /** Open items somebody is building right now. */
    building: byPhase.building,
    /** Open, released items nobody is working on. */
    needsWorker: byPhase['needs-worker'],
    /** Open items that will not move until somebody decides or fixes something. */
    stuck: open.filter(w => plainStatus(w, now).tone === 'stuck').length,
    /** Delivered items merged in the last seven days. */
    shippedThisWeek: shipped.filter(w => now - shippedAt(w) <= week).length,
  };
}
export type HomeNumbers = ReturnType<typeof homeNumbers>;
