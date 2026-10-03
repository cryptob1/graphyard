import { z } from 'zod';
import { demand, type Principal, type Work } from '../model.js';
import { approvalConflict, approveCapability, assertDecisionAuthority, decisionRefusalSchema, decisionRequestSchema, type DecisionSituation } from '../model/approval.js';
import { scopeRefusalBlocker, unplannedPaths } from '../model/scope.js';
import { save } from '../store.js';
import { authenticated, digest, findWork, readDecisions, receipt, record } from './decisions.js';
import type { Services } from './routes.js';
import { refuseTriageClosure } from './followups.js';

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
    await liftRefusedReworkMergeRefusal(db, work!, decision!, actor, data.reason, now);
    // A refused triage closure returns the item to triage (GY-402).
    if (decision!.action === 'close') await refuseTriageClosure(db, work!, decision!, actor.id, data.reason, now);
    const result = (await readDecisions(db, work!)).find(entry => entry.id === decision!.id)!;
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
    return result;
  });
}

/**
 * A `rework` merge refusal (GY-831) holds the candidate out of the merge queue until a rework
 * decision rebinds it. When the independent approver refuses that rework — the candidate needs no
 * change, every gate passes — nothing else ever lifts the refusal, and the entry waited forever
 * (GY-973 for 14 hours, GY-1005 for hours on 2026-10-01; approval→merge p90 reached 59 h). The
 * refusal is lifted in the same transaction, for exactly the candidate it named, so the entry
 * re-enters the queue on the loop's next cycle and the guarded merge re-checks every gate.
 *
 * The approver judged the request, not whatever hold the item carries when the refusal arrives:
 * the decision's recorded `situation` (GY-229) must name the refusal's head and base, so refusing
 * a rework requested for head H on base B1 never clears a later refusal of H on base B2 — both
 * share the binding `H:merge-refused`. A decision recorded without a situation names no base and
 * lifts nothing. A refusal under an older policy revision already holds nothing
 * (`standingMergeRefusal`), so it is not "lifted" either (GY-1073).
 */
type JudgedRework = { action: string; input?: { binding?: string } | undefined; situation?: DecisionSituation | null };
export const refusedReworkLiftsMergeRefusal = (work: Pick<Work, 'mergeRefusal' | 'candidate' | 'policyRevision'>, decision: JudgedRework) => {
  const refusal = work.mergeRefusal, candidate = work.candidate, judged = decision.situation;
  // Only the rework requested on the merge-refusal ground judges it: a rework of the same head on
  // another ground (a failed check, a thread — each its own binding, GY-407) says nothing of it.
  return decision.action === 'rework' && refusal?.action === 'rework' && !!candidate && refusal.sha === candidate.sha && refusal.baseSha === candidate.baseSha
    && refusal.policyRevision === work.policyRevision
    && decision.input?.binding === `${refusal.sha}:merge-refused`
    && !!judged && judged.sha === refusal.sha && judged.baseSha === refusal.baseSha;
};
async function liftRefusedReworkMergeRefusal(db: Parameters<typeof save>[0], work: Work, decision: JudgedRework & { id: string }, actor: Principal, reason: string, now: Date) {
  if (!refusedReworkLiftsMergeRefusal(work, decision)) return;
  const refusal = work.mergeRefusal!;
  work.mergeRefusal = null;
  await save(db, work, actor.id, 'merge.refusal.lifted', now, { decision: decision.id, sha: refusal.sha, baseSha: refusal.baseSha, approver: actor.id, reason: reason.slice(0, 2000) });
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
 * names is answered; one withdrawn, re-asked or outlived by its lease is left as it stands, and so
 * is one whose requirements moved on since the decision was requested: a decline judged against a
 * superseded policy revision is no answer to the request as it now stands, exactly as the approval
 * path refuses that stale input (`decisionPrecondition`), so the request stays undecided.
 */
async function answerScopeRequest(db: Parameters<typeof save>[0], work: Work, decision: { id: string; action: string; input: any }, actor: Principal, reason: string, now: Date) {
  const answers = decision.action === 'requirements' ? decision.input?.answers : undefined, request = work.scopeRequest;
  // The same liveness the approval path demands: a lease that has expired, reconciled or not, is
  // no attempt to answer, and its item is not written to on that attempt's behalf.
  const live = !!work.lease && work.lease.epoch === answers?.epoch && Date.parse(work.lease.expiresAt) > now.getTime();
  const current = decision.input?.expectedPolicyRevision === work.policyRevision;
  if (!answers || !request || request.epoch !== answers.epoch || request.at !== answers.at || !live || !current) return;
  // What was refused is what the approver judged: the paths still outside plannedFiles, not those a
  // partial widening has planned since the worker asked.
  const refused = unplannedPaths(work.plannedFiles, request.paths), paths = refused.length ? refused : request.paths;
  work.scopeDecision = { state: 'refused', reason, at: now.toISOString(), decidedBy: actor.id, waitedMs: Math.max(0, now.getTime() - Date.parse(request.at)), paths, requestedBy: request.requestedBy, requestedAt: request.at, epoch: request.epoch };
  work.scopeRequest = { ...request, decision: work.scopeDecision };
  // The refusal replaces only a scope refusal (the rule's, which it answers) or no blocker at all: a
  // blocker the worker reported meanwhile is its own hand-off, and withdrawing the ask — which lifts
  // only a scope-refusal blocker — must not clear it. The refusal itself is held in scopeDecision.
  if (!work.blocker || work.blocker.startsWith(scopeRefusalBlocker)) work.blocker = `${scopeRefusalBlocker} by the independent approver ${actor.id} (decision ${decision.id}): ${reason}`.slice(0, 2000);
  await save(db, work, actor.id, 'scope.refused', now, { decision: decision.id, epoch: request.epoch, requestedAt: request.at, paths, approver: actor.id, reason });
}
