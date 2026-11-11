// Concern: what the last worker launch of an item recorded, read by master status and the early-exit judge (GY-2971).
import { readFile } from 'node:fs/promises';
import { dispatchedFile } from './dispatch-reservation.js';

/**
 * What the last worker launch of an item recorded, beside the epoch the dispatch reservation reads:
 * the runtime and account it ran on, the runtime's own session id, its worktree, and the attempt it
 * resumed, if any. Written once the launch started; a record from before GY-2971 has only the epoch.
 */
export interface AttemptLaunch { epoch: number; runtime?: string | null; account?: string | null; session?: string | null; path?: string | null; resumedFrom?: number | null }
export async function readAttemptLaunch(root: string, key: string): Promise<AttemptLaunch | null> {
  const record = await readFile(dispatchedFile(root, key), 'utf8').then(text => JSON.parse(text) as AttemptLaunch, () => null);
  return typeof record?.epoch === 'number' ? record : null;
}

/** How soon after its start a worker that exits counts as an early exit, a launch incident rather than work (GY-2971). */
export const resumeExitWindowMs = 60_000;

/** The attempt line `master status` shows for an item: `attempt N`, with the attempt it resumed when it did. */
export function attemptLabel(epoch: number, launched: AttemptLaunch | null) {
  if (!epoch) return null;
  return launched?.epoch === epoch && launched.resumedFrom ? `attempt ${epoch} (resumed from ${launched.resumedFrom})` : `attempt ${epoch}`;
}
