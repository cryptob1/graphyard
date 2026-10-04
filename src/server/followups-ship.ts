import type pg from 'pg';
import { demand, operatorCapability, type Principal, type Work } from '../model.js';
import { followUpEntries, followUpParent, followUpShipSchema, mergeFollowUpEntries, openFollowUpItem, appendedDescription, type FollowUpEntry } from '../model/machine-backlog.js';
import { followUpParentMigrationEvent, followUpShipReceiptKey, foldUnshippedFollowUps, shippedFollowUpsOwed } from '../model/followups-held.js';
import { coalescedScope, plannedScope, shippedFollowUpItem } from '../review-threads.js';
import { endLapsedAttempt } from '../pipeline-speed.js';
import { isStandIn, lockedWork } from '../store/locked-read.js';
import { save } from '../store.js';
import { settleOpenRequests } from './close.js';
import { authenticated, digest, receipt } from './decisions.js';
import { followUpPaths, plannedFilesMax } from '../model/scope.js';
import type { Services } from './routes.js';

// Review follow-ups held on their parent until it ships (GY-845; model/machine-backlog.ts): a
// delivered parent's held findings filed as its one follow-up item, the one-time fold of unshipped
// parents' follow-up items back onto them, and the helpers the follow-up routes share.
export type Db = pg.PoolClient;
// The named items, what overlaps them and their dependencies whole and locked; the rest as compact stand-ins (GY-1027).
export const readAll = (db: Db, focus: string[] = []): Promise<Work[]> => lockedWork(db, focus, { forUpdate: true });
export const recordDispatch = (services: Services, db: Db, work: Work, now: Date) =>
  (services.engine as unknown as { recordDispatch(db: Db, work: Work, now: Date): Promise<void> }).recordDispatch(db, work, now);
/** The master's identities: its coordinator, its operator agent (holding `intent:create`), or an admin. */
export function masterOnly(actor: Principal, work: Work | undefined, services: Services, what: string) {
  demand(['admin', 'coordinator', 'operator-agent'].includes(actor.role), `Only the master (coordinator or operator agent) or an admin may ${what}`, 403);
  if (actor.role === 'operator-agent') operatorCapability(actor, 'intent:create', work, services.repository);
}

/** Append `incoming` to an open follow-up item, deduplicated, saving it only when it gained a finding. */
export async function appendToItem(services: Services, db: Db, actor: Principal, work: Work, parent: string, incoming: FollowUpEntry[], heading: string, all: Work[], now: Date, details: Record<string, unknown>) {
  const { findings, added } = mergeFollowUpEntries(followUpEntries(work), incoming);
  if (added.length) {
    work.origin = { ...work.origin, reviewFollowUps: { parent, findings } };
    work.description = appendedDescription(work.description ?? '', added, heading);
    const addedPaths = followUpPaths(added).map(plannedScope).filter((path): path is string => !!path);
    work.plannedFiles = coalescedScope([...(work.plannedFiles ?? []), ...addedPaths]).slice(0, plannedFilesMax);
    services.engine.evaluate(work, all, now);
    await recordDispatch(services, db, work, now);
    await save(db, work, actor.id, 'followups.appended', now, { parent, added: added.length, ...details });
  }
  return { findings, added };
}

/**
 * File a delivered parent's held findings as its one follow-up item, depending on nothing (GY-845),
 * or append them to the follow-up item it already has open.
 * The findings and the create key are frozen on the parent first (`followups.filing`), so a retry
 * sends the engine's create the same body under the same key and never files twice; then the parent
 * records the item (`followups.filed`). Findings held after the freeze join the new item, or, if it
 * is no longer open, stay held for the next filing.
 */
export async function shipFollowUps(services: Services, caller: Principal, id: string, body: unknown, key: string) {
  const data = followUpShipSchema.parse(body);
  const fingerprint = digest({ id, ship: true });
  const frozen = await services.engine.store.transaction(async (db, now) => {
    const actor = await authenticated(services, db, now, caller);
    const all = await readAll(db, [id]);
    const parent = all.find(item => item.id === id || item.key === id); demand(parent, 'Work item not found', 404);
    masterOnly(actor, parent, services, 'file held review follow-ups');
    // Answered per hold: a hold reopened after an earlier filing never replays that filing's receipt.
    const scoped = followUpShipReceiptKey(key, parent!);
    const replay = await receipt(db, actor, scoped, fingerprint); if (replay) return { replay };
    const held = parent!.pendingFollowUps;
    demand(held && !held.dropped && (held.filing && !held.filed || shippedFollowUpsOwed(parent!)), `${parent!.key} is not a delivered item holding follow-ups to file`, 409);
    // One open follow-up item per parent, in any stage: one already open takes the held findings.
    const open = held!.filing ? undefined : openFollowUpItem(all, parent!.key);
    if (open) {
      const openItem = isStandIn(open) ? (await readAll(db, [parent!.id, open.id])).find(item => item.id === open.id)! : open;
      const count = held!.findings.length;
      await appendToItem(services, db, actor, openItem, parent!.key, held!.findings, `Held on ${parent!.key} until it shipped:`, all, now, { reason: data.reason });
      parent!.pendingFollowUps = { ...held!, filed: { item: openItem.key, at: now.toISOString() } };
      await save(db, parent!, actor.id, 'followups.filed', now, { item: openItem.key, findings: count, later: 0, appended: true });
      const result = { key: openItem.key, findings: count };
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, scoped, fingerprint, JSON.stringify(result)]);
      return { replay: result };
    }
    if (!held!.filing) {
      held!.filing = { key: `followups-after-ship:${parent!.key}:${digest(held!.findings).slice(0, 16)}`, count: held!.findings.length, at: now.toISOString() };
      await save(db, parent!, actor.id, 'followups.filing', now, { ...held!.filing, reason: data.reason });
    }
    return { actor, parent: parent!, scoped, filing: held!.filing, findings: held!.findings.slice(0, held!.filing.count) };
  });
  if ('replay' in frozen) return frozen.replay;
  const { actor, parent, scoped, filing, findings } = frozen;
  const item = shippedFollowUpItem({ key: parent.key, pr: parent.candidate?.pr ?? null, mergeSha: parent.delivery?.mergeSha ?? null }, findings);
  const created = await services.engine.execute(caller, 'create', null, item, filing.key);
  return services.engine.store.transaction(async (db, now) => {
    const all = await readAll(db, [parent.id, created.id]);
    const current = all.find(entry => entry.id === parent.id)!, filed = all.find(entry => entry.id === created.id)!;
    const held = current.pendingFollowUps!;
    const result = { key: created.key, findings: filing.count };
    if (held.filing?.key === filing.key && !held.filed) {
      const later = held.findings.slice(filing.count);
      current.pendingFollowUps = later.length && filed.stage === 'done' ? { findings: later, at: now.toISOString(), filing: null, filed: null } : { ...held, filed: { item: created.key, at: now.toISOString() } };
      await save(db, current, actor.id, 'followups.filed', now, { item: created.key, findings: filing.count, later: later.length });
      if (later.length && filed.stage !== 'done') await appendToItem(services, db, actor, filed, current.key, later, `Held on ${current.key} after this item was filed:`, all, now, { reason: 'held after filing' });
    }
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [actor.id, scoped, fingerprint, JSON.stringify(result)]);
    return result;
  });
}
/**
 * The one-time fold of GY-845: each open follow-up item whose parent has not shipped is closed as
 * superseded by the parent, its findings held there (`followUpParentMigrationEvent`); a parent
 * closed without shipping drops what it then holds, saying why. Nothing is deleted; a second run
 * returns the first run's record. Items deferred under a live lease leave the migration unfinished:
 * no record is written, so the next ask folds them once their lease has ended.
 */
export async function migrateToParents(services: Services, db: Db, actor: Principal, now: Date) {
  const previous = (await db.query('SELECT payload FROM events WHERE kind=$1 ORDER BY seq LIMIT 1', [followUpParentMigrationEvent])).rows[0]?.payload;
  if (previous) return { ...previous, already: true };
  const compact = await readAll(db);
  const unshipped = compact.filter(item => item.stage !== 'done' && followUpParent(item));
  const parentKeys = new Set(unshipped.map(item => followUpParent(item)!));
  const focus = [...unshipped.map(item => item.id), ...compact.filter(item => parentKeys.has(item.key)).map(item => item.id)];
  const all = await readAll(db, focus);
  const { folded, parents, dropped, deferred } = foldUnshippedFollowUps(all, actor.id, now);
  for (const { work, parent } of folded) {
    const settled = settleOpenRequests(work, work.closure!, now);
    if (work.lease) { endLapsedAttempt(work, work.lease, now); work.lease = null; }
    services.engine.evaluate(work, all, now);
    Object.assign(work, { queue: null, mergeAuthorization: null });
    await recordDispatch(services, db, work, now);
    await save(db, work, actor.id, 'work.closed', now, { closure: work.closure, actor: actor.id, reason: work.closure!.reason, migration: followUpParentMigrationEvent, parent: parent.key, cancelled: settled.cancelled.map(request => request.id) });
  }
  for (const parent of parents) await save(db, parent, actor.id, 'followups.held', now, { migration: followUpParentMigrationEvent, findings: parent.pendingFollowUps?.findings.length ?? 0,
    folded: folded.filter(entry => entry.parent === parent).map(entry => entry.work.key), dropped: parent.pendingFollowUps?.dropped?.reason ?? null });
  const payload = { folded: folded.length, at: now.toISOString(), by: actor.id, parents: parents.map(parent => ({ key: parent.key, folded: folded.filter(entry => entry.parent === parent).map(entry => entry.work.key), held: parent.pendingFollowUps?.findings.length ?? 0 })),
    dropped: dropped.map(entry => ({ key: entry.parent.key, findings: entry.dropped, reason: entry.parent.pendingFollowUps!.dropped!.reason })) };
  if (deferred.length) return { ...payload, deferred: deferred.map(item => item.key) };
  await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, followUpParentMigrationEvent, JSON.stringify(payload)]);
  return payload;
}
