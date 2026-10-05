import { z } from 'zod';
import { Refusal, demand, itemLane, reworkNeedsApprover, type Principal, type Work } from '../model.js';
import { assertDecisionAuthority, decisionPrecondition, requiredDecisionCapabilities } from '../model/approval.js';
import { decisionRace, readDecisions, type DecisionRecord, type StaleRace } from './decision-ledger.js';
import { applyThroughEngine, authenticated, findWork, receipt, record, requesterAuthority, staleEvent } from './decisions.js';
import type { Services } from './routes.js';

// A rework on a low- or medium-lane item needs no approver decision (GY-883 AC-2): the risk lane
// approves and applies it. Approval and application are separate transactions for every action but
// resolve and merge, so an interruption between them is resumed here rather than left standing
// approved: first only the lane's own (GY-1110), now any approver's (GY-1300).

/** The ledger's approver of a rework its lane applied without an approver decision (GY-883). */
export const laneApprover = 'graphyard-risk-lane';

/**
 * A decision approved whose application recorded no outcome (GY-1300): neither decision.applied,
 * decision.failed nor decision.stale follows its decision.approved. Resolve and merge are applied in
 * the approval's own transaction, so they never strand.
 */
export const approvedUnapplied = (decision: Pick<DecisionRecord, 'state' | 'action'>) =>
  decision.state === 'approved' && decision.action !== 'resolve' && decision.action !== 'merge';

/**
 * Resume every decision on the item that was approved but whose application recorded no outcome
 * (GY-1110 for the risk lane, GY-1300 for every approver): its approval and its application are
 * separate steps, and an interruption between them — a crash, a restart, a server fault — left it
 * approved forever, refusing every later request of its action. The approval already carries the
 * approver's authorization, so the resumption replays exactly what was approved; nothing is approved
 * here. The engine call is keyed by the decision, so a resumption never applies a decision twice.
 *
 * Resumption is best-effort (GY-1244): an unexpected fault while applying one stranded decision is
 * logged and leaves it approved for the next request to resume, rather than failing the request
 * that triggered the resumption — an unrelated unblock or close is never held hostage by it.
 */
export async function resumeApprovedDecisions(services: Services, id: string): Promise<DecisionRecord[]> {
  const stranded = await services.engine.store.transaction(async db => {
    const work = await findWork(db, id);
    return work ? (await readDecisions(db, work)).filter(approvedUnapplied) : [];
  });
  const settled: DecisionRecord[] = [];
  for (const decision of stranded) {
    try { settled.push(await resumeApproved(services, decision)); }
    catch (error) { console.error(`approved decision ${decision.id} on ${id} could not be resumed; the next request retries it:`, error instanceof Error ? error.message : 'unknown'); }
  }
  return settled;
}

const resumeSchema = z.object({ decision: z.string().uuid() }).strict();

/**
 * The loop's own way to apply one approved-unapplied decision (GY-1300), beside decide and withdraw
 * on the same route: `{ action: 'resume', decision }`. A caller with authority for the decision's
 * action asks the server to replay what its approver approved; it never approves anything. A
 * decision that already recorded an outcome is answered as it stands.
 */
export async function resumeDecision(services: Services, caller: Principal, id: string, body: unknown, key: string): Promise<DecisionRecord> {
  const { action: _action, ...rest } = (body ?? {}) as Record<string, unknown>;
  const data = resumeSchema.parse(rest);
  const standing = await services.engine.store.transaction(async (db, now) => {
    const actor = await authenticated(services, db, now, caller);
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const work = await findWork(db, id); demand(work, 'Work item not found', 404);
    const decision = (await readDecisions(db, work!)).find(entry => entry.id === data.decision);
    demand(decision, `Decision ${data.decision} does not exist on ${work!.key}`, 404);
    for (const capability of requiredDecisionCapabilities(decision!.action, decision!.input, work!)) assertDecisionAuthority(actor, capability, work!, services.repository);
    return decision!;
  });
  return approvedUnapplied(standing) ? resumeApproved(services, standing) : standing;
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
  const approved = await services.engine.store.transaction(async db => {
    const work = await findWork(db, requested.workId); demand(work, 'Work item not found', 404);
    const decision = (await readDecisions(db, work!)).find(entry => entry.id === requested.id)!;
    if (decision.state !== 'requested' || reworkNeedsApprover(work!) || decisionPrecondition(decision.action, decision.input, work!)) return decision;
    const lane = itemLane(work!), reason = `the ${lane} risk lane applies a rework without an approver decision (GY-883)`;
    await record(db, work!, laneApprover, 'decision.approved', { id: decision.id, action: decision.action, reason, requestedBy: decision.requestedBy, approver: { id: laneApprover, role: 'risk-lane' }, lane });
    return (await readDecisions(db, work!)).find(entry => entry.id === requested.id)!;
  });
  return approvedUnapplied(approved) && approved.approvedBy === laneApprover ? resumeApproved(services, approved) : approved;
}

/**
 * Apply one approved decision under its recorded approval (GY-1300): the lane's own application,
 * and the resumption of any approver's whose outcome was lost. It is idempotent and single-outcome.
 * The engine call is the one approveDecision makes — the same key (decision:<id>), actor, input and
 * approval reason — so a call that already ran is replayed, never run twice; a requester whose
 * authority is gone, or a refusal, settles it failed, and a refusal from a revision race (the
 * situation it was pinned to has moved) settles it stale through recordStale's entry, so it stops
 * blocking. The outcome is written only while the decision still stands approved: of two resumers,
 * or a resumer and its approver repeating the approval, the first outcome settles it.
 */
export async function resumeApproved(services: Services, stranded: DecisionRecord): Promise<DecisionRecord> {
  const approver = { id: stranded.approvedBy!, role: 'admin' } as Principal;
  let outcome: { kind: string; details: { outcome?: string; error?: string } }, race: StaleRace | null = null;
  try {
    // The requester's authority is re-read, as the approval's own resumption reads it. An engine call that never ran is
    // judged against the situation the decision was pinned to: one the item has moved past settles stale, never applies.
    // One that ran (its decision-keyed receipt stands) moved that situation itself, and is only replayed.
    const moved = await services.engine.store.transaction(async db => {
      const work = await findWork(db, stranded.workId); demand(work, 'Work item not found', 404);
      await requesterAuthority(services, db, stranded, work!);
      if ((await db.query('SELECT 1 FROM receipts WHERE actor=$1 AND key=$2', [stranded.requestedBy, `decision:${stranded.id}`])).rowCount) return null;
      const pinned = decisionRace(stranded, work!);
      return pinned && { race: pinned, error: decisionPrecondition(stranded.action, stranded.input, work!) ?? `${work!.key} moved past the situation the decision was pinned to` };
    });
    race = moved?.race ?? null;
    outcome = moved ? { kind: 'decision.stale', details: { error: moved.error } }
      : { kind: 'decision.applied', details: { outcome: await applyThroughEngine(services, stranded, approver, stranded.approvalReason ?? '') } };
  } catch (error) {
    if (!(error instanceof Refusal) && !(error instanceof z.ZodError)) throw error;
    outcome = { kind: 'decision.failed', details: { error: error.message } };
  }
  return services.engine.store.transaction(async db => {
    const work = await findWork(db, stranded.workId); demand(work, 'Work item not found', 404);
    const current = (await readDecisions(db, work!)).find(entry => entry.id === stranded.id)!;
    if (current.state !== 'approved') return current;
    // A refusal from a revision race settles stale too: the item moved while the call was being made.
    race = outcome.kind === 'decision.applied' ? null : race ?? decisionRace(current, work!);
    if (race) await staleEvent(db, { actor: approver, workId: work!.id, decision: current, reason: `${outcome.details.error}; the decision was not applied`, ...race });
    else await record(db, work!, approver.id, outcome.kind, { id: current.id, ...outcome.details });
    return (await readDecisions(db, work!)).find(entry => entry.id === stranded.id)!;
  });
}
