import type pg from 'pg';
import { demand, operatorScopeIncludes, standingEscalations, type Principal, type Work } from '../model.js';
import { foldDecisions, type Decision, type DecisionState } from '../model/approval.js';
import type { Services } from './routes.js';

/**
 * The read half of two-party decisions: what the append-only ledger says a decision is.
 *
 * Nothing here writes. The fold rebuilds every decision on an item from its `decision.*` entries,
 * on top of the model's own fold, and adds the two terminal states only the server records and
 * the pin a resolve decision was requested against. server/decisions.ts holds the write half —
 * request, withdraw, approve and apply — and judges races against these records.
 */

type Db = pg.PoolClient;
/**
 * Terminal states only the server records: a decision overtaken by a revision race ('stale')
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
export interface ResolvePin { policyRevision: number; sha: string | null; baseSha: string | null; epoch: number; escalations: { trigger: string; at: string }[] }
export const resolvePin = (work: Work): ResolvePin => ({ policyRevision: work.policyRevision, sha: work.candidate?.sha ?? null, baseSha: work.candidate?.baseSha ?? null, epoch: work.epoch, escalations: standingEscalations(work).map(entry => ({ trigger: entry.trigger, at: entry.at })) });
// jsonb does not keep object key order, so the recorded pin compares in a canonical form.
export const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1).map(([key, entry]) => [key, canonical(entry)]))
  : value;
export const samePin = (current: ResolvePin, pinned: ResolvePin | null | undefined) => !!pinned && JSON.stringify(canonical(current)) === JSON.stringify(canonical(pinned));
export type DecisionRecord = Omit<Decision, 'state'> & { state: DecisionState | TerminalState; race: { expected: unknown; current: unknown } | null; pin: ResolvePin | null };

/** The fold itself, over one item's decision entries in ledger order. */
function foldLedger(workId: string, rows: { actor: string; kind: string; payload: any; created_at: Date | string }[]): DecisionRecord[] {
  const events = rows.map(row => ({ kind: row.kind as string, actor: row.actor as string, at: new Date(row.created_at).toISOString(), payload: row.payload }));
  const decisions: DecisionRecord[] = foldDecisions(workId, events).map(decision => ({ ...decision, race: null, pin: null }));
  for (const event of events) {
    const decision = decisions.find(entry => entry.id === event.payload?.id);
    if (!decision) continue;
    if (event.kind === 'decision.requested') Object.assign(decision, { pin: event.payload.pin ?? null });
    if (event.kind === 'decision.stale') Object.assign(decision, { state: 'stale', outcome: event.payload.reason ?? null, race: { expected: event.payload.expected ?? null, current: event.payload.current ?? null } });
    if (event.kind === 'decision.withdrawn') Object.assign(decision, { state: 'withdrawn', outcome: event.payload.reason ?? null });
  }
  return decisions;
}

/** Every decision on one item, folded from its ledger entries. */
export async function readDecisions(db: { query: Db['query'] }, work: Work): Promise<DecisionRecord[]> {
  const rows = (await db.query("SELECT actor, kind, payload, created_at FROM events WHERE work_id=$1 AND kind LIKE 'decision.%' ORDER BY seq", [work.id])).rows;
  return foldLedger(work.id, rows);
}

/**
 * Every decision on the named items, folded from the same entries `readDecisions` reads, keyed
 * by work id — one query for the whole set. The human surface (server/waits.ts) asks for the
 * items its rule table says it must read, which is a handful of the open graph at a time.
 */
export async function decisionsByWork(db: { query: Db['query'] }, ids: readonly string[]): Promise<Record<string, DecisionRecord[]>> {
  const byWork: Record<string, DecisionRecord[]> = {};
  if (!ids.length) return byWork;
  const rows = (await db.query("SELECT work_id, actor, kind, payload, created_at FROM events WHERE work_id=ANY($1::uuid[]) AND kind LIKE 'decision.%' ORDER BY seq", [[...ids]])).rows;
  for (const id of ids) byWork[id] = foldLedger(id, rows.filter(row => row.work_id === id));
  return byWork;
}

export async function listDecisions(services: Services, actor: Principal, id: string) {
  demand(['admin', 'coordinator', 'operator-agent', 'reader'].includes(actor.role), 'Decision history is not available to this role', 403);
  const work = (await services.engine.store.list()).find(item => item.id === id || item.key === id);
  demand(work, 'Work item not found', 404);
  demand(actor.role !== 'operator-agent' || operatorScopeIncludes(actor, work!), 'Work item is outside this operator-agent scope', 403);
  return { key: work!.key, decisions: await readDecisions(services.engine.store.pool, work!) };
}

/** The pinned target a revision race moved away, with both sides; null when no pin was hit. */
export interface StaleRace { expected: unknown; current: unknown }
/**
 * Whether approval failed on a pin that can never match again: the item revision, the policy
 * revision or the candidate moved past the one the decision was requested against, and
 * revisions never move back; or the resolve's pin moved — the incident cleared, a second
 * narrowing or a replacement claim behind it, or a new candidate head — where every mover
 * moves a field revisions never move back either.
 */
export function decisionRace(decision: DecisionRecord, work: Work): StaleRace | null {
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
