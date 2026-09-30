import type pg from 'pg';
import { demand, operatorCapability, type Principal, type Work } from '../model.js';
import { isClosed, isDelivered } from '../model/closure.js';
import { appendedDescription, followUpAppendSchema, followUpEntries, followUpParent, followUpParentMigrationEvent, followUpShipSchema, shippedFollowUpsOwed, foldUnshippedFollowUps, holdFollowUps, mergeDuplicateFollowUps, mergeFollowUpEntries, openFollowUpItem, triageRecordSchema, untriaged, type FollowUpEntry } from '../model/machine-backlog.js';
import { shippedFollowUpItem } from '../review-threads.js';
import { endAttempt } from '../pipeline-speed.js';
import { save } from '../store.js';
import { closeWork, settleOpenRequests } from './close.js';
import { authenticated, digest, receipt } from './decisions.js';
import type { Services } from './routes.js';

// The control plane's half of the machine-filed backlog (GY-402): a later approval's findings
// appended to the parent's one follow-up item, the one-time migration of the duplicates filed
// before that, the triage agent's judgement recorded on an item, and a triage closure applied once
// an approver agreed. See model/machine-backlog.ts.

type Db = pg.PoolClient;
const readAll = async (db: Db): Promise<Work[]> => (await db.query('SELECT document FROM work_items ORDER BY number FOR UPDATE')).rows.map(row => row.document);
const recordDispatch = (services: Services, db: Db, work: Work, now: Date) =>
  (services.engine as unknown as { recordDispatch(db: Db, work: Work, now: Date): Promise<void> }).recordDispatch(db, work, now);
/** The master's identities: its coordinator, its operator agent (holding `intent:create`), or an admin. */
function masterOnly(actor: Principal, work: Work | undefined, services: Services, what: string) {
  demand(['admin', 'coordinator', 'operator-agent'].includes(actor.role), `Only the master (coordinator or operator agent) or an admin may ${what}`, 403);
  if (actor.role === 'operator-agent') operatorCapability(actor, 'intent:create', work, services.repository);
}

/**
 * `POST /api/work/ID/followups`: append one approval's findings to a parent's open follow-up item,
 * keeping only those it does not already hold by path and finding text. An approval whose every
 * finding the item already holds changes nothing. A closed or delivered item is refused with 409
 * "not an open follow-up item", and the loop files the parent's new one instead.
 * With `parent` (GY-845), ID is the approved item and the findings go to its open follow-up item in
 * any stage; with none open, they are held on the parent until it ships (`followups.held`). A body
 * with `ship` files a delivered parent's held findings as its one follow-up item (`shipFollowUps`).
 */
export async function appendFollowUps(services: Services, caller: Principal, id: string, body: unknown, key: string) {
  if (body && typeof body === 'object' && 'ship' in body) return shipFollowUps(services, caller, id, body, key);
  const data = followUpAppendSchema.parse(body);
  const fingerprint = digest({ id, followups: data });
  return services.engine.store.transaction(async (db, now) => {
    const actor = await authenticated(services, db, now, caller);
    const replay = await receipt(db, actor, key, fingerprint); if (replay) return replay as unknown as { key: string; added: number };
    const all = await readAll(db);
    let work = all.find(item => item.id === id || item.key === id); demand(work, 'Work item not found', 404);
    masterOnly(actor, work, services, 'append review follow-ups');
    let result: Record<string, unknown> | null = null;
    if (data.parent) {
      const approved = work!, open = openFollowUpItem(all, approved.key), held = approved.pendingFollowUps;
      if (open) work = open;
      else if (isClosed(approved)) result = { key: approved.key, added: 0, findings: 0, dropped: held?.dropped?.reason ?? `${approved.key} was closed without shipping, so its follow-ups are dropped` };
      else {
        demand(!held?.filed, `${approved.key}'s follow-up item ${held?.filed?.item} is not an open follow-up item`, 409);
        const { findings, added } = holdFollowUps(approved, data.findings as FollowUpEntry[], now);
        if (added.length) await save(db, approved, actor.id, 'followups.held', now, { added: added.length, offered: data.findings.length, reason: data.reason });
        result = { key: approved.key, added: added.length, findings: findings.length, held: true };
      }
    }
    if (!result) {
      const parent = followUpParent(work!);
      demand(parent && work!.stage !== 'done', `${work!.key} is not an open follow-up item`, 409);
      const { findings, added } = await appendToItem(services, db, actor, work!, parent!, data.findings as FollowUpEntry[], `Added by a later approval of ${parent} (${data.reason.slice(0, 300)}):`, all, now, { reason: data.reason, offered: data.findings.length });
      result = { key: work!.key, added: added.length, findings: findings.length };
    }
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
    return result;
  });
}

/** Append `incoming` to an open follow-up item, deduplicated, saving it only when it gained a finding. */
async function appendToItem(services: Services, db: Db, actor: Principal, work: Work, parent: string, incoming: FollowUpEntry[], heading: string, all: Work[], now: Date, details: Record<string, unknown>) {
  const { findings, added } = mergeFollowUpEntries(followUpEntries(work), incoming);
  if (added.length) {
    work.origin = { ...work.origin, reviewFollowUps: { parent, findings } };
    work.description = appendedDescription(work.description ?? '', added, heading);
    services.engine.evaluate(work, all, now);
    await recordDispatch(services, db, work, now);
    await save(db, work, actor.id, 'followups.appended', now, { parent, added: added.length, ...details });
  }
  return { findings, added };
}

/**
 * File a delivered parent's held findings as its one follow-up item, depending on nothing (GY-845).
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
    const replay = await receipt(db, actor, key, fingerprint); if (replay) return { replay };
    const parent = (await readAll(db)).find(item => item.id === id || item.key === id); demand(parent, 'Work item not found', 404);
    masterOnly(actor, parent, services, 'file held review follow-ups');
    const held = parent!.pendingFollowUps;
    demand(held && !held.dropped && (held.filing && !held.filed || shippedFollowUpsOwed(parent!)), `${parent!.key} is not a delivered item holding follow-ups to file`, 409);
    if (!held!.filing) {
      held!.filing = { key: `followups-after-ship:${parent!.key}:${digest(held!.findings).slice(0, 16)}`, count: held!.findings.length, at: now.toISOString() };
      await save(db, parent!, actor.id, 'followups.filing', now, { ...held!.filing, reason: data.reason });
    }
    return { actor, parent: parent!, filing: held!.filing, findings: held!.findings.slice(0, held!.filing.count) };
  });
  if ('replay' in frozen) return frozen.replay;
  const { actor, parent, filing, findings } = frozen;
  const item = shippedFollowUpItem({ key: parent.key, pr: parent.candidate?.pr ?? null, mergeSha: parent.delivery?.mergeSha ?? null }, findings);
  const created = await services.engine.execute(caller, 'create', null, item, filing.key);
  return services.engine.store.transaction(async (db, now) => {
    const all = await readAll(db);
    const current = all.find(entry => entry.id === parent.id)!, filed = all.find(entry => entry.id === created.id)!;
    const held = current.pendingFollowUps!;
    const result = { key: created.key, findings: filing.count };
    if (held.filing?.key === filing.key && !held.filed) {
      const later = held.findings.slice(filing.count);
      current.pendingFollowUps = later.length && filed.stage === 'done' ? { findings: later, at: now.toISOString(), filing: null, filed: null } : { ...held, filed: { item: created.key, at: now.toISOString() } };
      await save(db, current, actor.id, 'followups.filed', now, { item: created.key, findings: filing.count, later: later.length });
      if (later.length && filed.stage !== 'done') await appendToItem(services, db, actor, filed, current.key, later, `Held on ${current.key} after this item was filed:`, all, now, { reason: 'held after filing' });
    }
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [actor.id, key, fingerprint, JSON.stringify(result)]);
    return result;
  });
}

/** The ledger kind of the one-time follow-up migration; its presence is what makes a second run a no-op. */
export const followUpMigrationEvent = 'followups.migrated';
/**
 * `POST /api/followups/migrate`: the one-time migration (GY-402). Each parent's open follow-up items
 * fold into its oldest open one, the rest closed as superseded by it, naming it; nothing is deleted.
 * Each change is saved to the item's history, and the whole run as one `followups.migrated` event
 * carrying the count merged. A second run returns that record and changes nothing.
 */
export async function migrateFollowUps(services: Services, caller: Principal, key: string) {
  return services.engine.store.transaction(async (db, now) => {
    const actor = await authenticated(services, db, now, caller);
    masterOnly(actor, undefined, services, 'migrate review follow-ups');
    const previous = (await db.query('SELECT payload FROM events WHERE kind=$1 ORDER BY seq LIMIT 1', [followUpMigrationEvent])).rows[0]?.payload;
    // The GY-845 fold runs once the GY-402 merge is on record, on the loop's next ask, ahead of the
    // receipt: the loop asks under the one key it always used, whose receipt predates the fold.
    const parents = previous ? await migrateToParents(services, db, actor, now) : null;
    const replay = await receipt(db, actor, key, digest({ migrate: 'followups' })); if (replay) return parents ? { ...replay, parents } : replay;
    if (previous) return { ...previous, already: true, parents };
    const all = await readAll(db);
    const { merged, survivors, closed } = mergeDuplicateFollowUps(all, actor.id, now);
    for (const item of closed) {
      const settled = settleOpenRequests(item, item.closure!, now);
      services.engine.evaluate(item, all, now);
      Object.assign(item, { queue: null, mergeAuthorization: null });
      await recordDispatch(services, db, item, now);
      await save(db, item, actor.id, 'work.closed', now, { closure: item.closure, actor: actor.id, reason: item.closure!.reason, migration: followUpMigrationEvent, cancelled: settled.cancelled.map(request => request.id) });
    }
    for (const survivor of survivors) {
      services.engine.evaluate(survivor.work, all, now);
      await recordDispatch(services, db, survivor.work, now);
      await save(db, survivor.work, actor.id, 'followups.merged', now, { absorbed: survivor.absorbed, added: survivor.added, migration: followUpMigrationEvent });
    }
    const payload = { merged, at: now.toISOString(), by: actor.id, survivors: survivors.map(entry => ({ key: entry.work.key, absorbed: entry.absorbed, added: entry.added })) };
    await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, followUpMigrationEvent, JSON.stringify(payload)]);
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, digest({ migrate: 'followups' }), JSON.stringify(payload)]);
    return payload;
  });
}

/**
 * The one-time fold of GY-845: each open follow-up item whose parent has not shipped is closed as
 * superseded by the parent, its findings held there (`followUpParentMigrationEvent`); a parent
 * closed without shipping drops what it then holds, saying why. Nothing is deleted; a second run
 * returns the first run's record.
 */
async function migrateToParents(services: Services, db: Db, actor: Principal, now: Date) {
  const previous = (await db.query('SELECT payload FROM events WHERE kind=$1 ORDER BY seq LIMIT 1', [followUpParentMigrationEvent])).rows[0]?.payload;
  if (previous) return { ...previous, already: true };
  const all = await readAll(db);
  const { folded, parents, dropped } = foldUnshippedFollowUps(all, actor.id, now);
  for (const { work, parent } of folded) {
    const settled = settleOpenRequests(work, work.closure!, now);
    if (work.lease) { endAttempt(work, work.lease.epoch, 'released', now); work.lease = null; }
    services.engine.evaluate(work, all, now);
    Object.assign(work, { queue: null, mergeAuthorization: null });
    await recordDispatch(services, db, work, now);
    await save(db, work, actor.id, 'work.closed', now, { closure: work.closure, actor: actor.id, reason: work.closure!.reason, migration: followUpParentMigrationEvent, parent: parent.key, cancelled: settled.cancelled.map(request => request.id) });
  }
  for (const parent of parents) await save(db, parent, actor.id, 'followups.held', now, { migration: followUpParentMigrationEvent, findings: parent.pendingFollowUps?.findings.length ?? 0,
    folded: folded.filter(entry => entry.parent === parent).map(entry => entry.work.key), dropped: parent.pendingFollowUps?.dropped?.reason ?? null });
  const payload = { folded: folded.length, at: now.toISOString(), by: actor.id, parents: parents.map(parent => ({ key: parent.key, folded: folded.filter(entry => entry.parent === parent).map(entry => entry.work.key), held: parent.pendingFollowUps?.findings.length ?? 0 })),
    dropped: dropped.map(entry => ({ key: entry.parent.key, findings: entry.dropped, reason: entry.parent.pendingFollowUps!.dropped!.reason })) };
  await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, followUpParentMigrationEvent, JSON.stringify(payload)]);
  return payload;
}

/**
 * `POST /api/work/ID/triage`: the loop records the triage agent's judgement of a machine-filed item
 * that awaits triage, as the coordinator. A release is applied at once: the item takes the priority
 * and is released to ready. A closure or merge is recorded `proposed`; the loop requests the `close`
 * decision for it and it is applied only once an independent approver approves it.
 */
export async function recordTriage(services: Services, caller: Principal, id: string, body: unknown, key: string) {
  const data = triageRecordSchema.parse(body);
  const fingerprint = digest({ id, triage: data });
  return services.engine.store.transaction(async (db, now) => {
    const actor = await authenticated(services, db, now, caller);
    const replay = await receipt(db, actor, key, fingerprint); if (replay) return replay as unknown as Work;
    demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
    const all = await readAll(db);
    const work = all.find(item => item.id === id || item.key === id); demand(work, 'Work item not found', 404);
    demand(untriaged(work!), `${work!.key} is not a machine-filed item awaiting triage`, 409);
    const judgement = data.judgement;
    if (judgement.outcome === 'close' && judgement.ref) {
      const fixer = all.find(item => item.key === judgement.ref);
      demand(fixer && isDelivered(fixer), `${judgement.ref} is not a delivered item, so it has not already fixed ${work!.key}`, 422);
    }
    if (judgement.outcome === 'merge') {
      const into = all.find(item => item.key === judgement.into);
      demand(into && into.id !== work!.id && into.stage !== 'done', `${judgement.into} is not another open item ${work!.key} can merge into`, 422);
    }
    const at = now.toISOString();
    work!.triage = { judgement, state: judgement.outcome === 'release' ? 'applied' : 'proposed', by: actor.id, at, ...(data.runtime ? { runtime: data.runtime } : {}), decision: null, refusal: null };
    if (judgement.outcome === 'release') Object.assign(work!, { priority: judgement.priority, ready: true });
    services.engine.evaluate(work!, all, now);
    await recordDispatch(services, db, work!, now);
    await save(db, work!, actor.id, judgement.outcome === 'release' ? 'triage.released' : 'triage.proposed', now, { judgement, runtime: data.runtime ?? null });
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(work)]);
    return work!;
  });
}

/**
 * Apply an approved triage closure: a merge first appends the item's findings to the follow-up item
 * it merges into, then the item is closed (`closeWork`) with the triage record marked applied.
 */
export async function applyTriageClosure(services: Services, actor: Principal, workId: string, input: { kind: 'superseded' | 'obsolete' | 'duplicate'; ref: string | null; reason: string; triageAt: string }, decision: string, key: string) {
  const all = await services.engine.store.list();
  const work = all.find(item => item.id === workId); demand(work, 'Work item not found', 404);
  const target = input.kind === 'duplicate' && input.ref ? all.find(item => item.key === input.ref) : undefined;
  if (target && followUpParent(target) && target.stage !== 'done') {
    const findings = followUpParent(work!) ? followUpEntries(work!) : [{ path: null, text: `${work!.key}: ${work!.title}`.slice(0, 2000) }];
    if (findings.length) await appendFollowUps(services, actor, target.id, { findings: findings.slice(0, 200), reason: `merged from ${work!.key} by triage`.slice(0, 2000) }, `${key}:merge`.slice(0, 200));
  }
  const closed = await closeWork(services, actor, workId, { kind: input.kind, reason: input.reason, ...(input.ref ? { ref: input.ref } : {}) }, key);
  await services.engine.store.transaction(async (db, now) => {
    const current = (await db.query('SELECT document FROM work_items WHERE id=$1 FOR UPDATE', [workId])).rows[0]?.document as Work | undefined;
    if (!current?.triage || current.triage.at !== input.triageAt || current.triage.state === 'applied') return;
    current.triage = { ...current.triage, state: 'applied', decision };
    await save(db, current, actor.id, 'triage.applied', now, { decision, closure: current.closure ?? null });
  });
  return `Closed ${closed.key} as ${input.kind}${input.ref ? ` of ${input.ref}` : ''}`;
}

/** A refused triage closure returns the item to triage: the next judgement starts its clock from the refusal. */
export async function refuseTriageClosure(db: Db, work: Work, decision: { id: string; input: { triageAt?: string } }, approver: string, reason: string, now: Date) {
  if (work.triage?.state !== 'proposed' || work.triage.at !== decision.input.triageAt) return;
  work.triage = { ...work.triage, state: 'refused', decision: decision.id, refusal: reason.slice(0, 2000), at: now.toISOString() };
  await save(db, work, approver, 'triage.refused', now, { decision: decision.id, reason });
}
