import { decisionWork } from '../store/decision-read.js';
import { readReceipt, record } from '../store/mutations.js';
import { stableJson } from '../model/stable-json.js';
import { save, eventWorkSql } from '../store.js';
import { requireCurrent, currentCarry, refreshedCarriedApproval, demand } from '../model.js';
import type { CarriedApproval, Principal, Work, Observation } from '../model.js';
import { gitRunnerFor, observeHead as observeLocalHead } from '../merge-writer/local-observation.js';
import { sameObservationInputs } from '../model/observation-save.js';
import { observeHead } from '../model/attempt-bound.js';
import { observeBaseHold } from '../model/behind-base.js';
import { workIdByRef } from '../store/locked-read.js';
import type { Engine } from '../engine.js';
import { recordDispatch } from './evaluate.js';

/**
 * Whether two readings of one item differ only in action-queue bookkeeping (GY-607). Claiming,
 * renewing, completing or failing a row moves the item's rows, its revision and its `updatedAt`,
 * and nothing a gate reads; everything else is compared by its stable JSON, so any other change
 * still counts.
 */
export function sameBesideActions(read: Work, current: Work): boolean {
  const rest = ({ actionQueue: _queue, revision: _revision, updatedAt: _updated, ...others }: Work) => stableJson(others);
  return rest(read) === rest(current);
}
/**
 * Whether two readings of one item differ only in the loop's own bookkeeping (GY-1257): the action
 * queue (`sameBesideActions`), plus what each save re-derives or the loop records about the item
 * rather than the submitted work — its next action and gates, the sessions it
 * reports. None of it is what a GitHub observation
 * reads, and the observation's own save re-evaluates the gates, so it never stands on a stale one.
 */
export function sameBesideBookkeeping(read: Work, current: Work): boolean {
  const rest = ({ actionQueue: _queue, revision: _revision, updatedAt: _updated, nextAction: _next, gates: _gates,
    sessions: _sessions, ...others }: Work) => stableJson(others);
  return rest(read) === rest(current);
}
/** How many saves behind a reader may be and still have its read resolved from the ledger. */
export const actionOnlyLookback = 20;
/**
 * Whether the item as it stood at `revision` — every save appends the document it wrote to the
 * ledger — differs from `work` only in action-queue bookkeeping. A writer that read the item at
 * that revision may then still write: what it read is what it would read now.
 */
export async function onlyActionsMovedSince(db: { query: (text: string, values: unknown[]) => Promise<{ rows: any[] }> }, work: Work, revision: number, same = sameBesideActions): Promise<boolean> {
  const read = await revisionAt(db, work, revision, actionOnlyLookback);
  return !!read && same(read, work);
}
/** The item as its save at `revision` wrote it to the ledger, when that save is at most `lookback` saves behind `work`. */
export async function revisionAt(db: { query: (text: string, values: unknown[]) => Promise<{ rows: any[] }> }, work: Work, revision: number, lookback: number): Promise<Work | null> {
  const behind = work.revision - revision;
  if (!Number.isInteger(behind) || behind <= 0 || behind > lookback) return null;
  const read = (await db.query(`SELECT ${eventWorkSql('saved')} AS work FROM (SELECT work_id, payload FROM events WHERE work_id=$1 AND (payload ? 'work' OR payload ? 'delta') ORDER BY seq DESC OFFSET $2 LIMIT 1) saved`, [work.id, behind])).rows[0]?.work as Work | undefined;
  return read && read.revision === revision ? read : null;
}

/**
 * GY-1523: the control plane's own observation of a head submitted with `complete --head`, read
 * from the shared object store before the transaction.
 * Receipt first, so a replayed `complete` runs no git. The candidate's change number is
 * allocated inside the transaction, which binds it to this observation.
 */
export async function observeSubmittedHead(engine: Engine, actor: Principal, id: string | null, data: { epoch: number; head: string }, key: string): Promise<Observation | null> {
  if (!id) return null;
  if (await readReceipt(engine.store.leasePool, actor, key)) return null;
  // `complete` is a lease command (GY-558): its reads take the lease pool, like its transaction.
  const work: Work | undefined = (await engine.store.leasePool.query(`SELECT document FROM work_items WHERE id = ${workIdByRef('$1')}`, [id])).rows[0]?.document;
  const workspace = work?.workspaces.find(w => w.epoch === data.epoch);
  // GY-2010: an item a stored adoption (GY-1849) still names completes as a head like any other:
  // its replacement commit is read from the shared object store, never from the pull request.
  if (!work || work.stage === 'done' || !workspace) return null;
  // A superseded owner reaches the transaction's lease refusal before observation. Leave
  // expiry to that transaction: a recorded renewal fault may still keep this lease live.
  if (!work.lease || work.lease.owner !== actor.id || work.lease.epoch !== data.epoch) return null;
  if (engine.gitRunner === undefined) engine.gitRunner = gitRunnerFor(process.env.GRAPHYARD_REPOSITORY_ROOT ?? process.cwd());
  demand(engine.gitRunner, 'The control plane has no checkout to read a submitted head from; a head submission needs the merge writer checkout', 503);
  return observeLocalHead(engine.gitRunner, { head: data.head, base: engine.baseBranch, branch: workspace.branch, author: actor.id });
}
/**
 * Observe a candidate head from the local Git repository checkout in control-plane mode.
 */
export async function observeControlPlaneCandidate(engine: Engine, work: Work): Promise<Observation | null> {
  if (!work.candidate) return null;
  if (engine.gitRunner === undefined) engine.gitRunner = gitRunnerFor(process.env.GRAPHYARD_REPOSITORY_ROOT ?? process.cwd());
  if (!engine.gitRunner) return null;
  const observation = await observeLocalHead(engine.gitRunner, {
    head: work.candidate.sha,
    base: engine.baseBranch,
    branch: work.candidate.branch,
    author: work.candidate.author,
  });
  const recorded = work.observation?.reviews ?? [];
  observation.reviews = [...recorded];
  observation.reviewIds = observation.reviews.map(r => r.id).filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0);
  if (work.candidate.pr) observation.candidate.pr = work.candidate.pr;
  // GY-2989: when a product review approved an earlier head, the paths between it and this head
  // decide whether that approval carries (product-review.ts). One diff, read outside the
  // transaction; a read that fails leaves it unset, and the head is reviewed afresh.
  const approved = work.productReview?.verdict === 'approved' ? work.productReview : null;
  if (approved && approved.sha !== work.candidate.sha) {
    const delta = await engine.gitRunner!(['diff', '--name-only', approved.sha, work.candidate.sha]);
    if (delta.status === 0) observation.headDelta = delta.stdout.split('\n').map(line => line.trim()).filter(Boolean);
  }
  return observation;
}
/**
 * Save a provider observation of the item, read at `expectedRevision`.
 *
 * An item that moved since that read refuses the observation, except where every move was
 * action-queue bookkeeping (`onlyActionsMovedSince`): an executor claiming or settling the item's
 * `resync` row saves the item, and refusing the observation over that write discarded the very
 * reading the row was waiting for, so the item stayed stale and the row was claimed again,
 * forever (GY-607). The loop's own bookkeeping counts the same way (`sameBesideBookkeeping`,
 * GY-1257): its per-cycle writes refused the very observation it had woken for a rework decision.
 * Any other move that left everything the observation was derived from unchanged counts the same
 * (`sameObservationInputs`, GY-1310): a session, lease, evidence or dispatch write raced every poll,
 * so gate claims waited minutes for an observation that was taken and then discarded.
 */
export async function observe(engine: Engine, id: string, expectedRevision: number, observation: Observation, jobToken?: string) {
  return engine.store.transaction(async (db, now) => {
    if (jobToken) {
      // The item row before the job row (GY-1115): the order every transaction takes them in, so this never deadlocks a reconciliation batch.
      // This job row is locked mid-transaction and the queue's wakes at COMMIT lock theirs after it, out of work-id order:
      // the one exception to the job rows' stable order (GY-1212). Wakes never wait on a row out of order themselves, so a
      // cycle needs two observations each holding its own job and each waking the other's, which only two deliveries of
      // queued items observed at the same instant do (each still sees the other queued). Postgres then aborts one as a
      // deadlock; its observation is refused, nothing is saved, and its job is claimed again once its lease lapses.
      await db.query('SELECT 1 FROM work_items WHERE id=$1 FOR UPDATE', [id]);
      const owned = await db.query('SELECT 1 FROM jobs WHERE work_id=$1 AND token=$2 AND locked_until>clock_timestamp() FOR UPDATE', [id, jobToken]);
      requireCurrent(owned.rowCount, 'Integration job lease expired or superseded; retry');
    }
    const all = await decisionWork(db, [id]);
    const work = all.find(w => w.id === id);
    requireCurrent(work && (work.revision === expectedRevision || await onlyActionsMovedSince(db, work, expectedRevision, sameObservationInputs)), 'Task changed while GitHub was being observed; retry');
    demand(work.submission?.pr === observation.candidate.pr, 'Unassigned pull request');
    demand(work.workspaces.some(w => w.epoch === work.submission!.epoch && w.branch === observation.candidate.branch), 'PR branch does not match the assigned workspace');
    if (work.stage === 'done') return work;
    // GY-1523: a candidate the control plane observed itself carries a change number, not a pull
    // request number; a GitHub reading of the pull request that happens to bear it is not this candidate.
    if (work.observation?.source === 'control-plane' && observation.source === undefined) return work;
    // When this pull request's head was first observed (GY-1460): the worker bound reads a push from it, never a poll.
    observeHead(work, observation.candidate, observation.at);
    work.candidate = observation.candidate;
    work.observation = observation;
    // When the hold on this head was first sighted (GY-1557): the actorless bound runs from it, never from a poll that reads it again.
    observeBaseHold(work, observation.at);
    // A newer approval of the head a base refresh was built from replaces the carried binding
    // (GY-831), so the binding names a review the pull request still holds.
    const refreshed = refreshedCarriedApproval(work);
    const carrying = refreshed ? currentCarry(work) : null;
    if (refreshed && carrying) {
      const replaced = carrying.approval as CarriedApproval;
      carrying.approval = refreshed;
      await record(db, work, 'graphyard', 'review.carry-refreshed', { details: { reviewer: refreshed.reviewer, reviewId: refreshed.reviewId, sha: refreshed.originalSha, replaced: { reviewId: replaced.reviewId ?? null, sha: replaced.originalSha }, candidate: work.candidate!.sha } });
    }
    engine.evaluate(work, all, now);
    await recordDispatch(db, work, now);
    await save(db, work, 'github', 'github.observed', now);
    return work;
  }, { itemLock: id });
}
