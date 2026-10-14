import type pg from 'pg';
import { demand, type Principal, type Work } from '../model.js';
import { isDelivered } from '../model/closure.js';
import { appendedDescription, followUpEntries, followUpParent, mergeFollowUpEntries, triageRecordSchema, triageWithdrawalSchema, untriaged } from '../model/machine-backlog.js';
import { save } from '../store.js';
import { lockedWork } from '../store/locked-read.js';
import { closeWork } from './close.js';
import { authenticated, digest, receipt } from './decisions.js';
import type { Services } from './routes.js';

// The control plane's half of the machine-filed backlog (GY-402): the triage agent's judgement
// recorded on an item, and a triage closure applied once an approver agreed. Review follow-ups are
// no longer recorded, held, filed or promoted (GY-1249); follow-up items filed before then are
// triaged like any machine-filed item. See model/machine-backlog.ts.

export type Db = pg.PoolClient;
// The named items, what overlaps them and their dependencies whole and locked; the rest as compact stand-ins (GY-1027).
const readAll = (db: Db, focus: string[] = []): Promise<Work[]> => lockedWork(db, focus, { forUpdate: true });
const recordDispatch = (services: Services, db: Db, work: Work, now: Date) =>
  (services.engine as unknown as { recordDispatch(db: Db, work: Work, now: Date): Promise<void> }).recordDispatch(db, work, now);

/**
 * `POST /api/work/ID/triage`: the loop records the triage agent's judgement of a machine-filed item
 * that awaits triage, as the coordinator. A release is applied at once: the item takes the priority
 * and is released to ready. A closure or merge is recorded `proposed`; the loop requests the `close`
 * decision for it and it is applied only once an independent approver approves it.
 */
export async function recordTriage(services: Services, caller: Principal, id: string, body: unknown, key: string) {
  if (body && typeof body === 'object' && 'withdraw' in body) return withdrawTriage(services, caller, id, body, key);
  const data = triageRecordSchema.parse(body);
  const fingerprint = digest({ id, triage: data });
  return services.engine.store.transaction(async (db, now) => {
    const actor = await authenticated(services, db, now, caller);
    const replay = await receipt(db, actor, key, fingerprint); if (replay) return replay as unknown as Work;
    demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
    const all = await readAll(db, [id]);
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
 * `POST /api/work/ID/triage` with `withdraw`: the loop withdraws a closure it proposed whose grounds no longer hold
 * (GY-1632: a recurrence after the delivered fix landed was linked to the item while the proposal awaited its
 * approver). The proposal is marked refused with the reason, so the item returns to triage and the close decision
 * bound to it no longer matches (decisionPrecondition): an approval of it applies nothing. A proposal already
 * judged, or replaced by a later one, is left as it stands.
 */
async function withdrawTriage(services: Services, caller: Principal, id: string, body: unknown, key: string) {
  const { withdraw } = triageWithdrawalSchema.parse(body);
  const fingerprint = digest({ id, triage: { withdraw } });
  return services.engine.store.transaction(async (db, now) => {
    const actor = await authenticated(services, db, now, caller);
    const replay = await receipt(db, actor, key, fingerprint); if (replay) return replay as unknown as Work;
    demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
    const work = (await readAll(db, [id])).find(item => item.id === id || item.key === id); demand(work, 'Work item not found', 404);
    if (work!.triage?.state === 'proposed' && work!.triage.at === withdraw.triageAt) {
      work!.triage = { ...work!.triage, state: 'refused', refusal: `Withdrawn by ${actor.id}: ${withdraw.reason}`.slice(0, 2000), at: now.toISOString() };
      await save(db, work!, actor.id, 'triage.withdrawn', now, { triageAt: withdraw.triageAt, reason: withdraw.reason });
    }
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(work)]);
    return work!;
  });
}

/**
 * Apply an approved triage closure: a merge first appends the item's findings to the follow-up item
 * it merges into, deduplicated, then the item is closed (`closeWork`) with the triage record marked
 * applied. The merge creates no item: it adds to one already filed.
 */
export async function applyTriageClosure(services: Services, actor: Principal, workId: string, input: { kind: 'superseded' | 'obsolete' | 'duplicate'; ref: string | null; reason: string; triageAt: string }, decision: string, key: string) {
  const work = await services.engine.store.workDocument(workId); demand(work, 'Work item not found', 404);
  const found = input.kind === 'duplicate' && input.ref ? await services.engine.store.workDocument(input.ref) : undefined;
  const target = found?.key === input.ref ? found : undefined;
  const parent = target ? followUpParent(target) : null;
  if (target && parent && target.stage !== 'done') {
    const findings = followUpParent(work!) ? followUpEntries(work!) : [{ path: null, text: `${work!.key}: ${work!.title}`.slice(0, 2000) }];
    if (findings.length) await services.engine.store.transaction(async (db, now) => {
      const all = await readAll(db, [target.id]), into = all.find(item => item.id === target.id)!;
      const { findings: merged, added } = mergeFollowUpEntries(followUpEntries(into), findings.slice(0, 200));
      if (!added.length || into.stage === 'done') return;
      into.origin = { ...into.origin, reviewFollowUps: { parent, findings: merged } };
      into.description = appendedDescription(into.description ?? '', added, `Added by triage, merged from ${work!.key}:`);
      services.engine.evaluate(into, all, now);
      await recordDispatch(services, db, into, now);
      await save(db, into, actor.id, 'followups.appended', now, { parent, added: added.length, reason: `merged from ${work!.key} by triage`, key: `${key}:merge`.slice(0, 200) });
    });
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
