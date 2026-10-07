import { z } from 'zod';
import { Refusal, demand, itemLane, reworkNeedsApprover, type Principal, type Work } from '../model.js';
import type pg from 'pg';
import { idempotencyMismatch } from '../engine.js';
import { assertDecisionAuthority, decisionPrecondition, requiredDecisionCapabilities, situationLabel, stalledApproval, supersededSituation } from '../model/approval.js';
import { decisionRace, readDecisions, type DecisionRecord, type StaleRace } from './decision-ledger.js';
import { applyThroughEngine, authenticated, bookkeepingRebase, findWork, receipt, record, requesterAuthority, staleEvent } from './decisions.js';
import { withdrawDecision } from './decision-refusal.js';
import { laneApprover, reworkGround } from '../model/rework-ground.js';
import type { Services } from './routes.js';

// A rework on a low- or medium-lane item needs no approver decision (GY-883 AC-2): the risk lane
// approves and applies it. So does one on any lane whose ground the record shows (GY-1394,
// model/rework-ground.ts): a trusted proof failed on the head, an approver refused its attestation,
// or the control plane's own test merge conflicts with its base (GitHub's reading alone is no
// ground, GY-375). Approval and application are separate transactions for every action but
// resolve and merge, so an interruption between them is settled here rather than left standing
// approved: first only the lane's own (GY-1110), then any approver's — superseded once the item
// moved past it (GY-1297), or resumed under its recorded approval (GY-1297, GY-1300).

// The ledger's approver of a rework its lane (GY-883) or its recorded ground (GY-1394) applied without an approver decision.
export { laneApprover } from '../model/rework-ground.js';

/**
 * A decision approved whose application recorded no outcome (GY-1300): neither decision.applied,
 * decision.failed nor decision.stale follows its decision.approved. Resolve and merge are applied in
 * the approval's own transaction, so they never strand.
 */
export const approvedUnapplied = (decision: Pick<DecisionRecord, 'state' | 'action'>) =>
  decision.state === 'approved' && decision.action !== 'resolve' && decision.action !== 'merge';

const resumeSchema = z.object({ decision: z.string().uuid() }).strict();

/**
 * The loop's own way to apply one approved-unapplied decision (GY-1300), beside decide and withdraw
 * on the same route: `{ action: 'resume', decision }`. A caller with authority for the decision's
 * action asks the server to settle what its approver approved, without waiting out the grace a
 * request or withdrawal gives an approval in flight: the loop sends it once the approver session
 * has ended, so nothing else is applying it. It approves nothing. A decision the item moved past
 * settles superseded; one that already recorded an outcome is answered as it stands.
 */
export async function resumeDecision(services: Services, caller: Principal, id: string, body: unknown, key: string): Promise<DecisionRecord> {
  const { action: _action, ...rest } = (body ?? {}) as Record<string, unknown>;
  const data = resumeSchema.parse(rest);
  const named = async () => services.engine.store.transaction(async (db, now) => {
    const actor = await authenticated(services, db, now, caller);
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const work = await findWork(db, id); demand(work, 'Work item not found', 404);
    const decision = (await readDecisions(db, work!)).find(entry => entry.id === data.decision);
    demand(decision, `Decision ${data.decision} does not exist on ${work!.key}`, 404);
    for (const capability of requiredDecisionCapabilities(decision!.action, decision!.input, work!)) assertDecisionAuthority(actor, capability, work!, services.repository);
    return decision!;
  });
  const standing = await named();
  if (!approvedUnapplied(standing)) return standing;
  return (await settleApprovedDecisions(services, caller, id, { only: standing.id, immediate: true })).find(entry => entry.id === standing.id) ?? named();
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
    const history = await readDecisions(db, work!), decision = history.find(entry => entry.id === requested.id)!;
    if (decision.state !== 'requested' || decisionPrecondition(decision.action, decision.input, work!)) return decision;
    // A high-lane rework still applies at once when the record itself is its ground (GY-1394); the
    // ground is recorded in any lane, and the intervention fold reads it.
    const lane = itemLane(work!), ground = reworkGround(work!, history);
    if (reworkNeedsApprover(work!) && !ground) return decision;
    const reason = ground && reworkNeedsApprover(work!) ? `${ground}, so the record is the rework's ground and no approver decision is needed (GY-1394)` : `the ${lane} risk lane applies a rework without an approver decision (GY-883)${ground ? `; the record shows its ground: ${ground}` : ''}`;
    await record(db, work!, laneApprover, 'decision.approved', { id: decision.id, action: decision.action, reason, requestedBy: decision.requestedBy, approver: { id: laneApprover, role: 'risk-lane' }, lane, ...(ground ? { ground } : {}) });
    return (await readDecisions(db, work!)).find(entry => entry.id === requested.id)!;
  });
  return approvedUnapplied(approved) && approved.approvedBy === laneApprover ? resumeApproved(services, approved) : approved;
}

/**
 * Apply one approved decision under its recorded approval (GY-1300): the lane's own application,
 * and the resumption of any approver's whose outcome was lost. It is idempotent and single-outcome.
 * The engine call is the one approveDecision makes — the same key (decision:<id>), actor, approval
 * reason, and input, rebased as the approval rebases it when the revision it pins moved only in
 * bookkeeping (GY-1296) — so a call that already ran is replayed, never run twice. A call that ran
 * under a revision the bookkeeping has moved since answers the decision key with other input: it is
 * the approval's own committed application, and settles applied. A requester whose authority is
 * gone, or a refusal, settles it failed; a refusal from a revision race (the situation it was
 * pinned to has moved) settles it stale through recordStale's entry, so it stops blocking. The
 * outcome is written only while the decision still stands approved: of two resumers, or a resumer
 * and its approver repeating the approval, the first outcome settles it. With `resumed`, a failure
 * names the lost application it resumed. A server fault is thrown, with nothing recorded.
 */
export async function resumeApproved(services: Services, stranded: DecisionRecord, resumed = false): Promise<DecisionRecord> {
  const approver = { id: stranded.approvedBy!, role: 'admin' } as Principal;
  const failure = (message: string) => resumed ? `Approved by ${stranded.approvedBy} at ${stranded.approvedAt} but its application was never recorded; resuming it was refused: ${message}`.slice(0, 2000) : message;
  let outcome: { kind: string; details: { outcome?: string; error?: string; resumed?: boolean } }, race: StaleRace | null = null, judged = stranded;
  try {
    // The requester's authority is re-read, as the approval's own resumption reads it. An engine call that never ran is
    // judged against the situation the decision was pinned to: one the item has moved past settles stale, never applies.
    // One that ran (its decision-keyed receipt stands) moved that situation itself, and is only replayed.
    const found = await services.engine.store.transaction(async db => {
      const work = await findWork(db, stranded.workId); demand(work, 'Work item not found', 404);
      await requesterAuthority(services, db, stranded, work!);
      judged = await bookkeepingRebase(db, stranded, work!);
      const ran = !!(await db.query('SELECT 1 FROM receipts WHERE actor=$1 AND key=$2', [stranded.requestedBy, `decision:${stranded.id}`])).rowCount;
      const pinned = ran ? null : decisionRace(judged, work!);
      return { ran, moved: pinned && { race: pinned, error: decisionPrecondition(judged.action, judged.input, work!) ?? `${work!.key} moved past the situation the decision was pinned to` } };
    });
    race = found.moved?.race ?? null;
    if (found.moved) outcome = { kind: 'decision.stale', details: { error: found.moved.error } };
    else {
      const applied = await applyThroughEngine(services, judged, approver, stranded.approvalReason ?? '').catch((error: unknown) => {
        if (found.ran && error instanceof Refusal && error.message === idempotencyMismatch) return `Applied by its approval's own engine call (decision:${stranded.id}), which committed before its outcome was recorded`;
        throw error;
      });
      outcome = { kind: 'decision.applied', details: { outcome: applied, ...(resumed ? { resumed } : {}) } };
    }
  } catch (error) {
    if (!(error instanceof Refusal) && !(error instanceof z.ZodError)) throw error;
    outcome = { kind: 'decision.failed', details: { error: failure(error.message), ...(resumed ? { resumed } : {}) } };
  }
  return services.engine.store.transaction(async db => {
    const work = await findWork(db, stranded.workId); demand(work, 'Work item not found', 404);
    const current = (await readDecisions(db, work!)).find(entry => entry.id === stranded.id)!;
    if (current.state !== 'approved') return current;
    // A refusal from a revision race settles stale too: the item moved while the call was being made.
    race = outcome.kind === 'decision.applied' ? null : race ?? decisionRace(judged, work!);
    if (race) await staleEvent(db, { actor: approver, workId: work!.id, decision: current, reason: `${outcome.details.error}; the decision was not applied`, ...race });
    else await record(db, work!, approver.id, outcome.kind, { id: current.id, ...outcome.details });
    return (await readDecisions(db, work!)).find(entry => entry.id === stranded.id)!;
  });
}

/**
 * A withdrawal, which first settles the decision when it stands approved and unapplied (GY-1297):
 * an approval cannot be taken back, so the loop that finds a standing approval superseded or
 * stalled — its own request, or one a master put to an approver by hand — sends the withdrawal and
 * gets the settlement. Settling needs no requester: the requester, or anyone with the authority to
 * request the decision's action, may settle it, since it only records what the item already shows
 * or applies the approval as given. One the settlement applied is refused naming that, so the loop
 * requests nothing in its place. Taking back a requested decision stays the requester's alone.
 */
export async function withdrawOrSettle(services: Services, caller: Principal, id: string, body: unknown, key: string) {
  const named = typeof (body as any)?.decision === 'string' ? (body as any).decision as string : null;
  const settled = named ? (await settleApprovedDecisions(services, caller, id, { only: named })).find(decision => decision.id === named) : undefined;
  if (settled?.state === 'applied') throw new Refusal(`Decision ${settled.id} (${settled.action}) stood approved by ${settled.approvedBy} with no outcome recorded; its application was resumed and it is applied now (${settled.outcome}), so there is nothing to withdraw`, 409);
  if (settled) return settled;
  // Superseded already, by another request for the item: the loop's history may predate it, and the answer is the same.
  const superseded = named ? await services.engine.store.transaction(async (db, now) => {
    const actor = await authenticated(services, db, now, caller), work = await findWork(db, id);
    const decision = work ? (await readDecisions(db, work)).find(entry => entry.id === named) : undefined;
    return decision?.state === 'superseded' && mayRequest(services, actor, decision, work!) ? decision : undefined;
  }) : undefined;
  return superseded ?? withdrawDecision(services, caller, id, body, key);
}

/** Whether `actor` requested `decision`, or holds the authority to request its action on `work` itself. */
function mayRequest(services: Services, actor: Principal, decision: DecisionRecord, work: Work) {
  if (decision.requestedBy === actor.id) return true;
  try { for (const capability of requiredDecisionCapabilities(decision.action, decision.input, work)) assertDecisionAuthority(actor, capability, work, services.repository); return true; }
  catch (error) { if (error instanceof Refusal) return false; throw error; }
}

/**
 * Settle the item's approved, unapplied decisions (GY-1297, GY-1300; `supersededSituation` and
 * `stalledApproval` in model/approval.ts say when). One whose situation moved is recorded
 * `superseded`, naming the head and base it was bound to and the item's current ones. One whose
 * situation holds is resumed by `resumeApproved` — at once for the risk lane's own approvals
 * (GY-1110), whose approval and application are one request, and with `immediate` (the loop's
 * resume, sent once the approver session ended); otherwise only past the grace its own approval
 * had to apply it — and settles applied, failed or stale. A server fault while resuming an
 * approver's decision settles it failed, naming the fault, since a decision left approved after a
 * fault refuses every later request of its action; one while resuming the lane's is logged and left
 * for the next request (GY-1244), so it never fails the request that triggered it. `only` limits the
 * settlement to one decision, which the caller must have requested or be able to request. Returns
 * what it settled.
 */
export async function settleApprovedDecisions(services: Services, caller: Principal, id: string, options: { only?: string; immediate?: boolean } = {}): Promise<DecisionRecord[]> {
  const { only, immediate = false } = options;
  const found = await services.engine.store.transaction(async (db, now) => {
    const actor = await authenticated(services, db, now, caller);
    const work = await findWork(db, id);
    if (!work) return { superseded: [] as DecisionRecord[], due: [] as DecisionRecord[] };
    const history = (await readDecisions(db, work)).filter(decision => approvedUnapplied(decision) && (!only || (decision.id === only && mayRequest(services, actor, decision, work))));
    const superseded = await supersedeMoved(db, work, history, actor);
    const due = history.filter(decision => !superseded.some(entry => entry.id === decision.id) && (immediate || decision.approvedBy === laneApprover || stalledApproval(decision, now.getTime())));
    return { superseded, due };
  });
  const settled = [...found.superseded];
  for (const decision of found.due) {
    try { settled.push(await resumeApproved(services, decision, decision.approvedBy !== laneApprover)); }
    catch (error) {
      const fault = error instanceof Error ? error.message : 'unknown';
      if (decision.approvedBy === laneApprover) { console.error(`lane rework ${decision.id} on ${id} could not be resumed; the next request retries it:`, fault); continue; }
      settled.push(await services.engine.store.transaction(async db => {
        // The approval's own application, or a second resumer, may have settled it meanwhile; the first outcome stands.
        const work = await findWork(db, id); demand(work, 'Work item not found', 404);
        const current = (await readDecisions(db, work!)).find(entry => entry.id === decision.id)!;
        if (current.state !== 'approved') return current;
        await record(db, work!, decision.approvedBy!, 'decision.failed', { id: decision.id, error: `Approved by ${decision.approvedBy} at ${decision.approvedAt} but its application was never recorded; resuming it failed: ${fault}`.slice(0, 2000), resumed: true });
        return (await readDecisions(db, work!)).find(entry => entry.id === decision.id)!;
      }));
    }
  }
  return settled;
}

/** Record `decision.superseded` for each approved decision whose situation the item has moved past, in the caller's transaction (GY-1297). */
export async function supersedeMoved(db: pg.PoolClient, work: Work, decisions: DecisionRecord[], actor: Principal): Promise<DecisionRecord[]> {
  const settled: DecisionRecord[] = [];
  for (const decision of decisions) {
    const moved = supersededSituation(decision, work);
    if (!moved) continue;
    const reason = `Superseded: approved for ${situationLabel(moved.bound)}, but ${work.key} is now at ${situationLabel(moved.current)}, so it can never apply to what it judged; a ${decision.action} request is judged afresh for the current candidate`;
    await record(db, work, actor.id, 'decision.superseded', { id: decision.id, action: decision.action, reason, bound: moved.bound, current: moved.current, observedBy: { id: actor.id, role: actor.role } });
    settled.push((await readDecisions(db, work)).find(entry => entry.id === decision.id)!);
  }
  return settled;
}
