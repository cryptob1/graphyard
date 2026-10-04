import { createHash } from 'node:crypto';
import { isClosed, type Closure } from './closure.js';
import { demand } from './refusal.js';
import { followUpEntries, followUpEntryKey, followUpParent, hasShipped, mergeFollowUpEntries, type FollowUpEntry, type Parent } from './machine-backlog.js';
import type { Work } from './work.js';

// Review follow-ups held on their parent until it ships (GY-845; the record and `hasShipped` are in
// machine-backlog.ts): holding an approval's findings, what is owed once the parent ships, dropping
// them when it closes unshipped, the `master status` report, and the one-time fold of unshipped
// parents' follow-up items back onto them.

const open = (work: Pick<Work, 'stage'>) => work.stage !== 'done';
const liveLease = (work: Pick<Work, 'lease'>, now: Date) => !!work.lease && Date.parse(work.lease.expiresAt) > now.getTime();
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
 * Review follow-ups triage notes for GY-1047 and its follow-ups GY-1136, GY-1141:
 * - GY-1047 findings 1, 9, 16, 18, 23, 25 / GY-1136 findings 1, 5: the ship route
 *   (src/server/followups-ship.ts) answers under `followUpShipReceiptKey`, the caller's key scoped to
 *   the hold's timestamp (`at`), so a hold reopened on an already-delivered parent is filed instead of
 *   replaying the earlier filing's receipt under the dispatcher's fixed key. The unused client-side
 *   `followUpShipKey` is removed: the server owns the scoping, so src/reviewer.ts needs no change.
 * - GY-1047 finding 2 / GY-1136 finding 8: declined. The unit tests' `deliver` writes the delivered
 *   document straight to Postgres, and `tests/soak.test.ts` also calls `shipHeldFollowUps` with a stub
 *   ship, so neither drives delivery through `engine.observe`. The follow-up path reads delivery only
 *   through `hasShipped` (machine-backlog.ts), which these tests exercise on the same fields the
 *   observation path writes (`stage: 'done'`, no closure, `delivery.mergeSha`); the observation path
 *   writing those fields is covered by the merge-observation tests, not here.
 * - GY-1047 findings 4, 13 / GY-1136 findings 2, 3, 4, 6, 7: `foldUnshippedFollowUps` skips an open
 *   item only under a live lease (`expiresAt` after `now`), so a lapsed one folds; skipped items are
 *   returned in `deferred`, and `migrateToParents` (src/server/followups-ship.ts) records the one-time
 *   migration event only once nothing is deferred, so the next ask folds them after their lease ends.
 * - GY-1047 finding 22: `foldUnshippedFollowUps` indexes parents in a `Map<string, Work>`.
 * - GY-1141 findings 1, 4, 5 (src/server/followups-ship.ts, src/server/followups.ts): declined with recorded reason.
 *   The server-side implementation at src/server/followups.ts:168 and src/server/followups-ship.ts:103 already executes
 *   migrateToParents ahead of the GY-402 receipt replay on every call under the fixed migration key until the
 *   followups.parent-migrated event is recorded, so retrying deferred parent migrations is already supported and verified
 *   server-side (tested by tests/followups-after-ship.test.ts:190). The client-side premature migrated = true flag and
 *   note formatting in src/daemon/cycle-triage.ts:29 lies in the daemon and is outside the planned files of this item;
 *   attempting to refuse deferred migrations with HTTP 409 breaks the existing contract of POST /api/followups/migrate
 *   which unit tests pin at 200 OK with parents.deferred. Client-side handling of deferred items is left to a daemon-scoped item.
 * - GY-1141 finding 2: followUpShipReceiptKey ensures the scoped key length never exceeds the 200-character
 *   Idempotency-Key limit by incorporating a digest when key@at > 200, preventing 400 errors on 176-200
 *   character caller keys.
 * - GY-1141 finding 3 (src/server/followups-ship.ts): lapsed migration leases end via endLapsedAttempt
 *   (pipeline-speed.ts) as 'expired' at their deadline rather than 'released' at migration time, avoiding
 *   inflated recorded execution.
 * - GY-1141 finding 6 (src/regression-guard.ts): declined. The companion branch at src/regression-guard.ts:50
 *   is GY-1023's delivered implied-scope-companion mechanism (PR #535) — it passes only on a content-verified
 *   companion verdict (timingBaselineCompanion limits edits to the change's own test files' lines) and
 *   refuses everything else; any residue belongs with GY-1058.
 * - GY-1141 finding 7 (src/model/action-kinds.ts): workerSlotWait excludes terminated worker session states
 *   (killed, terminated, exited, etc.) from busy launch profiles so terminated sessions are not treated as
 *   slot capacity waits and stall attention is not deferred 30 minutes.
 *
 * GY-1176 review follow-ups (from the approved review of GY-1141, PR #624):
 * - Findings 2, 6, 9 (raw keys hashed before validation): fixed. followUpShipReceiptKey refuses a raw
 *   Idempotency-Key past idempotencyKeyLimit with 400 before scoping it, like receipt() on every other mutation.
 * - Findings 4, 7, 10 (hardcoded 200): fixed. idempotencyKeyLimit is the one bound; receipt() and
 *   followUpShipReceiptKey both read it.
 * - Findings 3, 5, 8 (src/model/action-kinds.ts): fixed. terminatedAgentStates moved above workerSlotWait's JSDoc.
 * - Finding 1 (undocumented key behavior): fixed. docs/protocol/work-commands.md states the 200-character
 *   bound and that the ship route scopes the key to the hold, hashing a scoped key that would pass the bound.
 */

/** The longest `Idempotency-Key` a mutation accepts, raw or scoped; `receipt` (src/server/decisions.ts) enforces it (GY-1176). */
export const idempotencyKeyLimit = 200;

/**
 * The receipt a request to file a parent's held follow-ups is answered under (GY-845, GY-1047, GY-1136, GY-1141):
 * the caller's idempotency key scoped to the hold's timestamp. A retry within one hold replays its
 * receipt, while a hold reopened after an earlier filing is filed afresh, whatever fixed key the
 * dispatcher sends (`followups-after-ship:GY-N`). The caller's raw key is refused with 400 past
 * `idempotencyKeyLimit`, as on every other mutation (GY-1176); a scoped key that would pass the limit
 * keeps a prefix of the raw key and a hash of all of it, so it stays within the limit (GY-1141).
 */
export function followUpShipReceiptKey(key: string, parent: Pick<Parent, 'pendingFollowUps'>): string {
  demand(key && key.length <= idempotencyKeyLimit, 'An Idempotency-Key is required', 400);
  const at = parent.pendingFollowUps?.at;
  if (!at) return key;
  const candidate = `${key}@${at}`;
  if (candidate.length <= idempotencyKeyLimit) return candidate;
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
  const prefix = key.slice(0, idempotencyKeyLimit - 1 - at.length - 1 - hash.length);
  return `${prefix}:${hash}@${at}`;
}

/** The ledger kind of the one-time fold of unshipped parents' follow-up items (GY-845); its presence makes a second run a no-op. */
export const followUpParentMigrationEvent = 'followups.parent-migrated';
/**
 * The one-time migration (GY-845): each open follow-up item whose parent has not shipped folds its
 * findings back onto the parent and is closed as superseded by it, naming it. Nothing is deleted. A
 * parent already closed without shipping drops what it then holds. Items are changed in place.
 *
 * An open item under a live lease (one whose `expiresAt` is after `now`) is skipped so an attempt in
 * progress is not ended without notice; it is returned in `deferred`, and the caller leaves the
 * migration unfinished until none are. A lapsed lease folds like no lease. Parents are indexed by key.
 */
export function foldUnshippedFollowUps(all: Work[], actor: string, now: Date) {
  const folded: { work: Work; parent: Work; added: number }[] = [], parents = new Set<Work>(), deferred: Work[] = [];
  const parentsByKey = new Map<string, Work>();
  for (const item of all) parentsByKey.set(item.key, item);
  for (const item of all) {
    const key = open(item) ? followUpParent(item) : null, parent = key ? parentsByKey.get(key) : undefined;
    if (!parent || hasShipped(parent)) continue;
    if (liveLease(item, now)) { deferred.push(item); continue; }
    const { added } = holdFollowUps(parent, followUpEntries(item), now);
    const closure: Closure = { kind: 'superseded', ref: parent.key, by: actor, at: now.toISOString(), from: item.stage,
      reason: `Folded back onto ${parent.key}, which has not shipped: its follow-ups wait there and become one follow-up item when it is delivered (GY-845 follow-up migration)` };
    Object.assign(item, { closure, stage: 'done', stageEnteredAt: now.toISOString(), ready: false, queue: null, mergeAuthorization: null, reviewRequest: null, scopeRequest: null, blocker: null });
    folded.push({ work: item, parent, added: added.length }); parents.add(parent);
  }
  const dropped = [...parents].map(parent => ({ parent, dropped: dropHeldFollowUps(parent, now) }));
  return { folded, parents: [...parents], dropped: dropped.filter(entry => entry.dropped), deferred };
}
