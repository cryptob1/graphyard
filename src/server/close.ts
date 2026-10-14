import type pg from 'pg';
import { demand, operatorCapability, type Principal, type Work } from '../model.js';
import { closeRefusal, closeSchema, closureRefRefusal, commitRef, itemRef, type CloseInput, type Closure } from '../model/closure.js';
import { followUpRequest } from '../model/observation-window.js';
import { deliveredObservationRefusal } from '../model/loop-observation.js';
import { dispatchHistoryLimit, type DispatchRequest } from '../model/dispatch.js';
import { humanRequestBlocker, retainedHumanRequests, type HumanRequest } from '../model/human-request.js';
import { decisionGroundsMovedSince } from '../engine.js';
import { endAttempt } from '../pipeline-speed.js';
import { save } from '../store.js';
import { foldDecisions } from '../model/approval.js';
import { authenticated, digest, receipt, record } from './decisions.js';
import type { Services } from './routes.js';
import { lockedWork, workIdByRef } from '../store/locked-read.js';

type Db = pg.PoolClient;

/**
 * Close a work item that will never be delivered (`graphyard master close`): a duplicate, work a
 * delivered change already superseded, or work nobody wants any more. One transaction under the
 * coordination lock moves the item to the terminal stage with a `closure` record, cancels every
 * open review and producer request, withdraws an open human-only request so the Needs-you page
 * stops listing it, retires the item's action rows through the ordinary evaluation, and appends
 * `work.closed` with the actor and the reason. A live worker lease refuses it, unless an approved
 * two-party close decision applies it (`decided`, GY-1463) at the revision its approval judged, or
 * one past it that moved nothing its grounds rest on: then the closure ends that lease, as a
 * release. A lease epoch change or any other grounds change since refuses it, named. Commit
 * ancestry is read from GitHub before the transaction, never inside it.
 */
export async function closeWork(services: Services, caller: Principal, id: string, body: unknown, key: string, options: { decided?: { expectedRevision?: number } } = {}) {
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
  // GY-1779: a loop-owned observation item closed on the loop's reading leaves no pull request open: a
  // worker's unsubmitted candidate from before the loop held it (GY-1725, #1172) is closed on GitHub as
  // superseded by the reading, outside the transaction like the ancestry read. One already closed is
  // left as it is. The close is authorised first, on the document as it stands — the caller's role,
  // the item's closability and the reading the ref names — so a refused close never mutates GitHub;
  // the transaction judges the same again under the lock, and a refusal there leaves the reading
  // recorded for the next attempt.
  const superseded = data.kind === 'delivered-observation' ? await supersededPullRequest(services, caller, id, data, options) : null;
  return services.engine.store.transaction(async (db: Db, now: Date) => {
    const actor = await authenticated(services, db, now, caller);
    const replay = await receipt(db, actor, key, fingerprint); if (replay) return replay as unknown as Work;
    demand(['admin', 'coordinator', 'operator-agent'].includes(actor.role), 'Only the master (coordinator or operator agent) or an admin may close work', 403);
    const all = await lockedWork(db, [id]);
    const work = all.find(item => item.id === id || item.key === id); demand(work, 'Work item not found', 404);
    if (actor.role === 'operator-agent') operatorCapability(actor, 'intent:create', work!, services.repository);
    // The approval judged the item at its revision; a replacement claim since, or any other grounds change, was never judged.
    const judged = options.decided?.expectedRevision;
    const moved = judged === undefined ? null : await decisionGroundsMovedSince(db, work!, judged);
    if (moved) demand(false, `${moved[0].toUpperCase()}${moved.slice(1)} since approved revision ${judged} moved the decision's grounds; the close was not applied`, 409);
    const refused = closeRefusal(judged !== undefined && work!.lease ? { ...work!, lease: null } : work!, now.getTime()); demand(!refused, refused!, 409);
    const badRef = closureRefRefusal(work!, all, data.kind, ref) ?? (data.kind === 'delivered-observation' ? deliveredObservationRefusal(work!, all, ref!, now) : null); demand(!badRef, badRef!, 422);
    if (ancestry) demand(ancestry.contained, `Commit ${ref} is not an ancestor of the base branch (${ancestry.base.slice(0, 12)}); an item is superseded only by work that landed`, 422);
    const closure: Closure = { kind: data.kind, reason: data.reason, ref, by: actor.id, at: now.toISOString(), from: work!.stage };
    const settled = settleOpenRequests(work!, closure, now);
    // A lapsed lease reconciliation never reached ends here, as released; so does a live one an approved close decision ends.
    // GY-1687: apply held requirements decisions before terminalizing — applyHeldDecisions refuses done items, and
    // close never enters Engine.execute, so without this the approval would stay held forever (Codex review of fe3b4e08db8e).
    const heldBefore = { lease: work!.lease, containmentQuarantine: work!.containmentQuarantine, plannedFiles: work!.plannedFiles };
    if (work!.lease) { endAttempt(work!, work!.lease.epoch, 'released', now); work!.lease = null; }
    const engine = services.engine as unknown as { applyHeldDecisions(db: Db, work: Work, all: Work[], before: typeof heldBefore, now: Date, ended: { command: string | null; submitted: boolean }): Promise<((db: Db) => Promise<void>)[]> };
    for (const write of await engine.applyHeldDecisions(db, work!, all, heldBefore, now, { command: 'work.closed', submitted: false })) await write(db);
    await settleHeldOnClose(db, work!, now, closure);
    Object.assign(work!, { closure, stage: 'done', stageEnteredAt: now.toISOString(), reviewRequest: null, scopeRequest: null, blocker: null });
    services.engine.evaluate(work!, all, now);
    // Nothing closed may be merged, whatever its last gates said.
    Object.assign(work!, { mergeAuthorization: null });
    // The engine's own ledger entries for this evaluation (see waits.ts); internal to its transactions.
    await (services.engine as unknown as { recordDispatch(db: Db, work: Work, now: Date): Promise<void> }).recordDispatch(db, work!, now);
    for (const request of settled.cancelled) await record(db, work!, 'graphyard', 'dispatch.cancelled', { details: { ...request, at: now.toISOString() } });
    await save(db, work!, actor.id, 'work.closed', now, { closure, actor: actor.id, reason: data.reason, cancelled: settled.cancelled.map(request => request.id), withdrawn: settled.withdrawn?.id ?? null, agentRequests: settled.agentRequests, ...(superseded ? { pullRequest: superseded } : {}) });
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(work)]);
    return work!;
  });
}

const readDocument = async (services: Services, ref: string): Promise<Work | undefined> => (await services.engine.store.pool.query(`SELECT document FROM work_items WHERE id = ${workIdByRef('$1')}`, [ref])).rows[0]?.document;

/**
 * GY-1779: the open pull request of the item being closed as delivered-observation, closed on GitHub as
 * superseded by the loop's reading; null when the item carries none. Closed only once the close is
 * authorised on the document as it stands: a worker-role caller, an item a live lease or a merge
 * holds, or a ref naming no recorded passing reading is refused here, before GitHub is touched, with
 * the refusal the transaction would give. GitHub is required to close one.
 */
async function supersededPullRequest(services: Services, caller: Principal, id: string, data: CloseInput, options: { decided?: { expectedRevision?: number } }): Promise<{ pr: number; outcome: 'closed' | 'already-closed' } | null> {
  demand(['admin', 'coordinator', 'operator-agent'].includes(caller.role), 'Only the master (coordinator or operator agent) or an admin may close work', 403);
  const work = await readDocument(services, id); demand(work, 'Work item not found', 404);
  if (caller.role === 'operator-agent') operatorCapability(caller, 'intent:create', work!, services.repository);
  const now = Date.now();
  const refused = closeRefusal(options.decided?.expectedRevision !== undefined && work!.lease ? { ...work!, lease: null } : work!, now); demand(!refused, refused!, 409);
  // The reading binds to the parent delivery's merge: the parent the follow-up request names is read for the check.
  const request = followUpRequest(work!), parent = request ? await readDocument(services, request.work) : undefined;
  const badRef = closureRefRefusal(work!, [work!], data.kind, data.ref ?? null) ?? deliveredObservationRefusal(work!, parent ? [work!, parent] : [work!], data.ref!, new Date(now)); demand(!badRef, badRef!, 422);
  const pr = work!.candidate?.pr ?? work!.submission?.pr ?? null;
  if (!pr || work!.observation?.merged) return null;
  demand(services.github, `GitHub integration is required to close ${work!.key}'s pull request #${pr} as superseded by the loop's reading`, 503);
  const outcome = await services.github!.closeSupersededPullRequest(pr, `Closed by Graphyard: ${work!.key}'s only work is the loop's post-deploy reading of the serving release, which the loop recorded itself; this pull request is superseded by that reading. ${data.reason}`.slice(0, 2000));
  return { pr, outcome };
}

/**
 * GY-1687: a held requirements decision that did not apply when the close ended the attempt (none was live)
 * must not remain `held` on a done item — nothing will end an attempt again. Settle each remaining hold
 * as failed, naming the closure. A hold that `applyHeldDecisions` already settled stale (or applied /
 * failed) in this transaction is folded out of `held` by `decision.stale` and is not failed again.
 */
async function settleHeldOnClose(db: Db, work: Work, now: Date, closure: Closure) {
  const rows = (await db.query("SELECT actor, kind, payload, created_at FROM events WHERE work_id=$1 AND kind LIKE 'decision.%' ORDER BY seq", [work.id])).rows as { actor: string; kind: string; payload: any; created_at: Date | string }[];
  const held = foldDecisions(work.id, rows.map(row => ({ kind: row.kind, actor: row.actor, at: new Date(row.created_at).toISOString(), payload: row.payload }))).filter(decision => decision.state === 'held' && decision.action === 'requirements');
  for (const decision of held) {
    await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, decision.approvedBy ?? 'graphyard', 'decision.failed',
      JSON.stringify({ id: decision.id, error: `Item closed as ${closure.kind}: ${closure.reason}; the held decision was not applied` })]);
  }
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
