import { admin, demand } from '../../model.js';
import type { Ctx } from './types.js';
import { adoptFollowUpWindow } from './shared.js';

export function operator({ work, data }: Ctx) {
  demand(data.expectedRevision === work.revision, 'Task revision changed; reload before mutating');
  demand(work.blocker, 'Task has no blocker to clear');
}

export async function run({ db, actor, work }: Ctx) {
  if (actor.role !== 'operator-agent') admin(actor);
  work.blocker = null;
  await adoptFollowUpWindow(db, work);
}
