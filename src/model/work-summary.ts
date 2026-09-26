import type { Work } from './work.js';

/**
 * A settled delivery as the work snapshot serves it (GY-422; src/store/summary-sql.ts builds it):
 * the item's decision state (identity, stage, policy, delivery or closure, candidate and the
 * evidence binding it, dependencies, origin, the observation's merge facts) without its histories
 * or prose: no description, resolved action rows, dispatch requests or queue history, sessions only
 * from the last day, and the pipeline timeline reduced to what the speed report measures.
 * `GET /api/work/:id` answers the whole document when a reader needs more.
 */
export type WorkSummary = Pick<Work, 'id' | 'key' | 'title' | 'stage'> & Partial<Work> & {
  summary: true;
  /** How many action rows the item completed; its resolved rows themselves are left out. */
  completedActions?: number;
};

/** True for a snapshot entry that is a settled delivery's summary rather than a whole document. */
export const isSummary = <T>(work: T): work is T & WorkSummary => !!work && typeof work === 'object' && (work as { summary?: unknown }).summary === true;

/**
 * The whole document behind a snapshot entry: the entry itself when it is one, else the item read
 * by id. For the readers that look one item up in the snapshot and then read its history.
 */
export async function wholeDocument<T extends { id: string }>(entry: T, read: (path: string) => Promise<any>): Promise<Work> {
  return isSummary(entry) ? read(`work/${encodeURIComponent(entry.id)}`) : entry as unknown as Work;
}
