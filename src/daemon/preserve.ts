// Concern: what an interrupted attempt leaves behind — the cursor record of it, and the preservation of its partial work for the next attempt.
import type { Work } from '../model.js';
import type { FaultKind } from '../model/fault-classes.js';
import type { WorkerProfile } from '../master.js';
import { type DaemonAction, type DaemonState, message, storeAction } from './state.js';
import { readyToRetry } from './sessions.js';
import type { DaemonEffects } from './effects.js';

/** Put an action on the cursor, through storeAction, which bounds it and notes it against the fault record (GY-173). */
export async function record(state: DaemonState, key: string, action: Omit<DaemonAction, 'at' | 'epoch' | 'faultClass'> & { at?: string; epoch?: number | null }, now: number, persist: DaemonEffects['persist'], faultKind?: FaultKind | null) {
  const entry = storeAction(state, key, { epoch: null, ...action, at: action.at ?? new Date(now).toISOString() }, faultKind);
  await persist(state);
  return entry;
}

/** One preservation per attempt: the record an interrupted attempt leaves for the next one. */
export const preserveKey = (work: Pick<Work, 'id'>, epoch: number) => `preserve:${work.id}:${epoch}`;
/**
 * Keep what a worker that died left behind, the same way an exhausted one's is kept (GY-105).
 *
 * A worker killed outright — the agent process OOM-killed, the supervisor's tree stopped, the host
 * rebooted — never reaches `complete`, and its worktree holds whatever it had not committed. Before
 * the item can be dispatched again, that is committed on the attempt's own branch (or the record
 * says it was discarded) and written onto the item through the same capacity record the quota path
 * uses, with the cause it was observed for; the next attempt's request then names the commit,
 * branch and worktree. For an attempt whose lease is still live the record ends it, so the item
 * becomes claimable only once its partial work is on the record. Nothing is preserved for an
 * attempt that submitted — its work is on the pull request — or one the quota path already kept.
 */
export async function preserveInterruptedAttempt(state: DaemonState, effects: DaemonEffects, item: Work, epoch: number, profile: WorkerProfile | undefined, observed: string, now: () => number, performed: DaemonAction[], options: { endsBlocker?: true } = {}) {
  if (!effects.reportCapacity) return null;
  const key = preserveKey(item, epoch), previous = state.actions[key];
  if (previous?.state === 'done' || (previous && !readyToRetry(previous, state.cycle))) return previous;
  if (item.submission?.epoch === epoch || item.capacity?.exhaustions.some(entry => entry.role === 'worker' && entry.epoch === epoch)) return null;
  const principal = profile?.principal ?? item.lastAssignment?.owner ?? null, attempts = (previous?.attempts ?? 0) + 1;
  await record(state, key, { kind: 'preserve', work: item.key, principal, epoch, state: 'started', detail: `Keeping what attempt ${epoch} of ${item.key} left in its worktree: ${observed}`, attempts, cycle: state.cycle }, now(), effects.persist);
  try {
    const partialWork = await effects.preserveWork?.(item, epoch, 'interrupted before it could submit') ?? { state: 'not-applicable' as const, detail: 'this loop has no access to the attempt worktree' };
    await effects.reportCapacity(item, { event: 'exhausted', cause: 'interrupted', role: 'worker', epoch, profile: profile?.name ?? principal ?? 'unknown', account: null, runtime: profile?.kind ?? null, reason: observed.slice(0, 500), resetsAt: null, partialWork, ...options });
    const where = partialWork.commit ? ` at ${partialWork.commit.slice(0, 12)}${partialWork.branch ? ` on ${partialWork.branch}` : ''}${partialWork.path ? ` (${partialWork.path})` : ''}` : '';
    return performed[performed.push(await record(state, key, { kind: 'preserve', work: item.key, principal, epoch, state: 'done', detail: `${item.key} attempt ${epoch} ${observed}. Partial work ${partialWork.state}${where}${partialWork.detail ? `: ${partialWork.detail}` : ''}; the attempt ended on the record and the next attempt's request names the commit`, attempts, cycle: state.cycle }, now(), effects.persist)) - 1];
  } catch (error) {
    return performed[performed.push(await record(state, key, { kind: 'preserve', work: item.key, principal, epoch, state: 'failed', detail: `${item.key} attempt ${epoch} ${observed}, but its partial work could not be put on the record: ${message(error)}`, attempts, cycle: state.cycle }, now(), effects.persist)) - 1];
  }
}
