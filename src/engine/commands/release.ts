import { record } from '../../store/mutations.js';
import { wakeJob } from '../../store.js';
import { activeLease } from '../../model.js';
import { submittedBranchMoved } from '../../model/assignment.js';
import { endAttempt, pipelineTimeline } from '../../pipeline-speed.js';
import type { Ctx } from './types.js';
import { endedBySubmission } from '../leases.js';

export async function run(c: Ctx) {
  const { engine, db, actor, data, now, work } = c;
  endedBySubmission(work, data.epoch);
  activeLease(work, actor, data.epoch, now);
  // GY-860 AC-2: a release carrying a workspace failure keeps the git message on the item and,
  // while the attempt is still the untouched claim it released, undoes it: the timeline entry
  // and the reservation go, the epoch returns, and the next dispatch claims it afresh. An
  // attempt that already did work is only ended — its release is an ordinary attempt end.
  // Untouched means nothing but the worktree command ever held this epoch: the lease was never
  // renewed, no session was launched under it and nothing was submitted, so no delayed
  // command from another holder can reach the epoch number when it is claimed again.
  const timeline = pipelineTimeline(work);
  const open = data.failure ? timeline.attempts.find(entry => entry.epoch === data.epoch && entry.endedAt === null) : undefined;
  const untouched = open && work.lease && Date.parse(work.lease.expiresAt) === Date.parse(open.claimedAt) + engine.leaseSeconds * 1000
    && work.submission?.epoch !== data.epoch ? open : undefined;
  if (data.failure) await record(db, work, actor.id, 'workspace.failed', { details: { epoch: data.epoch, message: data.failure.message, at: now.toISOString() } });
  // GY-1286: a rework workspace refused because the PR branch moved past the observed head can
  // only be built once that head is observed, so the release wakes the observation, prioritized.
  if (data.failure?.message.startsWith(submittedBranchMoved) && work.submission) await wakeJob(db, work.id, true);
  if (untouched && work.epoch === data.epoch) {
    timeline.attempts.splice(timeline.attempts.indexOf(untouched), 1);
    work.workspaces = work.workspaces.filter(w => w.epoch !== data.epoch);
    work.epoch = data.epoch - 1;
  } else endAttempt(work, data.epoch, 'released', now, data.cause);
  work.lease = null;
}
