import { z } from 'zod';
import { demand, type Principal } from '../model.js';
import { approvalConflict, approveCapability, assertDecisionAuthority, decisionRefusalSchema, decisionRequestSchema } from '../model/approval.js';
import { authenticated, digest, findWork, readDecisions, receipt, record } from './decisions.js';
import type { Services } from './routes.js';

/**
 * The approver's considered decline, recorded rather than expressed by ending the session: the
 * decision moves to the terminal `refused` state carrying the approver, the reason and the time.
 * Only an identity that could have approved it may refuse it — the requester takes its own
 * request back with a withdrawal, and a conflicted identity's judgement is no judgement at all.
 */
export async function refuseDecision(services: Services, caller: Principal, id: string, body: unknown, key: string) {
  const data = decisionRefusalSchema.parse(body);
  const fingerprint = digest({ id, refuse: data.decision, reason: data.reason });
  return services.engine.store.transaction(async (db, now) => {
    const actor = await authenticated(services, db, now, caller);
    const replay = await receipt(db, actor, key, fingerprint); if (replay) return replay;
    const work = await findWork(db, id); demand(work, 'Work item not found', 404);
    const decision = (await readDecisions(db, work!)).find(entry => entry.id === data.decision);
    demand(decision, `Decision ${data.decision} does not exist on ${work!.key}`, 404);
    demand(actor.id !== decision!.requestedBy, `The requester cannot refuse its own decision: ${actor.id} requested ${decision!.id}; an independent approver refuses it, and the requester takes it back with graphyard master withdraw ${work!.key} ${decision!.id} REASON`, 403);
    const conflict = approvalConflict(decision!, actor, work!);
    demand(!conflict, conflict!, 403);
    assertDecisionAuthority(actor, approveCapability, work!, services.repository);
    demand(decision!.state === 'requested', `Decision ${decision!.id} is already ${decision!.state}; only a requested decision can be refused`, 409);
    await record(db, work!, actor.id, 'decision.declined', { id: decision!.id, action: decision!.action, reason: data.reason, requestedBy: decision!.requestedBy, approver: { id: actor.id, role: actor.role } });
    const result = (await readDecisions(db, work!)).find(entry => entry.id === decision!.id)!;
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
    return result;
  });
}

const withdrawalSchema = z.object({ decision: z.string().uuid(), reason: decisionRequestSchema.shape.reason }).strict();

/**
 * The requester's way out of a request that must not wait for an approver: recorded as
 * 'withdrawn' — terminal, with the reason — so a new request of the same action is accepted.
 */
export async function withdrawDecision(services: Services, caller: Principal, id: string, body: unknown, key: string) {
  const { action: _action, ...rest } = (body ?? {}) as Record<string, unknown>;
  const data = withdrawalSchema.parse(rest);
  const fingerprint = digest({ id, withdraw: data.decision, reason: data.reason });
  return services.engine.store.transaction(async (db, now) => {
    const actor = await authenticated(services, db, now, caller);
    const replay = await receipt(db, actor, key, fingerprint); if (replay) return replay;
    const work = await findWork(db, id); demand(work, 'Work item not found', 404);
    const decision = (await readDecisions(db, work!)).find(entry => entry.id === data.decision);
    demand(decision, `Decision ${data.decision} does not exist on ${work!.key}`, 404);
    demand(actor.id === decision!.requestedBy, `Only the requester may withdraw decision ${decision!.id}; ${decision!.requestedBy} requested it`, 403);
    demand(decision!.state === 'requested', `Decision ${decision!.id} is already ${decision!.state}; only a requested decision can be withdrawn`, 409);
    await record(db, work!, actor.id, 'decision.withdrawn', { id: decision!.id, action: decision!.action, reason: data.reason });
    const result = (await readDecisions(db, work!)).find(entry => entry.id === decision!.id)!;
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
    return result;
  });
}
