import { record } from '../../store/mutations.js';
import { admin, releaseLeadHold, demand } from '../../model.js';
import { recordRework } from '../../pipeline-speed.js';
import type { Ctx } from './types.js';
import { preserveAssignment } from '../leases.js';

export async function run(c: Ctx) {
  const { db, actor, data, now, work } = c;
  if (actor.role !== 'operator-agent') admin(actor);
  demand(!work.observation?.merged, 'Merged work requires a follow-up task');
  work.reworkRequested = true;
  // The round's brief: the next worker's request carries this reason (master/rework-brief.ts).
  work.lastRework = { reason: data.reason, binding: data.binding ?? null, at: now.toISOString() };
  // Reassignment discards whatever assignment still stood: its end is recorded here, the
  // last moment it is visible, and the item is claimable again.
  preserveAssignment(work);
  if (work.lease) await record(db, work, 'graphyard', 'lease.expired', { details: { owner: work.lease.owner, epoch: work.lease.epoch, expiresAt: work.lease.expiresAt, submission: work.submission, cause: 'rework', at: now.toISOString() } });
  recordRework(work, now);
  work.lease = null;
  // Reopening implementation is the authorized recovery for send-back.
  // A plan rejection remains owned by its originating lead and can only
  // be superseded by that lead's later approve-plan ruling.
  if (work.leadHold?.action === 'send-back') releaseLeadHold(work);
}
