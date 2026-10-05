import { z } from 'zod';
import { Refusal, demand, itemLane, reworkNeedsApprover, type Principal, type Work } from '../model.js';
import { assertDecisionAuthority, decisionPrecondition, requiredDecisionCapabilities } from '../model/approval.js';
import { readDecisions, type DecisionRecord } from './decision-ledger.js';
import { applyThroughEngine, authenticated, findWork, receipt, record } from './decisions.js';
import type { Services } from './routes.js';

// A rework on a low- or medium-lane item needs no approver decision (GY-883 AC-2): the risk lane
// approves and applies it. Approval and application are separate transactions, so an interruption
// between them is resumed here rather than left standing approved (GY-1110).

/** The ledger's approver of a rework its lane applied without an approver decision (GY-883). */
export const laneApprover = 'graphyard-risk-lane';

/**
 * Resume every rework on the item the risk lane approved but whose application recorded neither
 * decision.applied nor decision.failed (GY-1110): its approval and its application are separate
 * steps, and an interruption between them left it approved forever, refusing every later rework.
 * The engine call is keyed by the decision, so a resumption never applies a rework twice.
 *
 * Resumption is best-effort (GY-1244): an unexpected fault while applying one stranded rework is
 * logged and leaves it approved for the next request to resume, rather than failing the request
 * that triggered the resumption — an unrelated unblock or close is never held hostage by it.
 */
export async function resumeLaneReworks(services: Services, id: string): Promise<DecisionRecord[]> {
  const stranded = await services.engine.store.transaction(async db => {
    const work = await findWork(db, id);
    return work ? (await readDecisions(db, work)).filter(decision => decision.action === 'rework' && decision.state === 'approved' && decision.approvedBy === laneApprover) : [];
  });
  const settled: DecisionRecord[] = [];
  for (const decision of stranded) {
    try { settled.push(await applyLaneRework(services, decision)); }
    catch (error) { console.error(`lane rework ${decision.id} on ${id} could not be resumed; the next request retries it:`, error instanceof Error ? error.message : 'unknown'); }
  }
  return settled;
}

/** A request answered by a resumed decision keeps its receipt, so its replay answers the same. */
export async function answerWith(services: Services, caller: Principal, key: string, fingerprint: string, decision: DecisionRecord) {
  return services.engine.store.transaction(async (db, now) => {
    const actor = await authenticated(services, db, now, caller);
    const replay = await receipt(db, actor, key, fingerprint); if (replay) return replay;
    const work = await findWork(db, decision.workId); demand(work, 'Work item not found', 404);
    for (const capability of requiredDecisionCapabilities(decision.action, decision.input, work!)) assertDecisionAuthority(actor, capability, work!, services.repository);
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(decision)]);
    return decision;
  });
}

export async function applyLaneRework(services: Services, requested: DecisionRecord): Promise<DecisionRecord> {
  let applying: { decision: DecisionRecord; work: Work; reason: string } | null = null;
  const settled = await services.engine.store.transaction(async db => {
    const work = await findWork(db, requested.workId); demand(work, 'Work item not found', 404);
    const decision = (await readDecisions(db, work!)).find(entry => entry.id === requested.id)!;
    const resuming = decision.state === 'approved' && decision.approvedBy === laneApprover;
    if (!resuming && (decision.state !== 'requested' || reworkNeedsApprover(work!))) return decision;
    const lane = itemLane(work!), reason = `the ${lane} risk lane applies a rework without an approver decision (GY-883)`;
    if (!resuming) {
      const precondition = decisionPrecondition(decision.action, decision.input, work!);
      if (precondition) return decision;
      await record(db, work!, laneApprover, 'decision.approved', { id: decision.id, action: decision.action, reason, requestedBy: decision.requestedBy, approver: { id: laneApprover, role: 'risk-lane' }, lane });
    }
    applying = { decision, work: work!, reason };
    return null;
  });
  if (settled) return settled;
  const { decision, work, reason } = applying!;
  let outcome: { kind: string; details: object };
  try { outcome = { kind: 'decision.applied', details: { outcome: await applyThroughEngine(services, decision, { id: laneApprover, role: 'admin' } as Principal, reason) } }; }
  catch (error) {
    if (!(error instanceof Refusal) && !(error instanceof z.ZodError)) throw error;
    outcome = { kind: 'decision.failed', details: { error: error.message } };
  }
  return services.engine.store.transaction(async db => {
    // Two resumers may race; the first outcome settles the decision and the second records none.
    const current = (await readDecisions(db, work)).find(entry => entry.id === decision.id)!;
    if (current.state !== 'approved') return current;
    await record(db, work, laneApprover, outcome.kind, { id: decision.id, ...outcome.details });
    return (await readDecisions(db, work)).find(entry => entry.id === decision.id)!;
  });
}
