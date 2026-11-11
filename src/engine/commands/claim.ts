import { decisionWork } from '../../store/decision-read.js';
import { readReceipt, record } from '../../store/mutations.js';
import { save } from '../../store.js';
import { demand, observationWindowHold } from '../../model.js';
import { resourceConflicts } from '../../coordination.js';
import { implementerIdentities } from '../../delegation.js';
import { expireAgentRequests } from '../../model/agent-requests.js';
import { beginAttempt, endLapsedAttempt } from '../../pipeline-speed.js';
import type { Ctx, Prepare } from './types.js';
import { adoptFollowUpWindow } from './shared.js';
import { recordDispatch } from '../evaluate.js';

export async function run(c: Ctx) {
  const { engine, db, actor, all, now, work } = c;
  demand(actor.role === 'worker' || actor.role === 'admin', 'Worker permission required', 403);
  demand(!work.lease || Date.parse(work.lease.expiresAt) <= now.getTime(), 'Task already has an active owner');
  demand(!work.submission || work.reworkRequested, 'Implementation is submitted; an operator must request rework before reassignment');
  // A replacement claim over a lapsed lease records how that assignment ended, exactly as reconciliation would have.
  if (work.lease) {
    await record(db, work, 'graphyard', 'lease.expired', { details: { owner: work.lease.owner, epoch: work.lease.epoch, expiresAt: work.lease.expiresAt, submission: work.submission, at: now.toISOString() } });
    endLapsedAttempt(work, work.lease, now);
    work.lease = null;
  }
  // Eligibility against the requirements: ready, dependencies, exclusive
  // and resources are all derived from the document the new attempt will hold.
  demand(work.criteria.length > 0, 'Waiting on the master: writing the criteria');
  demand(work.ready && !work.blocker, 'Task is not ready or has a blocker');
  // GY-1735: the observation window holds the claim itself, so no loop or launcher that predates it (GY-1722, GY-1725) can start an attempt that can only escalate.
  await adoptFollowUpWindow(db, work);
  const window = observationWindowHold(work, now);
  demand(!window, `${work.key} waits for its observation window: the reading it owes can first exist at ${window?.notBefore} (${window?.detail})`, 409);
  demand(work.dependencies.every(dep => all.find(w => w.id === dep)?.stage === 'done'), 'Unfinished dependencies');
  const resources = resourceConflicts(work, all, now.getTime());
  demand(!resources.length, `Exclusive resources held: ${resources.map(r => `${r.resource} by ${r.key}`).join(', ')}`);
  work.epoch++;
  expireAgentRequests(work, now, `epoch ${work.epoch} claimed the item; a request from an attempt that ended is asked afresh`);
  work.implementers = [...new Set([...implementerIdentities(work), actor.id])];
  work.lastAssignment = { owner: actor.id, epoch: work.epoch, claimedAt: now.toISOString(), ...(actor.displayName ? { displayName: actor.displayName } : {}), ...(actor.runtime ? { runtime: actor.runtime } : {}) };
  work.lease = { owner: actor.id, epoch: work.epoch, expiresAt: new Date(now.getTime() + engine.leaseSeconds * 1000).toISOString() };
  beginAttempt(work, work.lease, now);
}

export async function prepare({ engine, actor, id, key }: Prepare) {
  // GY-1735: a claim the observation window refuses rolls its transaction back, so the window a legacy follow-up
  // derives is recorded first, on its own: coordination then holds the item instead of dispatching refused claims.
  // Only a claim the main transaction would judge writes it: a caller without claim authority, or a key that
  // already has a receipt (a replay or a mismatched reuse), leaves the item and its history untouched.
  if (!(actor.role === 'worker' || actor.role === 'admin')) return;
  await engine.store.transaction(async (db, now) => {
    if (await readReceipt(db, actor, key)) return;
    const all = await decisionWork(db, [id]);
    const work = all.find(w => w.id === id || w.key === id);
    if (!work || work.stage === 'done' || work.observationWindow) return;
    await adoptFollowUpWindow(db, work);
    if (!work.observationWindow) return;
    engine.evaluate(work, all, now);
    await recordDispatch(db, work, now);
    await save(db, work, 'graphyard', 'observation-window', now, { observationWindow: work.observationWindow });
  // It is part of the claim, so it takes the claim's lease pool (GY-274): a busy request pool never stalls a claim.
  }, { lane: 'lease', itemLock: id });
}
