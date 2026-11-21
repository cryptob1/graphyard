// Concern: GY-3335 — the loop's own submission of a finished head a blocked worker named.
import { readReceipt } from '../../store/mutations.js';
import { demand, type Work } from '../../model.js';
import { allocateChangeNumber } from '../../merge-writer/change-numbers.js';
import { gitRunnerFor, observeHead as observeLocalHead } from '../../merge-writer/local-observation.js';
import { observeHead } from '../../model/attempt-bound.js';
import { observeBaseHold } from '../../model/behind-base.js';
import { workIdByRef } from '../../store/locked-read.js';
import { beginAttempt, recordSubmission } from '../../pipeline-speed.js';
import type { Ctx, Prepare } from './types.js';

/**
 * GY-3335: the loop resubmits, as the item's next attempt, the finished head a worker named in a
 * blocker its own `complete` failed on — a fault of the host, never the change. GY-3576: no host
 * verification runs first; the recorded head is submitted with every gate after it unchanged
 * (review, proofs, merge trial), and its merge trial refuses a head whose tests fail. Only the
 * loop may do this, and only a head the item's record names — one a worker committed and its own
 * blocker named, never one the loop produced.
 */
export function screen(c: Ctx) {
  demand(c.actor.role === 'coordinator' || c.actor.role === 'admin', 'Only the loop resubmits a finished head', 403);
}

export async function run(c: Ctx) {
  const { db, actor, data, now, work, observation } = c;
  const record = work.finishedBlockerHead;
  demand(record && record.head === data.head, `${work.key}'s record names no finished head ${data.head.slice(0, 12)} to resubmit`, 409);
  demand(!work.blocker, `${work.key} is still blocked; master unblock clears it first`, 409);
  demand(!work.lease, `${work.key} holds a lease; only its holder submits`, 409);
  demand(!work.submission || work.reworkRequested, `${work.key} is already submitted`, 409);
  demand(observation, `${data.head.slice(0, 12)} could not be observed from the control plane's object store`, 422);
  const workspace = work.workspaces.find(entry => entry.epoch === record.epoch);
  demand(workspace, `The attempt that recorded ${data.head.slice(0, 12)} registered no workspace`, 409);
  // One change number per (item, head), as for any head submission: the candidate, the submission
  // and the number commit together, and a repeated resubmission reads the same number back.
  const number = await allocateChangeNumber(db, work.id, data.head);
  work.epoch += 1;
  beginAttempt(work, { epoch: work.epoch, owner: actor.id }, now);
  work.lastAssignment = { owner: actor.id, epoch: work.epoch, claimedAt: now.toISOString() };
  work.submission = { epoch: work.epoch, pr: number };
  const candidate = { sha: data.head, baseSha: observation.baseTip!, pr: number, branch: workspace.branch, author: record.owner };
  observeHead(work, candidate, observation.at);
  work.candidate = candidate;
  work.observation = { ...observation, candidate };
  observeBaseHold(work, observation.at);
  work.reworkRequested = false;
  work.finishedBlockerHead = null;
  recordSubmission(work, work.epoch, now);
  work.lease = null;
}

/**
 * The control plane's reading of the head about to be resubmitted, from the shared object store
 * before the transaction — the same reading `complete --head` submits. The blocked attempt's own
 * workspace names the branch, and the worker who recorded the head stays its author.
 */
export async function prepare({ engine, actor, id, key, data }: Prepare) {
  if (!id) return null;
  if (await readReceipt(engine.store.leasePool, actor, key)) return null;
  const work: Work | undefined = (await engine.store.leasePool.query(`SELECT document FROM work_items WHERE id = ${workIdByRef('$1')}`, [id])).rows[0]?.document;
  const record = work?.finishedBlockerHead;
  const workspace = record && record.head === data.head ? work.workspaces.find(entry => entry.epoch === record.epoch) : undefined;
  if (!record || !workspace || work.stage === 'done') return null;
  if (engine.gitRunner === undefined) engine.gitRunner = gitRunnerFor(process.env.GRAPHYARD_REPOSITORY_ROOT ?? process.cwd());
  demand(engine.gitRunner, 'The control plane has no checkout to read a resubmitted head from; a head submission needs the merge writer checkout', 503);
  return observeLocalHead(engine.gitRunner, { head: data.head, base: engine.baseBranch, branch: workspace.branch, author: record.owner });
}
