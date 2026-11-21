import { activeLease, demand } from '../../model.js';
import { endAttempt } from '../../pipeline-speed.js';
import type { Ctx } from './types.js';

/**
 * GY-3537: complete's verification still waited for a slot when the request's time ran out. The
 * head is recorded as finished and queued, the attempt ends with no blocker, and the loop submits
 * the head (the finished-head resubmit of GY-3335); its merge trial runs the tests (GY-3576).
 */
export function run(c: Ctx) {
  const { actor, data, now, work } = c;
  activeLease(work, actor, data.epoch, now);
  const workspace = work.workspaces.find(entry => entry.epoch === data.epoch);
  demand(workspace, 'Register the assignment workspace first');
  work.finishedBlockerHead = { head: data.head, epoch: data.epoch, branch: workspace!.branch, owner: actor.id, at: now.toISOString(), reason: 'queued for verification' };
  endAttempt(work, data.epoch, 'released', now);
  work.lease = null;
}
