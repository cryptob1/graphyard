import { z } from 'zod';
import { Refusal, demand, itemLane, reworkNeedsApprover, type Principal, type Work } from '../model.js';
import type pg from 'pg';
import { assertDecisionAuthority, decisionPrecondition, requiredDecisionCapabilities, situationLabel, stalledApproval, supersededSituation } from '../model/approval.js';
import { readDecisions, type DecisionRecord } from './decision-ledger.js';
import { applyThroughEngine, authenticated, findWork, receipt, record } from './decisions.js';
import { withdrawDecision } from './decision-refusal.js';
import type { Services } from './routes.js';

// A rework on a low- or medium-lane item needs no approver decision (GY-883 AC-2): the risk lane
// approves and applies it. Approval and application are separate transactions, so an interruption
// between them is resumed here rather than left standing approved (GY-1110). Any other approved
// decision left without an outcome is settled here too (GY-1297): superseded, or resumed.

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

/**
 * A withdrawal, which first settles the decision when it stands approved and unapplied (GY-1297):
 * an approval cannot be taken back, so the loop that finds a standing approval superseded or
 * stalled — its own request, or one a master put to an approver by hand — sends the withdrawal and
 * gets the settlement. Settling needs no requester: the requester, or anyone with the authority to
 * request the decision's action, may settle it, since it only records what the item already shows
 * or applies the approval as given. One the settlement applied is refused naming that, so the loop
 * requests nothing in its place. Taking back a requested decision stays the requester's alone.
 */
export async function withdrawOrSettle(services: Services, caller: Principal, id: string, body: unknown, key: string) {
  const named = typeof (body as any)?.decision === 'string' ? (body as any).decision as string : null;
  const settled = named ? (await settleApprovedDecisions(services, caller, id, named)).find(decision => decision.id === named) : undefined;
  if (settled?.state === 'applied') throw new Refusal(`Decision ${settled.id} (${settled.action}) stood approved by ${settled.approvedBy} with no outcome recorded; its application was resumed and it is applied now (${settled.outcome}), so there is nothing to withdraw`, 409);
  if (settled) return settled;
  // Superseded already, by another request for the item: the loop's history may predate it, and the answer is the same.
  const superseded = named ? await services.engine.store.transaction(async (db, now) => {
    const actor = await authenticated(services, db, now, caller), work = await findWork(db, id);
    const decision = work ? (await readDecisions(db, work)).find(entry => entry.id === named) : undefined;
    return decision?.state === 'superseded' && mayRequest(services, actor, decision, work!) ? decision : undefined;
  }) : undefined;
  return superseded ?? withdrawDecision(services, caller, id, body, key);
}

/** Whether `actor` requested `decision`, or holds the authority to request its action on `work` itself. */
function mayRequest(services: Services, actor: Principal, decision: DecisionRecord, work: Work) {
  if (decision.requestedBy === actor.id) return true;
  try { for (const capability of requiredDecisionCapabilities(decision.action, decision.input, work)) assertDecisionAuthority(actor, capability, work, services.repository); return true; }
  catch (error) { if (error instanceof Refusal) return false; throw error; }
}

/**
 * Settle the item's approved, unapplied decisions (GY-1297; `supersededSituation` and
 * `stalledApproval` in model/approval.ts say when). One whose situation moved is recorded
 * `superseded`, naming the head and base it was bound to and the item's current ones. One whose
 * situation holds and that stood approved past the grace is applied through the engine under its
 * approval — keyed by the decision, so a resumption that races the approval applies it once — and
 * settles applied, or failed naming why: a refusal, or a fault, since a decision left approved after
 * a fault refuses every later request of its action. The risk lane's own approvals are superseded
 * here and resumed by `resumeLaneReworks`. `only` limits the settlement to one decision, which the
 * caller must have requested or be able to request (the withdrawal path). Returns what it settled.
 */
export async function settleApprovedDecisions(services: Services, caller: Principal, id: string, only?: string): Promise<DecisionRecord[]> {
  const found = await services.engine.store.transaction(async (db, now) => {
    const actor = await authenticated(services, db, now, caller);
    const work = await findWork(db, id);
    if (!work) return { superseded: [] as DecisionRecord[], stalled: [] as DecisionRecord[], work: null };
    const history = (await readDecisions(db, work)).filter(decision => decision.state === 'approved' && (!only || (decision.id === only && mayRequest(services, actor, decision, work))));
    const superseded = await supersedeMoved(db, work, history, actor);
    const stalled = history.filter(decision => !superseded.some(entry => entry.id === decision.id) && decision.approvedBy !== laneApprover && stalledApproval(decision, now.getTime()));
    return { superseded, stalled, work };
  });
  const settled = [...found.superseded];
  for (const decision of found.stalled) {
    let outcome: { kind: string; details: object };
    const approver = { id: decision.approvedBy!, role: 'admin' } as Principal;
    try { outcome = { kind: 'decision.applied', details: { outcome: await applyThroughEngine(services, decision, approver, decision.approvalReason ?? 'approved'), resumed: true } }; }
    catch (error) { outcome = { kind: 'decision.failed', details: { error: `Approved by ${decision.approvedBy} at ${decision.approvedAt} but its application was never recorded; resuming it ${error instanceof Refusal || error instanceof z.ZodError ? 'was refused' : 'failed'}: ${error instanceof Error ? error.message : 'unknown'}`.slice(0, 2000), resumed: true } }; }
    settled.push(await services.engine.store.transaction(async db => {
      // The approval's own application, or a second resumer, may have settled it meanwhile; the first outcome stands.
      const current = (await readDecisions(db, found.work!)).find(entry => entry.id === decision.id)!;
      if (current.state !== 'approved') return current;
      await record(db, found.work!, approver.id, outcome.kind, { id: decision.id, ...outcome.details });
      return (await readDecisions(db, found.work!)).find(entry => entry.id === decision.id)!;
    }));
  }
  return settled;
}

/** Record `decision.superseded` for each approved decision whose situation the item has moved past, in the caller's transaction (GY-1297). */
export async function supersedeMoved(db: pg.PoolClient, work: Work, decisions: DecisionRecord[], actor: Principal): Promise<DecisionRecord[]> {
  const settled: DecisionRecord[] = [];
  for (const decision of decisions) {
    const moved = supersededSituation(decision, work);
    if (!moved) continue;
    const reason = `Superseded: approved for ${situationLabel(moved.bound)}, but ${work.key} is now at ${situationLabel(moved.current)}, so it can never apply to what it judged; a ${decision.action} request is judged afresh for the current candidate`;
    await record(db, work, actor.id, 'decision.superseded', { id: decision.id, action: decision.action, reason, bound: moved.bound, current: moved.current, observedBy: { id: actor.id, role: actor.role } });
    settled.push((await readDecisions(db, work)).find(entry => entry.id === decision.id)!);
  }
  return settled;
}
