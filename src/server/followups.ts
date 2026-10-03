import { demand, operatorCapability, type Principal, type Work } from '../model.js';
import { isClosed, isDelivered } from '../model/closure.js';
import { foldFollowUpBatch, followUpAppendSchema, followUpEntries, followUpParent, followUpPromotedEvent, followUpPromoteSchema, followUpRecordedEvent, mergeDuplicateFollowUps, mergeFollowUpEntries, openFollowUpItem, triageRecordSchema, untriaged, type FollowUpBatch, type FollowUpBatchRow, type FollowUpEntry } from '../model/machine-backlog.js';
import { holdFollowUps, releasePromotedFollowUp } from '../model/followups-held.js';
import { save } from '../store.js';
import { closeWork, settleOpenRequests } from './close.js';
import { authenticated, digest, receipt } from './decisions.js';
import { appendToItem, masterOnly, migrateToParents, readAll, recordDispatch, shipFollowUps, type Db } from './followups-ship.js';
import { impliedModuleCluster } from '../model/scope-companions.js';
import { namedPaths, plannedFilesMax } from '../model/scope.js';
import type { Services } from './routes.js';

// The control plane's half of the machine-filed backlog (GY-402): a later approval's findings
// appended to the parent's one follow-up item, the one-time migration of the duplicates filed
// before that, the triage agent's judgement recorded on an item, and a triage closure applied once
// an approver agreed. Follow-ups held until their parent ships: followups-ship.ts. See model/machine-backlog.ts.

/**
 * `POST /api/work/ID/followups`: record one approval's non-blocking findings. On an item that is
 * not a follow-up item — the approved item itself — with `parent`, as the loop sends them, they go to
 * its open follow-up item in any stage (GY-845); otherwise they are recorded against its own record as
 * a `followups.recorded` event naming its pull request and head (GY-896) and held on it until it
 * ships (`pendingFollowUps`, GY-845), keeping only those its batch does not already hold by path and
 * finding text. No work item is created then; a parent closed without shipping takes none. On an
 * open legacy follow-up item (GY-402) they are appended to it; a closed or delivered one is refused
 * with 409 "not an open follow-up item". An approval whose every finding is already held changes
 * nothing. A body with `ship` files a delivered parent's held findings as its one follow-up item
 * (`shipFollowUps`).
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
    if (data.parent || !followUpParent(work!)) {
      const approved = work!, open = data.parent ? openFollowUpItem(all, approved.key) : undefined;
      if (open) work = open;
      else if (isClosed(approved)) result = { key: approved.key, added: 0, findings: 0, dropped: approved.pendingFollowUps?.dropped?.reason ?? `${approved.key} was closed without shipping, so its follow-ups are dropped` };
      else {
        const batch = await followUpBatch(db, approved);
        const { findings, added } = mergeFollowUpEntries(batch.findings, data.findings as FollowUpEntry[]);
        if (added.length) {
          holdFollowUps(approved, added, now);
          await save(db, approved, actor.id, followUpRecordedEvent, now,
            { pr: approved.candidate?.pr ?? null, sha: approved.candidate?.sha ?? null, findings: added, offered: data.findings.length, reason: data.reason });
        }
        result = { key: approved.key, added: added.length, findings: findings.length };
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

type Queryable = Pick<Db, 'query'>;
/** The route's operator-scope filter (RouteContext.operatorVisible): a read answers only items its caller may see. */
type Visible = (items: Work[]) => Work[];
/** An item's follow-up batch, folded from its ledger (model/machine-backlog.ts foldFollowUpBatch). */
export async function followUpBatch(db: Queryable, work: Work): Promise<FollowUpBatch> {
  const rows = (await db.query(`SELECT kind, payload->'details' AS details, created_at FROM events WHERE work_id=$1 AND kind = ANY($2::text[]) ORDER BY seq`,
    [work.id, [followUpRecordedEvent, followUpPromotedEvent]])).rows as { kind: string; details: FollowUpBatchRow['details']; created_at: Date }[];
  return foldFollowUpBatch(work, rows.map(row => ({ kind: row.kind, details: row.details, at: new Date(row.created_at).toISOString() })));
}

/** `GET /api/work/ID/followups`: the item's follow-up batch, each finding numbered and marked with the item it was promoted to. */
export async function readFollowUps(services: Services, visible: Visible, id: string) {
  const work = visible(await services.engine.store.list()).find(item => item.id === id || item.key === id);
  demand(work, 'Work item not found', 404);
  return followUpBatch(services.engine.store.pool, work!);
}

/**
 * `GET /api/followups?pr=N`: every follow-up batch recorded for pull request N — the items whose
 * approvals recorded findings naming it, and the legacy follow-up items filed for it.
 */
export async function followUpsByPr(services: Services, visible: Visible, params: URLSearchParams) {
  const pr = Number(params.get('pr'));
  demand(Number.isInteger(pr) && pr > 0, 'pr must be a pull request number', 400);
  const recorded = new Set((await services.engine.store.pool.query(`SELECT DISTINCT work_id FROM events WHERE kind=$1 AND payload->'details'->>'pr'=$2`, [followUpRecordedEvent, String(pr)])).rows.map(row => row.work_id as string));
  const items = visible(await services.engine.store.list())
    .filter(item => recorded.has(item.id) || !!followUpParent(item) && item.title.includes(`(PR #${pr})`));
  const batches = await Promise.all(items.map(item => followUpBatch(services.engine.store.pool, item)));
  return { pr, batches: batches.filter(batch => batch.findings.length) };
}

/** The one proof of an item a follow-up finding is promoted into: addressed in code, or declined with a recorded reason. */
export const promotedFindingProof = 'manual:review-followup-addressed';
/**
 * `POST /api/work/ID/promote`: an operator (an admin, or an operator agent holding `intent:create`)
 * promotes finding INDEX of item ID's follow-up batch to a work item of its own (GY-896). The
 * promoted item carries the finding as its criterion, plans the finding's file and depends on the
 * approved item. It is filed once: promotions of one finding are serialized, a promoted finding
 * answers the item it became, and the create is sent under a key derived from the finding, so a
 * promotion interrupted after its create repeats that create rather than filing a second item.
 */
export async function promoteFollowUp(services: Services, caller: Principal, id: string, body: unknown) {
  const { index } = followUpPromoteSchema.parse(body);
  const store = services.engine.store;
  const target = (await store.list()).find(item => item.id === id || item.key === id); demand(target, 'Work item not found', 404);
  const lock = await store.pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`graphyard-followup-promote:${target!.id}:${index}`]);
    const all = await store.list();
    const work = all.find(item => item.id === target!.id)!;
    const actor = await store.transaction(async (db, now) => authenticated(services, db, now, caller));
    demand(actor.role === 'admin' || actor.role === 'operator-agent', 'Only an operator (an admin or an operator agent) may promote a follow-up finding', 403);
    if (actor.role === 'operator-agent') operatorCapability(actor, 'intent:create', work, services.repository);
    const batch = await followUpBatch(store.pool, work);
    const finding = batch.findings[index - 1];
    demand(batch.findings.length, `${work.key} holds no follow-up findings`, 404);
    demand(finding, `${work.key} holds ${batch.findings.length} follow-up finding(s); there is no finding ${index}`, 404);
    const parentKey = followUpParent(work);
    const parent = parentKey ? all.find(item => item.id === work.dependencies?.[0] || item.key === parentKey) : work;
    demand(parent, `The followed-up item ${parentKey} was not found`, 404);
    const promoted = { from: work.key, finding: index, parent: parent!.key };
    if (finding!.promoted) return { promoted, item: all.find(item => item.key === finding!.promoted) ?? { key: finding!.promoted }, duplicate: true };
    const title = `Promoted follow-up of ${parent!.key} (${work.key} finding ${index}): ${finding!.text}`.slice(0, 200);
    const findingPaths = [...new Set([
      ...(finding!.path ? [finding!.path.slice(0, 500)] : []),
      ...namedPaths(finding!.text),
    ])];
    const cluster = impliedModuleCluster(findingPaths, finding!.text);
    const plannedFiles = [...new Set([...findingPaths, ...cluster])].slice(0, plannedFilesMax);
    const input = {
      title,
      description: `Promoted from finding ${index} of ${work.key}'s follow-up batch${parentKey ? `, filed for ${parent!.key}` : ''}${finding!.pr ? ` (PR #${finding!.pr})` : ''}${finding!.ref ? `; raised at ${finding!.ref}` : ''}.\n\nFinding${finding!.path ? ` (${finding!.path})` : ''}: ${finding!.text}`.slice(0, 20000),
      type: 'chore', priority: 2, dependencies: [parent!.id],
      criteria: [{ id: 'AC-1', text: `The promoted finding is addressed in code, or declined with a recorded reason: ${finding!.text}`.slice(0, 2000), proofs: [promotedFindingProof] }],
      producerProofs: [promotedFindingProof],
      plannedFiles,
      reason: `Promoted from ${work.key} finding ${index} by ${actor.id}`.slice(0, 2000),
    };
    // A create that landed before an interrupted promotion recorded it: the item is found, not filed again.
    const created: Work = all.find(item => item.title === title && item.dependencies?.includes(parent!.id))
      ?? await services.engine.execute(caller, 'create', null, input, `followup-promote:${work.id}:${index}`.slice(0, 200)) as Work;
    await store.transaction(async (db, now) => {
      const current = (await db.query('SELECT document FROM work_items WHERE id=$1 FOR UPDATE', [work.id])).rows[0].document as Work;
      // Promoted, the finding no longer waits on the parent to ship (GY-845): the filing takes the rest.
      const released = !parentKey && releasePromotedFollowUp(current, finding!);
      await save(db, current, actor.id, followUpPromotedEvent, now, { index, key: created.key, path: finding!.path, text: finding!.text, ...(released ? { released: true } : {}) });
    });
    return { promoted, item: created, duplicate: false };
  } finally {
    await lock.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`graphyard-followup-promote:${target!.id}:${index}`]).catch(() => undefined);
    lock.release();
  }
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
