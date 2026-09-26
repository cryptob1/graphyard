import type pg from 'pg';
import { demand, operatorCapability, type Principal, type Work } from '../model.js';
import { closeRefusal, closeSchema, closureRefRefusal, commitRef, itemRef, type Closure } from '../model/closure.js';
import { dispatchHistoryLimit, type DispatchRequest } from '../model/dispatch.js';
import { humanRequestBlocker, retainedHumanRequests, type HumanRequest } from '../model/human-request.js';
import { endAttempt } from '../pipeline-speed.js';
import { save, wakeJob } from '../store.js';
import { authenticated, digest, receipt, record } from './decisions.js';
import type { Services } from './routes.js';

type Db = pg.PoolClient;

/**
 * Close a work item that will never be delivered (`graphyard master close`): a duplicate, work a
 * delivered change already superseded, or work nobody wants any more. One transaction under the
 * coordination lock moves the item to the terminal stage with a `closure` record, cancels every
 * open review and producer request, withdraws an open human-only request so the Needs-you page
 * stops listing it, retires the item's action rows through the ordinary evaluation, and appends
 * `work.closed` with the actor and the reason. A live worker lease or an in-flight merge execution
 * refuses it. Commit ancestry is read from GitHub before the transaction, never inside it.
 */
export async function closeWork(services: Services, caller: Principal, id: string, body: unknown, key: string) {
  const data = closeSchema.parse(body);
  const ref = data.ref ?? null;
  const fingerprint = digest({ id, close: data });
  // A superseding commit must already be on the base branch; asked outside the transaction.
  let ancestry: { base: string; contained: boolean } | null = null;
  if (data.kind === 'superseded' && ref && !itemRef.test(ref) && commitRef.test(ref)) {
    demand(services.github, 'GitHub integration is required to verify that the superseding commit is on the base branch', 503);
    const base = (await services.github!.baseBranch()).tip;
    ancestry = { base, contained: await services.github!.contains(ref, base) };
  }
  return services.engine.store.transaction(async (db: Db, now: Date) => {
    const actor = await authenticated(services, db, now, caller);
    const replay = await receipt(db, actor, key, fingerprint); if (replay) return replay as unknown as Work;
    demand(['admin', 'coordinator', 'operator-agent'].includes(actor.role), 'Only the master (coordinator or operator agent) or an admin may close work', 403);
    const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(row => row.document);
    const work = all.find(item => item.id === id || item.key === id); demand(work, 'Work item not found', 404);
    if (actor.role === 'operator-agent') operatorCapability(actor, 'intent:create', work!, services.repository);
    const refused = closeRefusal(work!, now.getTime()); demand(!refused, refused!, 409);
    const badRef = closureRefRefusal(work!, all, data.kind, ref); demand(!badRef, badRef!, 422);
    if (ancestry) demand(ancestry.contained, `Commit ${ref} is not an ancestor of the base branch (${ancestry.base.slice(0, 12)}); an item is superseded only by work that landed`, 422);
    const closure: Closure = { kind: data.kind, reason: data.reason, ref, by: actor.id, at: now.toISOString(), from: work!.stage };
    const settled = settleOpenRequests(work!, closure, now);
    // A lapsed lease reconciliation never reached ends here, as released.
    if (work!.lease) { endAttempt(work!, work!.lease.epoch, 'released', now); work!.lease = null; }
    const queued = !!work!.queue;
    Object.assign(work!, { closure, stage: 'done', stageEnteredAt: now.toISOString(), reviewRequest: null, scopeRequest: null, blocker: null });
    services.engine.evaluate(work!, all, now);
    // Nothing closed may be queued or merged, whatever its last gates said.
    Object.assign(work!, { queue: null, mergeAuthorization: null });
    // The engine's own ledger entries for this evaluation (see waits.ts); internal to its transactions.
    await (services.engine as unknown as { recordDispatch(db: Db, work: Work, now: Date): Promise<void> }).recordDispatch(db, work!, now);
    for (const request of settled.cancelled) await record(db, work!, 'graphyard', 'dispatch.cancelled', { details: { ...request, at: now.toISOString() } });
    await save(db, work!, actor.id, 'work.closed', now, { closure, actor: actor.id, reason: data.reason, cancelled: settled.cancelled.map(request => request.id), withdrawn: settled.withdrawn?.id ?? null, agentRequests: settled.agentRequests });
    // Entries queued behind a closed one predict against the real base again.
    if (queued) for (const peer of all) if (peer.queue && peer.id !== work!.id) await wakeJob(db, peer.id);
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(work)]);
    return work!;
  });
}

/** Cancel the item's open dispatch requests, withdraw its human-only request and resolve its agent requests. */
export function settleOpenRequests(work: Work, closure: Closure, now: Date) {
  const at = now.toISOString(), resolution = `item closed as ${closure.kind}: ${closure.reason}`.slice(0, 2000);
  const cancelled: DispatchRequest[] = [];
  if (work.autoDispatch) {
    const state = work.autoDispatch;
    for (const request of [state.review, ...state.producers]) if (request && request.state === 'requested') cancelled.push({ ...request, state: 'cancelled', resolvedAt: at, resolution });
    work.autoDispatch = { review: null, producers: [], history: [...state.history, ...cancelled].slice(-dispatchHistoryLimit) };
  }
  let withdrawn: HumanRequest | null = null;
  if (work.humanRequest && !work.humanRequest.answer) {
    withdrawn = { ...work.humanRequest, answer: { by: closure.by, at, outcome: 'withdrawn', text: 'withdrawn: item closed', waitedMs: Math.max(0, now.getTime() - Date.parse(work.humanRequest.at)) } };
    work.humanRequests = [...(work.humanRequests ?? []), withdrawn].slice(-retainedHumanRequests);
    work.humanRequest = null;
    if (work.blocker?.startsWith(humanRequestBlocker)) work.blocker = null;
  }
  let agentRequests = 0;
  for (const request of work.agentRequests ?? []) {
    if (request.state !== 'open') continue;
    request.state = 'resolved'; request.resolvedAt = at; request.resolution = resolution; agentRequests++;
  }
  return { cancelled, withdrawn, agentRequests };
}
