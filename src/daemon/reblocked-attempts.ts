// Concern: an attempt that blocks again after its blocker was cleared (GY-867) — ended and handed on.
import type { Work } from '../model.js';
import type { DaemonState } from './state.js';

/**
 * GY-867. Unblocking an attempt only re-prompts the same session (cycle-sessions 1e). When what
 * stopped it lives in that session — its sandbox, its pane's working directory, its stale view of a
 * remote branch — it blocks again within minutes and holds its lease and its profile's slot for as
 * long as it keeps renewing. On 2026-09-27 six of ten worker slots were held that way for hours
 * (GY-710 blocked six times on one epoch). So a clearance is remembered per epoch, and an attempt
 * that blocks again on the same epoch after one is ended: its partial work is kept on its branch,
 * its own blocker ends with it, and the item goes to a fresh session.
 */
export const clearedBlockerKey = (item: Pick<Work, 'id'>, epoch: number) => `resume:cleared:${item.id}:${epoch}`;
export const reblockedKey = (item: Pick<Work, 'id'>, epoch: number) => `resume:reblocked:${item.id}:${epoch}`;

/** The blocker the attempt's earlier clearance answered, when this epoch had one; null otherwise. */
export function clearedBefore(state: DaemonState, item: Pick<Work, 'id'>, epoch: number): string | null {
  const cleared = state.actions[clearedBlockerKey(item, epoch)];
  return cleared?.state === 'done' ? cleared.detail : null;
}

/** Why the attempt is ended, naming both blockers so the item's history shows the pattern. */
export function reblockedReason(item: Pick<Work, 'key'>, epoch: number, cleared: string, blocker: string) {
  const quote = (text: string) => `"${text.length > 300 ? `${text.slice(0, 299)}…` : text}"`;
  return `blocked again on epoch ${epoch} after its blocker was cleared (${cleared}); it now reports ${quote(blocker)}, so the cause lives in this session and ${item.key} goes to a fresh one`;
}
/** The marker a reblocked attempt's end carries in its capacity record, read back by dispatch. */
export const reblockedMarker = 'blocked again on epoch ';

/**
 * The runtime the next attempt should avoid: the runtime of the attempt that was just ended as
 * reblocked, when that is the item's latest worker end. A session-local cause (a sandbox's file
 * ownership, a runtime's permission model) is likeliest to recur on the same runtime.
 */
export function runtimeToAvoid(item: Pick<Work, 'capacity'>): string | null {
  const last = item.capacity?.exhaustions.filter(entry => entry.role === 'worker').at(-1);
  return last?.cause === 'interrupted' && last.reason.startsWith(reblockedMarker) ? last.runtime ?? null : null;
}

/**
 * Orders candidate profiles for a dispatch: those on another runtime than `avoid` first, then the
 * rest, each group in its given order. With nothing to avoid the order is unchanged.
 */
export function preferOtherRuntime<T extends { profile: { kind?: string | null; mode?: string } }>(entries: T[], avoid: string | null): T[] {
  if (!avoid) return entries;
  const runtime = (entry: T) => entry.profile.kind ?? entry.profile.mode ?? null;
  return [...entries.filter(entry => runtime(entry) !== avoid), ...entries.filter(entry => runtime(entry) === avoid)];
}
