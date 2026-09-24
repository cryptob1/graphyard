import { z } from 'zod';
import { demand, type Principal, type Work } from '../model.js';
import { approvalConflict, approveCapability, assertDecisionAuthority, decisionRefusalSchema, decisionRequestSchema } from '../model/approval.js';
import { scopeRefusalBlocker } from '../model/scope.js';
import { save } from '../store.js';
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
    await answerScopeRequest(db, work!, decision!, actor, data.reason, now);
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

/**
 * A refused widening that answers a worker's scope request (GY-176) is that request's decision:
 * kept on the item, in the same transaction, where the asking worker's own `status` and
 * `scope-request --wait` read it — the approver, its reason, and that the attempt stays inside
 * plannedFiles — rather than sent to its session. Only the open request of the live attempt it
 * names is answered; one withdrawn, re-asked or outlived by its lease is left as it stands.
 */
async function answerScopeRequest(db: Parameters<typeof save>[0], work: Work, decision: { id: string; action: string; input: any }, actor: Principal, reason: string, now: Date) {
  const answers = decision.action === 'requirements' ? decision.input?.answers : undefined, request = work.scopeRequest;
  if (!answers || !request || request.epoch !== answers.epoch || request.at !== answers.at || work.lease?.epoch !== answers.epoch) return;
  work.scopeDecision = { state: 'refused', reason, at: now.toISOString(), decidedBy: actor.id, waitedMs: Math.max(0, now.getTime() - Date.parse(request.at)), paths: request.paths, requestedBy: request.requestedBy, requestedAt: request.at };
  work.scopeRequest = { ...request, decision: work.scopeDecision };
  work.blocker = `${scopeRefusalBlocker} by the independent approver ${actor.id} (decision ${decision.id}): ${reason}`.slice(0, 2000);
  await save(db, work, actor.id, 'scope.refused', now, { decision: decision.id, epoch: request.epoch, requestedAt: request.at, paths: request.paths, approver: actor.id, reason });
}
