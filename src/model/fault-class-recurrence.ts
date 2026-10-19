import { isDelivered } from './closure.js';
import { closesFaultClass } from './fault-classes.js';
import type { FaultClass, FaultClassPolicy, FaultInstance } from './fault-classes.js';
import type { Work } from './work.js';

// Recurrence reading for the fault classes, beside the record the loop keeps (fault-record.ts):
// when a delivered item's fix was first known running, and which classes recur in the window.
// The loop files no work item for a recurring class (GY-2186): a class past its threshold is one
// master-status attention line. What survives here serves triage, which still closes previously
// filed fault-class items against the fix that answered them, and project memory's pitfall record.
// This module is browser-safe: the dashboard classifies with it too.

/**
 * When a delivered item's fix is first known running (GY-1830): the instant the recorded deployment
 * observation saw a release serving the merge — `deployment.observedAt`, the observer's own
 * instant, not `at`, the later server time the record's write was stamped with, which would read an
 * instance first seen between the two as predating a fix already known running — else GitHub's
 * merge time when none is recorded. A fix merged but not yet running has answered nothing. Null
 * when neither instant is recorded.
 */
export function landedAt(work: Pick<Work, 'delivery' | 'observation'>): number | null {
  const merged = Date.parse(work.delivery?.mergedAt ?? work.observation?.mergedAt ?? '');
  const serving = Date.parse(work.delivery?.deployment?.observedAt ?? '');
  const at = Number.isFinite(serving) ? Math.max(merged, serving) : merged;
  return Number.isFinite(at) ? at : null;
}
/**
 * The newest delivered item naming `faultClass`, with its landing (GY-1632): a delivered item filed
 * for the class, or the delivered item a recurring item of the class was closed as a duplicate of.
 * Null when no such item has a recorded merge. Triage reads it to close a previously filed
 * fault-class item whose instances all predate the fix that answered them.
 */
export function deliveredFaultClassCover(work: readonly Work[], faultClass: FaultClass): { item: Work; landedAt: number } | null {
  const answers = new Set(work.filter(item => closesFaultClass(item) === faultClass && item.closure?.kind === 'duplicate' && item.closure.ref).map(item => item.closure!.ref!));
  let cover: { item: Work; landedAt: number } | null = null;
  for (const item of work) {
    if (!isDelivered(item) || !(closesFaultClass(item) === faultClass || answers.has(item.key))) continue;
    const at = landedAt(item);
    if (at !== null && (!cover || at > cover.landedAt)) cover = { item, landedAt: at };
  }
  return cover;
}
/** Whether every instance listed was first seen before `landing`: none of them postdates the delivered fix. */
export const predateLanding = (instances: readonly { at: string }[], landing: number) => instances.every(entry => Date.parse(entry.at) < landing);

export interface ClassRecurrence { faultClass: FaultClass; count: number; recent: FaultInstance[] }
/** Every class whose instances in the policy window reach `count` at least once, largest first (GY-2186): the recurrence the master-status attention names. */
export function recurringClasses(instances: readonly FaultInstance[], policy: FaultClassPolicy, now: number): ClassRecurrence[] {
  const from = now - policy.windowHours * 3_600_000;
  const byClass = new Map<FaultClass, FaultInstance[]>();
  for (const entry of instances) {
    const at = Date.parse(entry.at);
    if (at < from || at > now) continue;
    const recent = byClass.get(entry.faultClass) ?? [];
    recent.push(entry);
    byClass.set(entry.faultClass, recent);
  }
  return [...byClass].map(([faultClass, recent]) => ({ faultClass, count: recent.length, recent }))
    .sort((a, b) => b.count - a.count || a.faultClass.localeCompare(b.faultClass));
}
