import { demand } from '../../model.js';
import type { Ctx } from './types.js';
import { observationHold } from './shared.js';

export function run(c: Ctx) {
  const { actor, data, now, work } = c;
  // GY-1740: a post-deploy follow-up blocked for a reading that cannot exist yet (GY-1689, GY-1721,
  // GY-1724) is moved to its wait without a worker launch spent only to call `defer`.
  if (actor.role !== 'operator-agent') demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
  // Every writer names the revision it read: a hold derived from a blocker since cleared or changed is refused.
  demand(data.expectedRevision === work.revision, 'Task revision changed; reload before mutating');
  demand(!work.lease || Date.parse(work.lease.expiresAt) <= now.getTime(), `${work.key} is held by ${work.lease?.owner} under epoch ${work.lease?.epoch}; its worker defers it with defer GY-N EPOCH NOT-BEFORE REASON`, 409);
  observationHold(work, data.notBefore, now, 'operator-hold', `${actor.id} held it until then: ${data.reason}`);
  work.blocker = null;
  work.blockedAt = null;
}
