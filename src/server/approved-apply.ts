import { z } from 'zod';
import { Refusal, demand, type Principal, type Work } from '../model.js';
import { assertDecisionAuthority, decisionRequestSchema, decisionSituation, requiredDecisionCapabilities, type Decision, type DecisionSituation } from '../model/approval.js';
import { readDecisions, type DecisionRecord } from './decision-ledger.js';
import type { Services } from './routes.js';
import { applyThroughEngine, authenticated, digest, findWork, receipt, record, requesterAuthority } from './decisions.js';
import { laneApprover, resumeLaneReworks } from './lane-rework.js';

/**
 * GY-1298. An approval and its application are separate steps for every action the engine applies
 * (all but resolve and merge): an approver whose session ended between them left the decision
 * 'approved' with no outcome, and only that same approver could resume it. Nothing else applied it,
 * and every later request of the action was refused with "wait for it" — GY-949's rework stood
 * approved for 2.5 days behind an approver account out of quota.
 *
 * The independent judgement is already recorded, so applying it needs no second approver: it is
 * applied under its recorded approver exactly as `approveDecision` would resume it, keyed by the
 * decision so a race with that approver never applies it twice. A rework or recover judged a
 * candidate (its `situation`, GY-229); when the item's candidate has moved since, the approval
 * describes a head that no longer stands, so the decision is superseded ('stale') rather than
 * applied, and a request for the current candidate is accepted. A requester that lost its
 * authority, or an application the engine refuses, settles the decision 'failed'.
 */
export async function reconcileApproved(services: Services, id: string, action?: Decision['action'], only?: string): Promise<DecisionRecord[]> {
  const standing = await services.engine.store.transaction(async db => {
    const work = await findWork(db, id);
    return work ? (await readDecisions(db, work)).filter(decision => decision.state === 'approved' && decision.approvedBy !== laneApprover
      && (!action || decision.action === action) && (!only || decision.id === only)) : [];
  });
  const settled: DecisionRecord[] = [];
  for (const decision of standing) {
    try { settled.push(await applyApproved(services, decision)); }
    catch (error) { console.error(`approved decision ${decision.id} on ${id} could not be applied; it is tried again:`, error instanceof Error ? error.message : 'unknown'); }
  }
  return settled;
}

/** Whether a situated decision judged a candidate other than the item's current one (GY-1298). */
export function movedSituation(decision: Pick<Decision, 'action' | 'situation'>, work: Pick<Work, 'candidate'>): { expected: DecisionSituation; current: DecisionSituation } | null {
  const current = decisionSituation(decision.action, work), expected = decision.situation;
  if (!current || !expected) return null;
  return (expected.sha ?? null) === current.sha && (expected.baseSha ?? null) === current.baseSha ? null : { expected, current };
}

async function applyApproved(services: Services, approved: DecisionRecord): Promise<DecisionRecord> {
  const approver: Principal = { id: approved.approvedBy!, role: 'admin', sessionKind: 'ai' };
  const settle = (work: Work, kind: string, details: object) => services.engine.store.transaction(async db => {
    // The approver resuming its own approval may race this; the first outcome settles it.
    const current = (await readDecisions(db, work)).find(entry => entry.id === approved.id)!;
    if (current.state !== 'approved') return current;
    await record(db, work, approver.id, kind, { id: approved.id, ...details });
    return (await readDecisions(db, work)).find(entry => entry.id === approved.id)!;
  });
  const checked = await services.engine.store.transaction(async db => {
    const work = await findWork(db, approved.workId); demand(work, 'Work item not found', 404);
    const decision = (await readDecisions(db, work!)).find(entry => entry.id === approved.id)!;
    if (decision.state !== 'approved') return { work: work!, decision, settled: true as const };
    const moved = movedSituation(decision, work!);
    if (moved) {
      await record(db, work!, approver.id, 'decision.stale', { id: decision.id, action: decision.action, ...moved, observedBy: { id: approver.id, role: approver.role },
        reason: `${work!.key}'s candidate moved from ${moved.expected.sha?.slice(0, 12) ?? 'none'} on ${moved.expected.baseSha?.slice(0, 12) ?? 'none'} to ${moved.current.sha?.slice(0, 12) ?? 'none'} on ${moved.current.baseSha?.slice(0, 12) ?? 'none'} after ${decision.approvedBy} approved this ${decision.action} at ${decision.approvedAt}, and it was never applied; superseded so a decision for the current candidate can be requested` });
      return { work: work!, decision: (await readDecisions(db, work!)).find(entry => entry.id === decision.id)!, settled: true as const };
    }
    return { work: work!, decision, settled: false as const };
  });
  if (checked.settled) return checked.decision;
  let outcome: { kind: string; details: object };
  try {
    await services.engine.store.transaction(db => requesterAuthority(services, db, checked.decision, checked.work));
    outcome = { kind: 'decision.applied', details: { outcome: await applyThroughEngine(services, checked.decision, approver, checked.decision.approvalReason ?? '') } };
  } catch (error) {
    if (!(error instanceof Refusal) && !(error instanceof z.ZodError)) throw error;
    outcome = { kind: 'decision.failed', details: { error: error.message } };
  }
  return settle(checked.work, outcome.kind, outcome.details);
}

const applySchema = z.object({ decision: z.string().uuid(), reason: decisionRequestSchema.shape.reason }).strict();

/**
 * `{ action: 'apply', decision, reason }` on the decide route (GY-1298): the loop's way to apply an
 * approval whose approver session ended before applying it. The caller needs the authority the
 * decision's action requires; the approval itself is the recorded approver's, so no separation of
 * duties is judged again. A decision not standing approved is returned as it is.
 */
export async function applyApprovedDecision(services: Services, caller: Principal, id: string, body: unknown, key: string) {
  const { action: _action, ...rest } = (body ?? {}) as Record<string, unknown>;
  const data = applySchema.parse(rest);
  const fingerprint = digest({ id, apply: data.decision, reason: data.reason });
  const replay = await services.engine.store.transaction(async (db, now) => {
    const actor = await authenticated(services, db, now, caller);
    const replayed = await receipt(db, actor, key, fingerprint); if (replayed) return replayed;
    const work = await findWork(db, id); demand(work, 'Work item not found', 404);
    const decision = (await readDecisions(db, work!)).find(entry => entry.id === data.decision);
    demand(decision, `Decision ${data.decision} does not exist on ${work!.key}`, 404);
    for (const capability of requiredDecisionCapabilities(decision!.action, decision!.input, work!)) assertDecisionAuthority(actor, capability, work!, services.repository);
    return null;
  });
  if (replay) return replay;
  // A rework its risk lane approved is resumed the way any request resumes it (GY-1110).
  await reconcileApproved(services, id, undefined, data.decision);
  await resumeLaneReworks(services, id);
  return services.engine.store.transaction(async (db, now) => {
    const actor = await authenticated(services, db, now, caller);
    const work = await findWork(db, id); demand(work, 'Work item not found', 404);
    const result = (await readDecisions(db, work!)).find(entry => entry.id === data.decision)!;
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [actor.id, key, fingerprint, JSON.stringify(result)]);
    return result;
  });
}
