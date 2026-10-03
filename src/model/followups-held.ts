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

/**
 * Review follow-ups triage notes for GY-1047 (approved review follow-ups of GY-845 / PR #528):
 * - Finding 1, 9, 16, 18, 23, 25: `followUpShipKey` incorporates the hold's timestamp (`at`) into
 *   the idempotency key so that reopening a hold on an already-delivered parent generates a fresh key
 *   and avoids replaying the cached receipt. Modifications to `src/reviewer.ts` and `src/server/followups-ship.ts`
 *   are declined here as outside planned scope (`plannedFiles: ['src/model/followups-held.ts', 'tests/followups-after-ship.test.ts']`);
 *   `followUpShipKey` is exported for use by `src/reviewer.ts` and the server route in a follow-up item.
 * - Finding 2: `deliver` in unit tests updates Postgres directly to avoid end-to-end merge queue and
 *   CI overhead while isolating follow-up transitions; real delivery through the engine observation path
 *   is verified by `tests/soak.test.ts`.
 * - Finding 4, 13: `foldUnshippedFollowUps` skips items with an active lease (`item.lease`) to avoid
 *   ending a worker's in-progress attempt without notice, and returns them in `deferred` so callers
 *   can defer writing the final migration ledger event until leased items conclude.
 * - Finding 22: `foldUnshippedFollowUps` indexes parents in a `Map<string, Work>`, eliminating the
 *   quadratic O(n²) `all.find` scan during the migration transaction.
 * - Findings 3, 5-8, 10-12, 14-15, 17, 19-21, 24: Declined with recorded reasons (see PR description);
 *   all lie in modules outside planned scope (`src/server/followups.ts`, `src/server/followups-ship.ts`,
 *   `src/reviewer.ts`, `src/model/machine-backlog.ts`, `src/review-threads.ts`, `src/model/invariants.ts`,
 *   `tests/soak.test.ts`).
 */

/**
 * Idempotency key for filing held follow-ups after ship (GY-845, GY-1047; findings 1, 9, 16, 18, 23, 25).
 * Incorporates the hold's timestamp so a re-hold after an earlier filing generates a distinct key
 * and avoids replaying the cached receipt of the previous filing.
 */
export function followUpShipKey(parent: Pick<Parent, 'key' | 'pendingFollowUps'>): string {
  const at = parent.pendingFollowUps?.at ?? '';
  return `followups-after-ship:${parent.key}${at ? `:${at}` : ''}`;
}

/** The ledger kind of the one-time fold of unshipped parents' follow-up items (GY-845); its presence makes a second run a no-op. */
export const followUpParentMigrationEvent = 'followups.parent-migrated';
/**
 * The one-time migration (GY-845): each open follow-up item whose parent has not shipped folds its
 * findings back onto the parent and is closed as superseded by it, naming it. Nothing is deleted. A
 * parent already closed without shipping drops what it then holds. Items are changed in place.
 *
 * Finding 4 & 13: items in build under a live lease (`item.lease`) are skipped so in-progress attempts
 * are not aborted without notice; they are returned in `deferred` so callers can defer finalizing
 * the migration.
 * Finding 22: parents are indexed by key in a Map so parent lookup is O(1) instead of O(n²).
 */
export function foldUnshippedFollowUps(all: Work[], actor: string, now: Date) {
  const folded: { work: Work; parent: Work; added: number }[] = [], parents = new Set<Work>(), deferred: Work[] = [];
  const parentsByKey = new Map<string, Work>();
  for (const item of all) parentsByKey.set(item.key, item);
  for (const item of all) {
    if (item.lease) {
      const key = open(item) ? followUpParent(item) : null, parent = key ? parentsByKey.get(key) : undefined;
      if (parent && !hasShipped(parent)) deferred.push(item);
      continue;
    }
    const key = open(item) ? followUpParent(item) : null, parent = key ? parentsByKey.get(key) : undefined;
    if (!parent || hasShipped(parent)) continue;
    const { added } = holdFollowUps(parent, followUpEntries(item), now);
    const closure: Closure = { kind: 'superseded', ref: parent.key, by: actor, at: now.toISOString(), from: item.stage,
      reason: `Folded back onto ${parent.key}, which has not shipped: its follow-ups wait there and become one follow-up item when it is delivered (GY-845 follow-up migration)` };
    Object.assign(item, { closure, stage: 'done', stageEnteredAt: now.toISOString(), ready: false, queue: null, mergeAuthorization: null, reviewRequest: null, scopeRequest: null, blocker: null });
    folded.push({ work: item, parent, added: added.length }); parents.add(parent);
  }
  const dropped = [...parents].map(parent => ({ parent, dropped: dropHeldFollowUps(parent, now) }));
  return { folded, parents: [...parents], dropped: dropped.filter(entry => entry.dropped), deferred };
}
