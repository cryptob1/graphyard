import { record } from '../../store/mutations.js';
import { activeLease, demand } from '../../model.js';
import { allocateChangeNumber } from '../../merge-writer/change-numbers.js';
import { observeHead } from '../../model/attempt-bound.js';
import { observeBaseHold } from '../../model/behind-base.js';
import { recordSubmission } from '../../pipeline-speed.js';
import type { Ctx, Prepare } from './types.js';
import { observeSubmittedHead } from '../observe.js';

export async function run(c: Ctx) {
  const { db, actor, data, all, now, observation, work } = c;
  activeLease(work, actor, data.epoch, now);
  // GY-3266: a requirements revision recorded under this lease is refused here until the worker
  // has synced it, so the submission is judged against criteria the worker has seen. The refusal
  // names the revision; `sync GY-N` acknowledges it and complete again.
  const unsynced = work.unsyncedRevision;
  demand(!unsynced, `Requirements were revised under this attempt (policy revision ${unsynced?.policyRevision}) and not synced yet: run sync ${work.key} to pick up the changed criteria, then complete again`);
  const workspace = work.workspaces.find(w => w.epoch === data.epoch);
  demand(workspace, 'Register the assignment workspace first');
  // GY-1523: the control plane is the only merge writer, so a submission is a head it observed
  // (`complete --head`). The HTTP route refuses a bare number (GY-2999); it is a test seam here,
  // standing for a head without a git checkout.
  let observed = observation, number: number;
  if (data.head !== undefined) {
    demand(observation?.source === 'control-plane' && observation.candidate.sha === data.head, `${data.head.slice(0, 12)} was not observed by the control plane; complete ${work.key} ${data.epoch} --head again`, 409);
    // One change number per (item, head), allocated under the item lock this transaction holds:
    // the candidate, the submission and the number commit together, and a retried or repeated
    // submission of the same head reads the same number back.
    number = await allocateChangeNumber(db, work.id, data.head);
    observed = { ...observation!, candidate: { sha: data.head, baseSha: observation!.baseTip!, pr: number, branch: workspace!.branch, author: actor.id } };
  } else {
    number = data.pr;
    demand(!all.some(w => w.id !== work!.id && w.submission?.pr === number), 'Pull request is already linked to another task');
    demand(!work.submission || work.submission.pr === number, 'A submitted task cannot switch pull requests');
  }
  if (observed) {
    demand(observed.candidate.pr === number, 'Observed pull request does not match the submission');
    demand(work.workspaces.some(w => w.epoch === data.epoch && w.branch === observed!.candidate.branch), 'PR branch does not match the assigned workspace');
  }
  work.submission = { epoch: data.epoch, pr: number };
  // GY-2968: what complete's automatic rerun set aside when it accepted this head — the
  // failing cases outside the item's proofs that passed on their immediate retry, and those
  // the base fails too. A fact on the item's history, judged by nobody.
  if (data.flaked?.length) await record(db, work, actor.id, 'complete.flaked', { details: { epoch: data.epoch, head: data.head ?? null, cases: data.flaked, at: now.toISOString() } });
  if (data.baseFailures?.length) await record(db, work, actor.id, 'complete.base-failure', { details: { epoch: data.epoch, head: data.head ?? null, cases: data.baseFailures, at: now.toISOString() } });
  if (data.rerunUnjudged) await record(db, work, actor.id, 'complete.rerun-unjudged', { details: { epoch: data.epoch, head: data.head ?? null, note: data.rerunUnjudged.note, output: data.rerunUnjudged.output, at: now.toISOString() } });
  if (data.head !== undefined) {
    // The control plane's reading is the candidate's observation from this instant (GY-1523): the
    // minimal save `observe` makes for a provider reading, with nothing of GitHub's to carry.
    observeHead(work, observed!.candidate, observed!.at);
    work.candidate = observed!.candidate;
    work.observation = observed!;
    observeBaseHold(work, observed!.at);
  }
  work.reworkRequested = false;
  recordSubmission(work, data.epoch, now);
  // Binding the candidate ends the implementation lease in the same transaction: submitted
  // work continues through the gates without one, and a lease left to lapse afterwards
  // would otherwise read as an abandoned assignment. The workspace and `lastAssignment`
  // keep the attempt attributable, and rework still needs the stopped-worker attestation.
  work.lease = null;
}

export async function prepare({ engine, actor, id, key, data, context }: Prepare) {
  return context.observation ?? (data.head !== undefined ? await observeSubmittedHead(engine, actor, id, data, key) : null);
}
