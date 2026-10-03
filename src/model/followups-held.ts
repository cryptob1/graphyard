import { isClosed, type Closure } from './closure.js';
import { followUpEntries, followUpEntryKey, followUpParent, hasShipped, mergeFollowUpEntries, type FollowUpEntry, type Parent } from './machine-backlog.js';
import type { Work } from './work.js';

// Review follow-ups held on their parent until it ships (GY-845; the record and `hasShipped` are in
// machine-backlog.ts): holding an approval's findings, what is owed once the parent ships, dropping
// them when it closes unshipped, the `master status` report, and the one-time fold of unshipped
// parents' follow-up items back onto them.

const open = (work: Pick<Work, 'stage'>) => work.stage !== 'done';
/** The findings a parent holds that still wait to be filed or dropped. */
export const heldFollowUps = (parent: Pick<Parent, 'pendingFollowUps'>) => {
  const held = parent.pendingFollowUps;
  return held && !held.filed && !held.dropped ? held.findings : [];
};
/** Whether a delivered parent's held findings are owed a follow-up item now. */
export const shippedFollowUpsOwed = (parent: Parent) => hasShipped(parent) && heldFollowUps(parent).length > 0;
/**
 * `findings` held on the parent, deduplicated as a follow-up item's are; `added` names the new ones.
 * Findings held after the parent's earlier ones were filed (its item since closed) start a new hold
 * with a new filing, never the old item's.
 */
export function holdFollowUps(parent: Parent, findings: readonly FollowUpEntry[], now: Date) {
  const merged = mergeFollowUpEntries(heldFollowUps(parent), findings), previous = parent.pendingFollowUps;
  if (merged.added.length) parent.pendingFollowUps = { ...previous, findings: merged.findings, at: now.toISOString(), filing: previous?.filed || previous?.dropped ? null : previous?.filing ?? null, filed: null, dropped: null };
  return merged;
}
/** A finding promoted to its own item (GY-896) no longer waits on the parent; a filing already frozen keeps it. */
export function releasePromotedFollowUp(parent: Parent, finding: FollowUpEntry) {
  const held = parent.pendingFollowUps;
  if (!held || held.filing || held.filed || held.dropped) return false;
  const findings = held.findings.filter(entry => followUpEntryKey(entry) !== followUpEntryKey(finding));
  if (findings.length === held.findings.length) return false;
  parent.pendingFollowUps = { ...held, findings };
  return true;
}
/** A parent closed without shipping drops what it holds, recording why; the count dropped is returned. */
export function dropHeldFollowUps(parent: Parent, now: Date) {
  const held = heldFollowUps(parent);
  if (!held.length || !isClosed(parent)) return 0;
  parent.pendingFollowUps = { ...parent.pendingFollowUps!, dropped: { at: now.toISOString(),
    reason: `${parent.key} was closed as ${parent.closure!.kind} without shipping (${parent.closure!.reason.slice(0, 500)}), so its ${held.length} pending follow-up finding(s) are dropped rather than filed` } };
  return held.length;
}
/**
 * The pending follow-ups `master status` lists: each parent holding findings not yet filed, with
 * what happens to them next — filed as its follow-up item once it ships, or on the next pass once it has.
 */
export function pendingFollowUpsReport(all: readonly (Parent & Pick<Work, 'title'>)[]) {
  return all.filter(parent => heldFollowUps(parent).length).map(parent => {
    const shipped = hasShipped(parent), findings = heldFollowUps(parent);
    return { parent: parent.key, title: parent.title, stage: parent.stage, shipped, findings: findings.length, sample: findings.slice(0, 3).map(finding => finding.text.slice(0, 200)),
      next: shipped ? `${parent.key} shipped: the loop files these as its one follow-up item on its next pass` : `held on ${parent.key} until it ships, then filed as its one follow-up item` };
  });
}

/** The ledger kind of the one-time fold of unshipped parents' follow-up items (GY-845); its presence makes a second run a no-op. */
export const followUpParentMigrationEvent = 'followups.parent-migrated';
/**
 * The one-time migration (GY-845): each open follow-up item whose parent has not shipped folds its
 * findings back onto the parent and is closed as superseded by it, naming it. Nothing is deleted. A
 * parent already closed without shipping drops what it then holds. Items are changed in place.
 */
export function foldUnshippedFollowUps(all: Work[], actor: string, now: Date) {
  const folded: { work: Work; parent: Work; added: number }[] = [], parents = new Set<Work>();
  for (const item of all) {
    const key = open(item) ? followUpParent(item) : null, parent = key ? all.find(entry => entry.key === key) : undefined;
    if (!parent || hasShipped(parent)) continue;
    const { added } = holdFollowUps(parent, followUpEntries(item), now);
    const closure: Closure = { kind: 'superseded', ref: parent.key, by: actor, at: now.toISOString(), from: item.stage,
      reason: `Folded back onto ${parent.key}, which has not shipped: its follow-ups wait there and become one follow-up item when it is delivered (GY-845 follow-up migration)` };
    Object.assign(item, { closure, stage: 'done', stageEnteredAt: now.toISOString(), ready: false, queue: null, mergeAuthorization: null, reviewRequest: null, scopeRequest: null, blocker: null });
    folded.push({ work: item, parent, added: added.length }); parents.add(parent);
  }
  const dropped = [...parents].map(parent => ({ parent, dropped: dropHeldFollowUps(parent, now) }));
  return { folded, parents: [...parents], dropped: dropped.filter(entry => entry.dropped) };
}
