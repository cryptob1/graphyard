// Concern: the routed `requirements` decisions the decision ledger holds on a scope ask (GY-1388).
//
// The engine's guard refuses a hand widening while the approver holds the ask, and the board names
// `master decisions` over the same span (`approverScopeHold`). Both read the decisions from this one
// query, so the command the board names is never one the guard refuses.
import type { Work } from '../model/work.js';
import type { RoutedScopeDecision } from '../model/scope-provenance.js';

type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> };
const ends = `'decision.applied','decision.failed','decision.declined','decision.superseded','decision.stale','decision.withdrawn'`;

/**
 * The routed decisions on each item's scope ask the rule refused, by work id: a `decision.requested` for
 * `requirements` whose input answers that ask's epoch and at (daemon/decisions.ts
 * scopeRoutineDecision), and whether a later row of the same id ended it.
 */
export async function routedScopeDecisions(db: Queryable, work: readonly Pick<Work, 'id' | 'scopeRequest'>[]): Promise<Map<string, RoutedScopeDecision[]>> {
  const asks = work.filter(item => item.scopeRequest?.decision?.state === 'refused' && item.scopeRequest.decision.decidedBy === 'graphyard');
  const held = new Map<string, RoutedScopeDecision[]>(asks.map(item => [item.id, []]));
  if (!asks.length) return held;
  const { rows } = await db.query(`SELECT r.work_id, r.payload->>'id' AS id, r.payload->'input'->'answers'->>'at' AS at, (r.payload->'input'->'answers'->>'epoch')::int AS epoch,
      EXISTS (SELECT 1 FROM events s WHERE s.work_id=r.work_id AND s.seq>r.seq AND s.payload->>'id'=r.payload->>'id' AND s.kind IN (${ends})) AS ended
    FROM events r WHERE r.work_id = ANY($1::uuid[]) AND r.kind='decision.requested' AND r.payload->>'action'='requirements' AND r.payload->'input'->'answers' IS NOT NULL`, [asks.map(item => item.id)]);
  for (const row of rows) {
    const request = asks.find(item => item.id === row.work_id)?.scopeRequest;
    if (request && row.at === request.at && row.epoch === request.epoch) held.get(row.work_id)!.push({ id: row.id, ended: row.ended });
  }
  return held;
}
