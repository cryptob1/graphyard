import { livenessViolations, type ViolationClass } from '../model/liveness.js';
import type { Work } from '../model/work.js';

/**
 * What `master status` says about the liveness invariant (GY-201): how many open items hold no
 * obligation — no live leased session, no open action row, no named wait with a due time — and,
 * for each, how long it has held none, what it is and the successor the next reconciliation opens.
 *
 * The count is the control plane's own judgment (`src/model/liveness.ts`), computed from the same
 * snapshot as the rest of the report. A healthy board reads zero: every violation is repaired
 * within one reconciliation tick, so a count that stays above zero is the tick not running.
 */
export interface LivenessStatus {
  violations: number;
  /** The oldest violation's age, or null when there are none. */
  oldestMs: number | null;
  items: { key: string; class: ViolationClass; since: string; ageMs: number; detail: string; successor: string | null }[];
}

export function livenessStatus(snapshot: { work: Work[]; now: string }): LivenessStatus {
  const items = livenessViolations(snapshot.work, new Date(snapshot.now)).map(entry => ({
    key: entry.key, class: entry.class, since: entry.since, ageMs: entry.ageMs, detail: entry.detail,
    successor: entry.successor ? `${entry.successor.kind} (${entry.successor.binding})` : null,
  }));
  return { violations: items.length, oldestMs: items.length ? items[0].ageMs : null, items };
}
