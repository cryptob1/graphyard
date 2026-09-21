import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { activeLease, demand, operatorScopeIncludes, type Principal, type Work } from '../model.js';
import { capacityEventSchema, capacityRetryAt, capacitySignature, retainedExhaustions, type CapacityState, type ExhaustionRecord } from '../model/capacity.js';
import { describeHumanRequest, humanAnswerSchema, humanDecisionLabel, humanRequestBlocker, humanRequestSchema, openHumanRequests, retainedHumanRequests, type HumanRequest } from '../model/human-request.js';
import { sessionKind } from '../delegation.js';
import { endAttempt, recordIntervention } from '../pipeline-speed.js';
import { save } from '../store.js';
import type { Services } from './routes.js';

/**
 * The two waits that must stall nothing but the item that has them (GY-89): a session whose
 * provider account ran out mid-work, and a decision only a human may make. Each is one
 * transaction under the coordination lock that ends the attempt's lease, writes typed state on
 * the item and appends history, exactly as the engine's own commands do; what follows — another
 * account, or the human's answer and the dispatch after it — is the loop's, not a master's.
 */

type Db = pg.PoolClient;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const findWork = async (db: Db, id: string): Promise<{ work: Work | undefined; all: Work[] }> => {
  const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(row => row.document);
  return { work: all.find(item => item.id === id || item.key === id), all };
};
async function receipt(db: Db, actor: Principal, key: string, fingerprint: string) {
  demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
  const row = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
  if (row) demand(row.fingerprint === fingerprint, 'Idempotency key reused with different input');
  return row?.result as Work | undefined;
}
/** Re-evaluate, append the evaluation's dispatch transitions, save with history, and keep the receipt. */
async function commit(services: Services, db: Db, now: Date, work: Work, all: Work[], actor: Principal, kind: string, details: unknown, key: string, fingerprint: string) {
  services.engine.evaluate(work, all, now);
  // The engine's auto-dispatch ledger entries for this evaluation; the method is internal to the
  // engine's own transactions, and this is one of them (see decisions.ts).
  await (services.engine as unknown as { recordDispatch(db: Db, work: Work, now: Date): Promise<void> }).recordDispatch(db, work, now);
  await save(db, work, actor.id, kind, now, details);
  await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(work)]);
  return work;
}
/** An attempt that stops without finishing ends on the record as released, never as a silent lapse. */
function endLease(work: Work, epoch: number, now: Date) {
  endAttempt(work, epoch, 'released', now);
  work.lease = null;
  // The scope request of an attempt that no longer exists is moot; a fresh attempt asks afresh.
  work.scopeRequest = null;
}

/**
 * A worker records the human-only decision its item needs. The same transaction ends the
 * worker's lease and parks the item, so the session exits owning nothing and no supervisor keeps
 * an item that cannot move.
 */
export async function requestHumanDecision(services: Services, actor: Principal, id: string, body: unknown, key: string) {
  const data = humanRequestSchema.parse(body);
  const fingerprint = digest({ id, park: data });
  return services.engine.store.transaction(async (db, now) => {
    const replay = await receipt(db, actor, key, fingerprint); if (replay) return replay;
    demand(actor.role === 'worker' || actor.role === 'admin', 'Worker permission required', 403);
    const { work, all } = await findWork(db, id); demand(work, 'Work item not found', 404);
    demand(work!.stage !== 'done', 'Delivered work is immutable');
    activeLease(work!, actor, data.epoch, now);
    demand(!work!.humanRequest, `${work!.key} already waits on human request ${work!.humanRequest?.id}; answer it before recording another`);
    const request: HumanRequest = { id: randomUUID(), kind: data.kind, reason: data.reason, needed: data.needed, requestedBy: actor.id, epoch: data.epoch, at: now.toISOString() };
    work!.humanRequest = request;
    work!.blocker = describeHumanRequest(request);
    recordIntervention(work!, 'blocked');
    endLease(work!, data.epoch, now);
    return commit(services, db, now, work!, all, actor, 'human.requested', { request, decision: humanDecisionLabel[request.kind], leaseEnded: { owner: actor.id, epoch: data.epoch } }, key, fingerprint);
  });
}

/**
 * The human's answer. It is the whole resumption: a provided answer clears the request and its
 * blocker in one transaction, which leaves the item claimable, and the loop dispatches claimable
 * work on its next cycle. A declined answer keeps the item parked on the human's own words. Only
 * a declared human session may answer — the three decisions are human by definition, and an
 * agent holding an admin credential is still an agent.
 */
export async function answerHumanDecision(services: Services, actor: Principal, id: string, body: unknown, key: string) {
  const data = humanAnswerSchema.parse(body);
  const fingerprint = digest({ id, answer: data });
  return services.engine.store.transaction(async (db, now) => {
    const replay = await receipt(db, actor, key, fingerprint); if (replay) return replay;
    demand(actor.role === 'admin', 'Only the human operator answers a human-only request', 403);
    demand(sessionKind(actor) === 'human', `A human-only request needs a declared human session; ${actor.id} is ${sessionKind(actor)}`, 403);
    const { work, all } = await findWork(db, id); demand(work, 'Work item not found', 404);
    const request = work!.humanRequest;
    demand(request, `${work!.key} has no open human-only request`, 404);
    demand(request!.id === data.request, `${work!.key}'s open request is ${request!.id}, not ${data.request}; reload before answering`);
    const answered: HumanRequest = { ...request!, answer: { by: actor.id, at: now.toISOString(), outcome: data.outcome, text: data.answer, waitedMs: Math.max(0, now.getTime() - Date.parse(request!.at)) } };
    work!.humanRequests = [...(work!.humanRequests ?? []), answered].slice(-retainedHumanRequests);
    work!.humanRequest = null;
    if (work!.blocker?.startsWith(humanRequestBlocker)) work!.blocker = data.outcome === 'provided' ? null : `A human declined ${humanDecisionLabel[answered.kind]} for this item: ${data.answer}`.slice(0, 2000);
    return commit(services, db, now, work!, all, actor, 'human.answered', { request: answered, resumed: data.outcome === 'provided' }, key, fingerprint);
  });
}

/** Every open human-only request the caller may see, longest wait first. */
export async function listHumanRequests(services: Services, actor: Principal) {
  const snapshot = await services.engine.store.workSnapshot();
  const visible = snapshot.work.filter(item => operatorScopeIncludes(actor, item));
  return { now: snapshot.now, requests: openHumanRequests(visible, Date.parse(snapshot.now)) };
}

const capacityOf = (work: Work): CapacityState => work.capacity ?? { exhaustions: [], escalations: [] };

/**
 * What the master loop observed about provider capacity, recorded by its coordinator identity.
 *
 * `exhausted` is a session that ran out of quota mid-work: the account, the provider's notice,
 * its reset time and how the partial work was kept go into history, and — for a worker — the
 * attempt's lease ends in the same transaction, so the item is claimable on another account the
 * moment its containment settles instead of after a lease nobody renews has lapsed. `escalated`
 * is a role with no account left; `restored` withdraws it. Repeating an observation already on
 * the record changes nothing, so a loop that reports every cycle writes history once.
 */
export async function recordCapacity(services: Services, actor: Principal, id: string, body: unknown, key: string) {
  const data = capacityEventSchema.parse(body);
  const fingerprint = digest({ id, capacity: data });
  return services.engine.store.transaction(async (db, now) => {
    const replay = await receipt(db, actor, key, fingerprint); if (replay) return replay;
    demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
    const { work, all } = await findWork(db, id); demand(work, 'Work item not found', 404);
    demand(work!.stage !== 'done', 'Delivered work is immutable');
    const capacity = capacityOf(work!);
    if (data.event === 'exhausted') {
      const { event: _event, ...report } = data;
      const same = (entry: ExhaustionRecord) => entry.role === report.role && entry.profile === report.profile && entry.account === report.account
        && (report.role === 'worker' ? entry.epoch === report.epoch : entry.requestId === report.requestId && entry.resetsAt === report.resetsAt);
      if (capacity.exhaustions.some(same)) return work!;
      let owner: string | null = null;
      if (report.role === 'worker') {
        demand(work!.epoch === report.epoch, `Attempt ${report.epoch} is not ${work!.key}'s current attempt (${work!.epoch}); reload before reporting`);
        demand(!work!.submission || work!.submission.epoch !== report.epoch, `Attempt ${report.epoch} already submitted; nothing is left to re-queue`);
        owner = work!.lease?.epoch === report.epoch ? work!.lease.owner : work!.lastAssignment?.epoch === report.epoch ? work!.lastAssignment.owner : null;
        if (work!.lease?.epoch === report.epoch) endLease(work!, report.epoch, now);
      }
      const record: ExhaustionRecord = { ...report, at: now.toISOString(), owner, recordedBy: actor.id };
      work!.capacity = { ...capacity, exhaustions: [...capacity.exhaustions, record].slice(-retainedExhaustions) };
      return commit(services, db, now, work!, all, actor, 'capacity.exhausted', { exhaustion: record, requeued: report.role === 'worker' ? 'the attempt ended as released; the item is claimable on another account once its containment settles' : 'the request is launched again on another account' }, key, fingerprint);
    }
    const standing = capacity.escalations.find(entry => entry.role === data.role);
    if (data.event === 'escalated') {
      if (standing && capacitySignature(standing.role, standing.accounts) === capacitySignature(data.role, data.accounts)) return work!;
      const escalation = { role: data.role, at: now.toISOString(), accounts: data.accounts, retryAt: capacityRetryAt(data.accounts) };
      work!.capacity = { ...capacity, escalations: [...capacity.escalations.filter(entry => entry.role !== data.role), escalation] };
      return commit(services, db, now, work!, all, actor, 'capacity.escalated', { escalation }, key, fingerprint);
    }
    if (!standing) return work!;
    work!.capacity = { ...capacity, escalations: capacity.escalations.filter(entry => entry.role !== data.role) };
    return commit(services, db, now, work!, all, actor, 'capacity.restored', { role: data.role, reason: data.reason, escalation: standing }, key, fingerprint);
  });
}
