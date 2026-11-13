import { admin, demand } from '../../model.js';
import { loopOwnedRefusal, ownerHoldRefusal } from '../../model/loop-owned.js';
import type { Ctx } from './types.js';
import { adoptFollowUpWindow } from './shared.js';

export function screen({ work, actor }: Ctx) {
  demand(work.criteria.length > 0, 'Waiting on the master: writing the criteria', 409);
  // GY-1760: an item only the master side can satisfy — the loop's own measurement, or a
  // master-role session's observation of the master checkout — is never released to a worker, whoever asks.
  // GY-2605: nor is an owner-held item, unless the owner's own human admin session asks or the owner answered on the item (GY-2606).
  const owned = loopOwnedRefusal(work) ?? ownerHoldRefusal(work, actor);
  demand(!owned, owned!, 409);
}

export function operator({ work, data }: Ctx) {
  demand(data.expectedRevision === work.revision, 'Task revision changed; reload before mutating');
  demand(work.stage === 'backlog' && !work.ready, 'Only unreleased backlog work can be released');
}

export async function run({ db, actor, work, data }: Ctx) {
  if (actor.role !== 'operator-agent') admin(actor);
  work.ready = true; work.hold = undefined;
  work.releasedBy = data.by ?? actor.id; work.releaseReason = data.reason ?? `Released by ${work.releasedBy}`;
  await adoptFollowUpWindow(db, work);
}
