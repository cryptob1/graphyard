import { admin, demand } from '../../model.js';
import type { Ctx } from './types.js';

/**
 * GY-3298: hold a released item out of dispatch. History, candidate, workspaces and a live lease
 * all stay: a running worker is not stopped, it is just not succeeded. `ready` releases it.
 */
export function operator({ work, data }: Ctx) {
  if (data.expectedRevision !== undefined) demand(data.expectedRevision === work.revision, 'Task revision changed; reload before mutating');
}

export function run({ actor, work, data }: Ctx) {
  if (actor.role !== 'operator-agent') admin(actor);
  demand(work.ready, 'Only released work can be held; an unreleased item is already out of dispatch', 409);
  demand(!work.hold, `${work.key} is already held: ${work.holdReason}`, 409);
  work.hold = true; work.holdReason = data.reason; work.heldBy = actor.id;
}
