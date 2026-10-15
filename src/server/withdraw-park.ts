// Concern: applying an approved `withdraw-park` decision (GY-1815) inside the approval's transaction.
import type pg from 'pg';
import type { Principal, Work } from '../model.js';
import { humanRequestBlocker, retainedHumanRequests } from '../model/human-request.js';
import { supersededRequest } from '../model/park-withdrawal.js';
import { save } from '../store.js';
import { lockedWork } from '../store/locked-read.js';
import type { DecisionRecord } from './decision-ledger.js';
import type { Services } from './routes.js';

type Db = pg.PoolClient;

/**
 * GY-1815: the approved `withdraw-park` closes the item's open human-only request as superseded by
 * observation — kept in its history with requester, approver and reason — and clears the park's
 * blocker in the approval's own transaction, so the item is claimable and the loop dispatches it.
 */
export async function withdrawParkInTransaction(services: Services, db: Db, now: Date, work: Work, decision: DecisionRecord, approver: Principal, approvalReason: string) {
  const closed = supersededRequest(work.humanRequest!, { id: decision.id, requestedBy: decision.requestedBy, approvedBy: approver.id, reason: decision.reason }, now);
  work.humanRequests = [...(work.humanRequests ?? []), closed].slice(-retainedHumanRequests);
  work.humanRequest = null;
  if (work.blocker?.startsWith(humanRequestBlocker)) work.blocker = null;
  const all = (await lockedWork(db, [work.id])).map(item => item.id === work.id ? work : item);
  services.engine.evaluate(work, all, now);
  await (services.engine as unknown as { recordDispatch(db: Db, work: Work, now: Date): Promise<void> }).recordDispatch(db, work, now);
  const details = { request: closed, requestedBy: decision.requestedBy, approvedBy: approver.id, decision: decision.id, reason: decision.reason, approvalReason, at: now.toISOString() };
  // One ledger row: `save` appends it, and the intervention fold reads it as the request's resolution (interventions/fold-rules.ts).
  await save(db, work, decision.requestedBy, 'human.superseded', now, details);
  return `Withdrew ${work.key}'s human-only request ${closed.id} as superseded by observation`;
}
