import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { Refusal, demand, resolveEscalation, standingEscalations, type Principal, type Work } from '../model.js';
import { save, wakeJob } from '../store.js';
import { approvalConflict, approveCapability, assertDecisionAuthority, decisionApprovalSchema, decisionInputs, decisionPrecondition, decisionRequestSchema, decisionSituation, foldDecisions, requiredDecisionCapabilities, standingRefusal, type Decision, type DecisionSituation, type DecisionState } from '../model/approval.js';
import { canonical, decisionRace, readDecisions, resolvePin, samePin, type DecisionRecord, type StaleRace } from './decision-ledger.js';
import type { Services } from './routes.js';
import { onlyActionsMovedSince, sameBesideBookkeeping } from '../engine.js';
import { refuseDecision, withdrawDecision } from './decision-refusal.js';
import { precedentAvailability } from './escalation-context.js';
import { applyTriageClosure } from './followups.js';
import { closeWork } from './close.js';
import { answerWith, applyLaneRework, laneApprover, resumeLaneReworks } from './lane-rework.js';
import { lockedWork, workIdByRef } from '../store/locked-read.js';

type Db = pg.PoolClient;
// The ledger's read half lives in decision-ledger.ts (GY-102); decision-refusal.ts reads it from here too.
export { readDecisions, type DecisionRecord } from './decision-ledger.js';
// The risk lane's own application of a rework lives in lane-rework.ts (GY-1110).
export { laneApprover, resumeLaneReworks } from './lane-rework.js';
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const findWork = async (db: Db, id: string): Promise<Work | undefined> =>
  (await db.query(`SELECT document FROM work_items WHERE id = ${workIdByRef('$1')} FOR UPDATE`, [id])).rows[0]?.document;
export const record = (db: Db, work: Work, actor: string, kind: string, payload: unknown) =>
  db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, actor, kind, JSON.stringify(payload)]);
export async function authenticated(services: Services, db: Db, now: Date, actor: Principal) {
  if (actor.role !== 'operator-agent') return actor;
  demand(services.engine.operatorAuthorizer, 'Operator-agent authorization is unavailable', 503);
  return services.engine.operatorAuthorizer!(db, now, actor);
}
export async function receipt(db: Db, actor: Principal, key: string, fingerprint: string) {
  demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
  const row = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
  if (row) demand(row.fingerprint === fingerprint, 'Idempotency key reused with different input');
  return row?.result as DecisionRecord | undefined;
}

/**
 * The requester's authority is re-read when the decision is applied: a revoked operator agent,
 * or one that lost the capability or the item's scope, no longer carries its request.
 */
async function requesterAuthority(services: Services, db: Db, decision: Pick<Decision, 'requestedBy' | 'action' | 'input'>, work: Work) {
  let requester = services.principals.find(entry => entry.actor.id === decision.requestedBy)?.actor;
  if (!requester) {
    const agent = (await db.query('SELECT document FROM operator_agents WHERE id=$1', [decision.requestedBy])).rows[0]?.document;
    demand(agent && !agent.revokedAt, `Requester ${decision.requestedBy} is no longer a live agent identity; request the decision again`, 409);
    requester = { id: agent.id, role: 'operator-agent', capabilities: agent.capabilities, scope: agent.scope };
  }
  for (const capability of requiredDecisionCapabilities(decision.action, decision.input, work)) assertDecisionAuthority(requester!, capability, work, services.repository);
}

/**
 * Record a decision request. Nothing about the item changes until an independent approval.
 * The same route also carries withdrawal: `{ action: 'withdraw', decision, reason }` takes the
 * caller's own request back instead of creating one.
 */
export async function requestDecision(services: Services, caller: Principal, id: string, body: unknown, key: string) {
  if ((body as any)?.action === 'withdraw') return withdrawDecision(services, caller, id, body, key);
  if ((body as any)?.action === 'apply') return applyApprovedDecision(services, caller, id, body, key);
  const data = decisionRequestSchema.parse(body);
  const input = decisionInputs[data.action].parse(data.input);
  const fingerprint = digest({ id, action: data.action, input, reason: data.reason, ...(data.precedent ? { precedent: data.precedent } : {}), ...(data.context ? { context: data.context } : {}) });
  // A lane-approved rework whose application was interrupted is resumed by the next request for
  // the item, whatever its key (GY-1110). One that applied answers a new rework request in its
  // place; one that failed no longer stands, so the new request is recorded and supersedes it.
  // Only a caller with authority for the request it makes triggers the resumption (GY-1244).
  await callerMayRequest(services, caller, id, data.action, input, key, fingerprint);
  const resumed = await resumeLaneReworks(services, id);
  // An approver's approval of this same action that recorded no outcome no longer refuses the
  // request with "wait for it" (GY-1298): it is applied, or superseded when the candidate it judged
  // has moved, and a rework it applied answers the request as a lane rework does.
  const reconciled = await reconcileApproved(services, id, data.action);
  const answered = data.action === 'rework' ? [...resumed, ...reconciled].find(decision => decision.state === 'applied') : undefined;
  if (answered) return answerWith(services, caller, key, fingerprint, answered);
  // A rework on a low- or medium-lane item needs no approver decision (GY-883 AC-2): once recorded,
  // it is applied at once with the lane as its ground. A replayed request whose application was
  // interrupted resumes it; a high-lane rework waits for its independent approver as ever.
  const requested = await recordRequest(services, caller, id, data, input, key, fingerprint);
  return requested.action === 'rework' && (requested.state === 'requested' || (requested.state === 'approved' && requested.approvedBy === laneApprover))
    ? applyLaneRework(services, requested) : requested;
}

/**
 * Authenticate the caller and check its authority for the action before the request resumes any
 * stranded rework (GY-1244). A replay of a recorded request is judged by its receipt, as ever.
 * recordRequest repeats both checks in its own transaction, which is the one that decides.
 */
async function callerMayRequest(services: Services, caller: Principal, id: string, action: Decision['action'], input: any, key: string, fingerprint: string) {
  await services.engine.store.transaction(async (db, now) => {
    const actor = await authenticated(services, db, now, caller);
    if (await receipt(db, actor, key, fingerprint)) return;
    const work = await findWork(db, id); demand(work, 'Work item not found', 404);
    for (const capability of requiredDecisionCapabilities(action, input, work!)) assertDecisionAuthority(actor, capability, work!, services.repository);
  });
}

async function recordRequest(services: Services, caller: Principal, id: string, data: z.infer<typeof decisionRequestSchema>, input: any, key: string, fingerprint: string): Promise<DecisionRecord> {
  return services.engine.store.transaction(async (db, now) => {
    const actor = await authenticated(services, db, now, caller);
    const replay = await receipt(db, actor, key, fingerprint); if (replay) return replay;
    const work = await findWork(db, id); demand(work, 'Work item not found', 404);
    for (const capability of requiredDecisionCapabilities(data.action, input, work!)) assertDecisionAuthority(actor, capability, work!, services.repository);
    const precondition = decisionPrecondition(data.action, input, work!); demand(!precondition, precondition!, 409);
    const history = await readDecisions(db, work!);
    // A refused decision is answered, never retried unchanged (GY-141). A rework or recover
    // refusal judged the candidate and base it was requested against, and stands only for those (GY-229).
    const situation = decisionSituation(data.action, work!);
    // The refused decision travels as a field beside the message (GY-265), so the loop answers it by id.
    const repeated = standingRefusal(history, data.action, input, data.reason, (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)), data.precedent ?? [], situation);
    if (repeated) throw new Refusal(repeated.message, 409, { standingRefusal: { decision: repeated.decision, action: repeated.action, legacy: repeated.legacy } });
    const pending = history.find(decision => decision.action === data.action && (decision.state === 'requested' || decision.state === 'approved'));
    const cited = data.precedent ? [...new Set(data.precedent)].sort() : null;
    // The ledger's "precedent it relied on" is only worth following if it names real decisions:
    // every cited id must be a recorded decision of this same action, on any item of the graph.
    if (cited?.length) {
      const known = new Set((await db.query("SELECT payload->>'id' AS id FROM events WHERE kind='decision.requested' AND payload->>'action'=$1 AND payload->>'id'=ANY($2::text[])", [data.action, cited])).rows.map(row => row.id as string));
      const unknown = cited.filter(entry => !known.has(entry));
      demand(!unknown.length, `Cited precedent ${unknown.join(', ')} is not a recorded ${data.action} decision; cite decisions from the assembled context`, 422);
    }
    // A request that cites nothing is accepted, never refused for it (GY-138): a handler whose
    // context carried no applied decision of its trigger has nothing to cite. The ledger records
    // whether any precedent was available, so an approver sees a first-of-its-kind decision as one.
    const noPrecedent = cited?.length ? null : await precedentAvailability(db, data.action, input);
    // A spawned handler that reaches the same line as a standing request — same action, same
    // input, same precedent — is following it, not competing with it: its judgement is appended
    // to that decision as a concurrence and the standing decision is returned.
    if (pending && cited && JSON.stringify(canonical(pending.input)) === JSON.stringify(canonical(input)) && JSON.stringify([...pending.precedent].sort()) === JSON.stringify(cited)) {
      await record(db, work!, actor.id, 'decision.concurred', { id: pending.id, action: data.action, reason: data.reason, precedent: cited, context: data.context ?? null, requester: { id: actor.id, role: actor.role } });
      const result = (await readDecisions(db, work!)).find(decision => decision.id === pending.id)!;
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
      return result;
    }
    demand(!pending, `Decision ${pending?.id} (${data.action}) is already ${pending?.state} on ${work!.key}; wait for it before requesting another`, 409);
    const decisionId = randomUUID();
    await record(db, work!, actor.id, 'decision.requested', { id: decisionId, action: data.action, input, reason: data.reason, requester: { id: actor.id, role: actor.role }, capabilities: requiredDecisionCapabilities(data.action, input, work!),
      ...(cited ? { precedent: cited } : {}), ...(noPrecedent ? { noPrecedent } : {}), ...(data.context ? { context: data.context } : {}), ...(data.action === 'resolve' ? { pin: resolvePin(work!) } : {}), ...(situation ? { situation } : {}) });
    const result = (await readDecisions(db, work!)).find(decision => decision.id === decisionId)!;
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
    return result;
  });
}

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

// A refused approval is part of the item's history even though its transaction rolled back.
async function recordRefusal(services: Services, actor: Principal, workId: string, decision: string, conflict: string) {
  await services.engine.store.transaction(db => db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)',
    [workId, actor.id, 'decision.refused', JSON.stringify({ id: decision, conflict, approver: { id: actor.id, role: actor.role } })]));
}

/** A decision a race made permanently unappliable is settled as 'stale' in its own transaction. */
async function recordStale(services: Services, stale: { actor: Principal; workId: string; decision: Pick<Decision, 'id' | 'action'>; reason: string } & StaleRace) {
  await services.engine.store.transaction(db => db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)',
    [stale.workId, stale.actor.id, 'decision.stale', JSON.stringify({ id: stale.decision.id, action: stale.decision.action, reason: stale.reason, expected: stale.expected, current: stale.current, observedBy: { id: stale.actor.id, role: stale.actor.role } })]));
}

/**
 * Approve and apply a decision. The approval is recorded under the coordination lock after
 * every separation-of-duties check. Escalation resolution and merge approval are applied in
 * that same transaction; every other action is applied through the engine as its requester,
 * bound to the exact recorded input with an idempotency key derived from the decision, and its
 * outcome is appended to the ledger. A crash between the two replays the same engine call.
 */
export async function approveDecision(services: Services, caller: Principal, id: string, body: unknown, key: string) {
  if ((body as any)?.action === 'refuse') return refuseDecision(services, caller, id, body, key);
  const data = decisionApprovalSchema.parse(body);
  const fingerprint = digest({ id, ...data });
  const refusal: { value?: { actor: Principal; workId: string; conflict: string } } = {};
  const stale: { value?: { actor: Principal; workId: string; decision: Pick<Decision, 'id' | 'action'>; reason: string } & StaleRace } = {};
  let approved: { decision: DecisionRecord; work: Work; approver: Principal } | undefined;
  try {
    const settled = await services.engine.store.transaction(async (db, now) => {
      const actor = await authenticated(services, db, now, caller);
      const replay = await receipt(db, actor, key, fingerprint); if (replay) return replay;
      const work = await findWork(db, id); demand(work, 'Work item not found', 404);
      const decision = (await readDecisions(db, work!)).find(entry => entry.id === data.decision);
      demand(decision, `Decision ${data.decision} does not exist on ${work!.key}`, 404);
      // Separation of duties is judged before authority, so a conflicted identity is told the
      // conflict, whatever else it lacks.
      const conflict = approvalConflict(decision!, actor, work!);
      if (conflict) { refusal.value = { actor, workId: work!.id, conflict }; demand(false, conflict, 403); }
      assertDecisionAuthority(actor, approveCapability, work!, services.repository);
      // An approval interrupted before its outcome was recorded resumes under the same approver.
      const resuming = decision!.state === 'approved' && decision!.approvedBy === actor.id;
      demand(decision!.state === 'requested' || resuming, `Decision ${decision!.id} is already ${decision!.state}${decision!.approvedBy ? ` (approved by ${decision!.approvedBy})` : ''}`, 409);
      await requesterAuthority(services, db, decision!, work!);
      let precondition = resuming ? null : decisionPrecondition(decision!.action, decision!.input, work!);
      // A resolve decision is pinned to what its resolver's judgement rests on — the policy
      // revision, the candidate head and base, the lease epoch, and the exact standing
      // escalation set with the moment each was raised — not to the item's whole revision: a
      // heartbeat, a workspace registration or a dispatch between the request and the approval
      // moves the revision without invalidating the request. While the pinned state still
      // holds, only the revision precondition is relaxed; anything else the item moved is
      // judged as it stands. A moved pin is a refusal decisionRace settles stale below — a
      // suppressed repeat of the trigger never grew the set and a replacement claim never
      // touched it, so the pin, not the trigger slot, is what keeps an approval from clearing
      // an incident the requester never saw — and a fresh resolve of the same action is
      // accepted at once.
      if (decision!.action === 'resolve' && !resuming && samePin(resolvePin(work!), decision!.pin)
        && precondition?.startsWith('Task revision changed')) precondition = null;
      // GY-1296: a release, an unblock or a diagnostician's closure is pinned to the item's whole
      // revision, and the loop that requested it moves that revision itself — the approver session
      // it launches is recorded on the very item, and each report of that session is saved there too. A revision that moved
      // only in that bookkeeping (sessions, gates, next action, action queue: sameBesideBookkeeping)
      // leaves what the requester judged in place, so the decision is judged at the current
      // revision, and applied at it; any other change to the item still settles it stale below.
      let judged = decision!;
      const revisionPinned = decision!.action === 'release' || decision!.action === 'unblock' || (decision!.action === 'close' && decision!.input.triageAt === undefined && decision!.input.expectedRevision !== undefined);
      if (revisionPinned && decision!.input.expectedRevision !== work!.revision
        && await onlyActionsMovedSince(db, work!, decision!.input.expectedRevision, sameBesideBookkeeping)) {
        judged = { ...decision!, input: { ...decision!.input, expectedRevision: work!.revision } };
        if (!resuming) precondition = decisionPrecondition(judged.action, judged.input, work!);
      }
      if (precondition) {
        // A pin the item has moved past can never hold again, so the decision would stay
        // 'requested' forever and block every re-request; settle it as stale instead.
        const race = decisionRace(decision!, work!);
        if (race) stale.value = { actor, workId: work!.id, decision: decision!, reason: `${precondition}; the decision was not applied`, ...race };
        demand(false, `${precondition}; the decision was not applied`, 409);
      }
      if (!resuming) await record(db, work!, actor.id, 'decision.approved', { id: decision!.id, action: decision!.action, reason: data.reason, requestedBy: decision!.requestedBy, approver: { id: actor.id, role: actor.role } });
      if (decision!.action === 'resolve' || decision!.action === 'merge') {
        const outcome = decision!.action === 'merge'
          ? `Merge of ${decision!.input.sha} onto ${decision!.input.baseSha} at policy revision ${decision!.input.policyRevision} approved; the guarded merge still rechecks every gate`
          : await resolveInTransaction(services, db, now, work!, decision!, actor, data.reason);
        return finish(db, work!, actor, decision!.id, 'decision.applied', { outcome }, key, fingerprint);
      }
      approved = { decision: judged, work: work!, approver: actor };
      return null;
    });
    if (settled) return settled;
  } catch (error) {
    if (refusal.value) await recordRefusal(services, refusal.value.actor, refusal.value.workId, data.decision, refusal.value.conflict);
    if (stale.value) await recordStale(services, stale.value);
    throw error;
  }
  const { decision, work, approver } = approved!;
  let outcome: { kind: string; details: object };
  try { outcome = { kind: 'decision.applied', details: { outcome: await applyThroughEngine(services, decision, approver, data.reason) } }; }
  catch (error) {
    // A server fault is retried by repeating the approval; only a refusal settles the decision.
    if (!(error instanceof Refusal) && !(error instanceof z.ZodError)) throw error;
    outcome = { kind: 'decision.failed', details: { error: error.message } };
  }
  return services.engine.store.transaction(async db => finish(db, work, approver, decision.id, outcome.kind, outcome.details, key, fingerprint));
}

async function finish(db: Db, work: Work, approver: Principal, decisionId: string, kind: string, details: object, key: string, fingerprint: string) {
  await record(db, work, approver.id, kind, { id: decisionId, ...details });
  const result = (await readDecisions(db, work)).find(entry => entry.id === decisionId)!;
  await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [approver.id, key, fingerprint, JSON.stringify(result)]);
  return result;
}

/**
 * The engine reserves escalation resolution for a declared human session. A two-party agent
 * decision is the replacement for that session, so resolution is applied here, under the same
 * lock and with the same effects: one trigger cleared, gates re-evaluated, history appended.
 */
async function resolveInTransaction(services: Services, db: Db, now: Date, work: Work, decision: DecisionRecord, approver: Principal, approvalReason: string) {
  const target = standingEscalations(work).find(entry => entry.trigger === decision.input.trigger)!;
  resolveEscalation(work, decision.input.trigger);
  const all = (await lockedWork(db, [work.id])).map(item => item.id === work.id ? work : item);
  services.engine.evaluate(work, all, now);
  // The engine's auto-dispatch ledger entries for this evaluation; the method is internal to the
  // engine's own transactions, and this is one of them.
  await (services.engine as unknown as { recordDispatch(db: Db, work: Work, now: Date): Promise<void> }).recordDispatch(db, work, now);
  const details = { trigger: decision.input.trigger, escalation: target, resolvedBy: decision.requestedBy, approvedBy: approver.id, decision: decision.id, sessionKind: 'ai', reason: decision.reason, approvalReason, at: now.toISOString() };
  await save(db, work, decision.requestedBy, 'resolve', now, details);
  await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, decision.requestedBy, 'escalation.resolved', JSON.stringify({ details })]);
  if (work.submission) await wakeJob(db, work.id);
  return `Resolved ${decision.input.trigger} on ${work.key}`;
}

export async function applyThroughEngine(services: Services, decision: DecisionRecord, approver: Principal, approvalReason: string) {
  // The requester acts, with the authority the two-party decision grants for this one input.
  const actor: Principal = { id: decision.requestedBy, role: 'admin', sessionKind: 'ai', displayName: `${decision.requestedBy} (decision ${decision.id} approved by ${approver.id})` };
  const reason = `${decision.reason} [decision ${decision.id}, requested by ${decision.requestedBy}, approved by ${approver.id}: ${approvalReason}]`.slice(0, 2000);
  const key = `decision:${decision.id}`, input = decision.input, engine = services.engine;
  switch (decision.action) {
    case 'release': await engine.execute(actor, 'ready', decision.workId, { expectedRevision: input.expectedRevision, reason }, key); return 'Released to ready';
    case 'unblock': await engine.execute(actor, 'unblock', decision.workId, { reason, expectedRevision: input.expectedRevision }, key); return 'Blocker cleared';
    case 'requirements': { const work = await engine.execute(actor, 'requirements', decision.workId, { ...input, reason }, key); return `Requirements revised to policy revision ${work.policyRevision}`; }
    case 'rework': await engine.execute(actor, 'rework', decision.workId, { reason, previousWorkerStopped: true }, key); return 'Rework authorized';
    case 'recover': await engine.execute(actor, 'recover', decision.workId, { reason, previousWorkerStopped: true }, key); return 'Containment quarantine recovered';
    case 'attest': await engine.execute(actor, 'evidence', decision.workId, input, key, { attestation: { decision: decision.id, requestedBy: decision.requestedBy, approvedBy: approver.id } }); return `${input.proof} attested ${input.result} for ${input.sha}`;
    case 'close': {
      // A triage closure (its input carries the judgement's `triageAt`) applies through the triage
      // path; a diagnostician's closure (GY-439) closes the item directly, with the approval's own
      // composed reason.
      if (input.triageAt !== undefined) return applyTriageClosure(services, actor, decision.workId, input, decision.id, key);
      const work = await closeWork(services, actor, decision.workId, { kind: input.kind, reason, ref: input.ref ?? null }, key);
      return `Closed ${work.key} as ${input.kind}${input.ref ? ` of ${input.ref}` : ''}`;
    }
    case 'grant': { const grant = await services.proofGrants.grant(actor, input.principal, { patterns: input.patterns, reason, ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }) }, key); return `Granted ${input.patterns.join(', ')} to ${input.principal} (grant revision ${grant.revision})`; }
    default: throw new Error(`No engine application for ${decision.action}`);
  }
}
