// Concern: the application of an approved decision the engine refuses only for a live attempt (GY-1687): a
// non-widening requirements revision is held, bound to the lease or containment fence that refused it, and
// the engine applies it in the transaction that ends that attempt (Engine.applyHeldDecisions).
import type pg from 'pg';
import { z } from 'zod';
import { Refusal, type Principal, type Work } from '../model.js';
import { heldByLiveAttempt, type HeldApplication, type HeldAttempt } from '../model/approval.js';
import type { DecisionRecord } from './decision-ledger.js';
import type { Services } from './routes.js';
import { findWork } from './decisions.js';

type Db = pg.PoolClient;
type Outcome = { kind: string; details: object };

/**
 * Apply an approved decision through the engine and settle it. A requirements decision the engine refuses
 * only because the item holds a live lease or an unverified containment fence is held, not failed: the
 * engine applies it in the transaction that ends the attempt. The hold is recorded under the item's lock,
 * the lock every attempt-ending command takes before it reads the held decisions, and only while the same
 * attempt that refused still holds the item: an item freed — or claimed into a new epoch — between the
 * refusal and that locked read would never end the refusing attempt again, so its hold is not recorded and
 * the application is repeated at once instead (Codex reviews of 140ab6d61910 and fe3b4e08db8e).
 */
export async function applyApprovedDecision<T>(services: Services, work: Work, decision: DecisionRecord, approver: Principal, approvalReason: string,
  apply: () => Promise<string>, settle: (db: Db, kind: string, details: object) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    // The attempt that is about to refuse: bound into the held outcome so a replacement claim cannot
    // make the hold true for a different epoch and strand the approval on the new worker.
    const refusedBy = await services.engine.store.transaction(async (db, now) => {
      const item = await findWork(db, work.id);
      return item ? holdingAttempt(item, now) : null;
    });
    let outcome: Outcome;
    try { outcome = { kind: 'decision.applied', details: { outcome: await apply() } }; }
    catch (error) {
      // A server fault is retried by repeating the approval; only a refusal settles the decision.
      if (!(error instanceof Refusal) && !(error instanceof z.ZodError)) throw error;
      outcome = heldOutcome(decision, approver, approvalReason, error, refusedBy) ?? { kind: 'decision.failed', details: { error: error.message } };
    }
    // The item is locked first, so a resumption racing this approval serializes with it (GY-1300).
    const settled = await services.engine.store.transaction(async (db, now) => {
      const item = await findWork(db, work.id);
      if (outcome.kind === 'decision.held' && item && !sameHoldingAttempt(holdingAttempt(item, now), (outcome.details as { attempt?: HeldAttempt | null }).attempt ?? null)) {
        // A bounded repeat: an item freed and claimed again under every application is not held for ever either.
        if (attempt < 3) return null;
        outcome = { kind: 'decision.failed', details: { error: `${(outcome.details as { reason: string }).reason.split(';')[0]}; the item was freed and claimed again under each of ${attempt + 1} applications, so the decision was not applied` } };
      }
      return { value: await settle(db, outcome.kind, outcome.details) };
    });
    if (!settled) continue;
    if (outcome.kind === 'decision.held') await groundHeldScope(services, work, decision, (outcome.details as { attempt?: HeldAttempt | null }).attempt ?? null);
    return settled.value;
  }
}

/**
 * GY-1726: once a requirements decision is held, the criteria it carries ground the holding attempt's
 * scope ask — GY-1700's worker asked for the test file a pending AC-0 named, the loop refused it before
 * the decision was approved, and the refusal held the item until an operator cleared it by hand, though
 * the approved criterion implied the file. The control plane decides that ask again at once on the held
 * criteria (the engine's `autoscope` reads them); an ask they do not ground stays as it was.
 */
async function groundHeldScope(services: Services, work: Work, decision: Pick<DecisionRecord, 'id'>, attempt: HeldAttempt | null) {
  if (attempt?.kind !== 'lease') return;
  try { await services.engine.execute({ id: 'graphyard', role: 'coordinator', sessionKind: 'ai' }, 'autoscope', work.id, { epoch: attempt.epoch }, `held-scope:${decision.id}`); }
  catch (error) { if (!(error instanceof Refusal)) throw error; }
}

/** Whether the item holds a live attempt a non-widening requirements revision must wait for: a live lease or an unverified containment fence. */
export const attemptHolds = (work: Pick<Work, 'lease' | 'containmentQuarantine'>, now: Date) => !!holdingAttempt(work, now);
/** The live lease epoch or unverified containment fence that holds the item, or null when none does. */
export function holdingAttempt(work: Pick<Work, 'lease' | 'containmentQuarantine'>, now: Date): HeldAttempt | null {
  if (work.containmentQuarantine) return { kind: 'quarantine', epoch: work.containmentQuarantine.epoch };
  if (work.lease && Date.parse(work.lease.expiresAt) > now.getTime()) return { kind: 'lease', epoch: work.lease.epoch };
  return null;
}
/** Whether the live attempt is still the one that refused the approved revision. */
export const sameHoldingAttempt = (current: HeldAttempt | null, refused: HeldAttempt | null) => !!current && !!refused && current.kind === refused.kind && current.epoch === refused.epoch;
/** The `decision.held` outcome of a requirements decision the engine refused only for a live attempt, or null for any other refusal. */
export function heldOutcome(decision: Pick<DecisionRecord, 'id' | 'action' | 'requestedBy' | 'reason'>, approver: Principal, approvalReason: string, error: unknown, attempt: HeldAttempt | null = null): { kind: 'decision.held'; details: { reason: string; application: HeldApplication; attempt: HeldAttempt | null } } | null {
  if (decision.action !== 'requirements' || !(error instanceof Refusal) || !heldByLiveAttempt(error.message)) return null;
  const { actor, reason } = applicationOf(decision, approver, approvalReason);
  return { kind: 'decision.held', details: { reason: `${error.message}; the approved decision is held and applied when the attempt ends`, application: { actor, reason }, attempt } };
}

/** The engine call an approved decision is applied with: the requester acting under the two-party decision, with the composed reason (replayed for a held decision). */
export function applicationOf(decision: Pick<DecisionRecord, 'id' | 'requestedBy' | 'reason'>, approver: Pick<Principal, 'id'>, approvalReason: string): HeldApplication {
  const actor: Principal = { id: decision.requestedBy, role: 'admin', sessionKind: 'ai', displayName: `${decision.requestedBy} (decision ${decision.id} approved by ${approver.id})` };
  const reason = `${decision.reason} [decision ${decision.id}, requested by ${decision.requestedBy}, approved by ${approver.id}: ${approvalReason}]`.slice(0, 2000);
  return { actor, reason };
}
