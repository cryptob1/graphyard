import type pg from 'pg';
import { demand, operatorCapability, type Principal, type Work } from '../model.js';
import { isDelivered } from '../model/closure.js';
import { appendedDescription, followUpAppendSchema, followUpEntries, followUpParent, mergeDuplicateFollowUps, mergeFollowUpEntries, triageRecordSchema, untriaged, type FollowUpEntry } from '../model/machine-backlog.js';
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
 */
export async function appendFollowUps(services: Services, caller: Principal, id: string, body: unknown, key: string) {
  const data = followUpAppendSchema.parse(body);
  const fingerprint = digest({ id, followups: data });
  return services.engine.store.transaction(async (db, now) => {
    const actor = await authenticated(services, db, now, caller);
    const replay = await receipt(db, actor, key, fingerprint); if (replay) return replay as unknown as { key: string; added: number };
    const all = await readAll(db);
    const work = all.find(item => item.id === id || item.key === id); demand(work, 'Work item not found', 404);
    masterOnly(actor, work, services, 'append review follow-ups');
    const parent = followUpParent(work!);
    demand(parent && work!.stage !== 'done', `${work!.key} is not an open follow-up item`, 409);
    const { findings, added } = mergeFollowUpEntries(followUpEntries(work!), data.findings as FollowUpEntry[]);
    if (added.length) {
      work!.origin = { ...work!.origin, reviewFollowUps: { parent: parent!, findings } };
      work!.description = appendedDescription(work!.description ?? '', added, `Added by a later approval of ${parent} (${data.reason.slice(0, 300)}):`);
      services.engine.evaluate(work!, all, now);
      await recordDispatch(services, db, work!, now);
      await save(db, work!, actor.id, 'followups.appended', now, { parent, added: added.length, offered: data.findings.length, reason: data.reason });
    }
    const result = { key: work!.key, added: added.length, findings: findings.length };
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
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
    const replay = await receipt(db, actor, key, digest({ migrate: 'followups' })); if (replay) return replay;
    const previous = (await db.query('SELECT payload FROM events WHERE kind=$1 ORDER BY seq LIMIT 1', [followUpMigrationEvent])).rows[0]?.payload;
    if (previous) return { ...previous, already: true };
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
