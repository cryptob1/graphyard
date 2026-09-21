import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { Refusal, demand, resolveEscalation, standingEscalations, type Principal, type Work } from '../model.js';
import { save, wakeJob } from '../store.js';
import { approvalConflict, approveCapability, assertDecisionAuthority, decisionApprovalSchema, decisionInputs, decisionPrecondition, decisionRequestSchema, foldDecisions, requiredDecisionCapabilities, type Decision, type DecisionState } from '../model/approval.js';
import type { Services } from './routes.js';

type Db = pg.PoolClient;
/**
 * Terminal states only this module records: a decision overtaken by a revision race ('stale')
 * and one its requester took back ('withdrawn'). The model's fold predates them, so they are
 * folded on top of it from the same ledger.
 */
type TerminalState = 'stale' | 'withdrawn';
/**
 * What a resolve decision is pinned to: the state its resolver's judgement rests on. A
 * heartbeat, a workspace registration or a dispatch moves the item revision without touching
 * any of it; a second narrowing, a replacement claim, a new candidate head, or the incident's
 * own clearing or replacement moves exactly one field. `raiseEscalation` never records a
 * repeat of a standing trigger, so the raised set — not the trigger slot — is what tells the
 * incident the requester saw from whatever stands there later.
 */
interface ResolvePin { policyRevision: number; sha: string | null; baseSha: string | null; epoch: number; escalations: { trigger: string; at: string }[] }
const resolvePin = (work: Work): ResolvePin => ({ policyRevision: work.policyRevision, sha: work.candidate?.sha ?? null, baseSha: work.candidate?.baseSha ?? null, epoch: work.epoch, escalations: standingEscalations(work).map(entry => ({ trigger: entry.trigger, at: entry.at })) });
// jsonb does not keep object key order, so the recorded pin compares in a canonical form.
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1).map(([key, entry]) => [key, canonical(entry)]))
  : value;
const samePin = (current: ResolvePin, pinned: ResolvePin | null | undefined) => !!pinned && JSON.stringify(canonical(current)) === JSON.stringify(canonical(pinned));
export type DecisionRecord = Omit<Decision, 'state'> & { state: DecisionState | TerminalState; race: { expected: unknown; current: unknown } | null; pin: ResolvePin | null };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const findWork = async (db: Db, id: string): Promise<Work | undefined> =>
  (await db.query('SELECT document FROM work_items WHERE id::text=$1 OR document->>\'key\'=$1 FOR UPDATE', [id])).rows[0]?.document;
async function readDecisions(db: { query: Db['query'] }, work: Work): Promise<DecisionRecord[]> {
  const rows = (await db.query("SELECT actor, kind, payload, created_at FROM events WHERE work_id=$1 AND kind LIKE 'decision.%' ORDER BY seq", [work.id])).rows;
  const events = rows.map(row => ({ kind: row.kind as string, actor: row.actor as string, at: new Date(row.created_at).toISOString(), payload: row.payload }));
  const decisions: DecisionRecord[] = foldDecisions(work.id, events).map(decision => ({ ...decision, race: null, pin: null }));
  for (const event of events) {
    const decision = decisions.find(entry => entry.id === event.payload?.id);
    if (!decision) continue;
    if (event.kind === 'decision.requested') Object.assign(decision, { pin: event.payload.pin ?? null });
    if (event.kind === 'decision.stale') Object.assign(decision, { state: 'stale', outcome: event.payload.reason ?? null, race: { expected: event.payload.expected ?? null, current: event.payload.current ?? null } });
    if (event.kind === 'decision.withdrawn') Object.assign(decision, { state: 'withdrawn', outcome: event.payload.reason ?? null });
  }
  return decisions;
}
const record = (db: Db, work: Work, actor: string, kind: string, payload: unknown) =>
  db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, actor, kind, JSON.stringify(payload)]);
async function authenticated(services: Services, db: Db, now: Date, actor: Principal) {
  if (actor.role !== 'operator-agent') return actor;
  demand(services.engine.operatorAuthorizer, 'Operator-agent authorization is unavailable', 503);
  return services.engine.operatorAuthorizer!(db, now, actor);
}
async function receipt(db: Db, actor: Principal, key: string, fingerprint: string) {
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

export async function listDecisions(services: Services, actor: Principal, id: string) {
  demand(['admin', 'coordinator', 'operator-agent', 'reader'].includes(actor.role), 'Decision history is not available to this role', 403);
  const work = (await services.engine.store.list()).find(item => item.id === id || item.key === id);
  demand(work, 'Work item not found', 404);
  demand(actor.role !== 'operator-agent' || actor.scope?.workItems.some(entry => entry === '*' || entry === work!.id || entry === work!.key), 'Work item is outside this operator-agent scope', 403);
  return { key: work!.key, decisions: await readDecisions(services.engine.store.pool, work!) };
}

/**
 * Record a decision request. Nothing about the item changes until an independent approval.
 * The same route also carries withdrawal: `{ action: 'withdraw', decision, reason }` takes the
 * caller's own request back instead of creating one.
 */
export async function requestDecision(services: Services, caller: Principal, id: string, body: unknown, key: string) {
  if ((body as any)?.action === 'withdraw') return withdrawDecision(services, caller, id, body, key);
  const data = decisionRequestSchema.parse(body);
  const input = decisionInputs[data.action].parse(data.input);
  const fingerprint = digest({ id, action: data.action, input, reason: data.reason, ...(data.precedent ? { precedent: data.precedent } : {}), ...(data.context ? { context: data.context } : {}) });
  return services.engine.store.transaction(async (db, now) => {
    const actor = await authenticated(services, db, now, caller);
    const replay = await receipt(db, actor, key, fingerprint); if (replay) return replay;
    const work = await findWork(db, id); demand(work, 'Work item not found', 404);
    for (const capability of requiredDecisionCapabilities(data.action, input, work!)) assertDecisionAuthority(actor, capability, work!, services.repository);
    const precondition = decisionPrecondition(data.action, input, work!); demand(!precondition, precondition!, 409);
    const pending = (await readDecisions(db, work!)).find(decision => decision.action === data.action && (decision.state === 'requested' || decision.state === 'approved'));
    const cited = data.precedent ? [...new Set(data.precedent)].sort() : null;
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
      ...(cited ? { precedent: cited } : {}), ...(data.context ? { context: data.context } : {}), ...(data.action === 'resolve' ? { pin: resolvePin(work!) } : {}) });
    const result = (await readDecisions(db, work!)).find(decision => decision.id === decisionId)!;
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

// A refused approval is part of the item's history even though its transaction rolled back.
async function recordRefusal(services: Services, actor: Principal, workId: string, decision: string, conflict: string) {
  await services.engine.store.transaction(db => db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)',
    [workId, actor.id, 'decision.refused', JSON.stringify({ id: decision, conflict, approver: { id: actor.id, role: actor.role } })]));
}

/** The pinned target a revision race moved away, with both sides; null when no pin was hit. */
interface StaleRace { expected: unknown; current: unknown }
/**
 * Whether approval failed on a pin that can never match again: the item revision, the policy
 * revision or the candidate moved past the one the decision was requested against, and
 * revisions never move back; or the resolve's pin moved — the incident cleared, a second
 * narrowing or a replacement claim behind it, or a new candidate head — where every mover
 * moves a field revisions never move back either.
 */
function decisionRace(decision: DecisionRecord, work: Work): StaleRace | null {
  if (decision.action === 'requirements' && decision.input.expectedPolicyRevision !== work.policyRevision)
    return { expected: { policyRevision: decision.input.expectedPolicyRevision }, current: { policyRevision: work.policyRevision } };
  if ((decision.action === 'attest' || decision.action === 'merge') && (!work.candidate || work.candidate.sha !== decision.input.sha
    || work.candidate.baseSha !== decision.input.baseSha || work.policyRevision !== decision.input.policyRevision))
    return { expected: { sha: decision.input.sha, baseSha: decision.input.baseSha, policyRevision: decision.input.policyRevision },
      current: { sha: work.candidate?.sha ?? null, baseSha: work.candidate?.baseSha ?? null, policyRevision: work.policyRevision } };
  if ((decision.action === 'release' || decision.action === 'unblock') && decision.input.expectedRevision !== work.revision)
    return { expected: { revision: decision.input.expectedRevision }, current: { revision: work.revision } };
  if (decision.action === 'resolve') {
    // A decision requested before the pin existed falls back to the revision it named:
    // revisions never move back, so a refused request can never become applicable either.
    if (!decision.pin) return decision.input.expectedRevision !== work.revision
      ? { expected: { revision: decision.input.expectedRevision }, current: { revision: work.revision } } : null;
    const current = resolvePin(work);
    return samePin(current, decision.pin) ? null : { expected: decision.pin, current };
  }
  return null;
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
      approved = { decision: decision!, work: work!, approver: actor };
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
  const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(row => row.document.id === work.id ? work : row.document);
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

async function applyThroughEngine(services: Services, decision: DecisionRecord, approver: Principal, approvalReason: string) {
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
    case 'attest': await engine.execute(actor, 'evidence', decision.workId, input, key); return `${input.proof} attested ${input.result} for ${input.sha}`;
    case 'grant': { const grant = await services.proofGrants.grant(actor, input.principal, { patterns: input.patterns, reason, ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }) }, key); return `Granted ${input.patterns.join(', ')} to ${input.principal} (grant revision ${grant.revision})`; }
    default: throw new Error(`No engine application for ${decision.action}`);
  }
}
