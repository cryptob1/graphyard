import { activeLease } from '../../model.js';
import { endAttempt } from '../../pipeline-speed.js';
import type { Ctx } from './types.js';
import { observationHold } from './shared.js';

export function run(c: Ctx) {
  const { actor, data, now, work } = c;
  activeLease(work, actor, data.epoch, now);
  // GY-1726: a reading that cannot exist yet is a wait the product holds, not an escalation
  // (GY-1689, GY-1721, GY-1724 each blocked for one). Only a post-deploy follow-up owes such a
  // reading; anything else blocks as before. A later recorded window is never shortened.
  observationHold(work, data.notBefore, now, 'worker-reading', `${actor.id} found the reading cannot exist before then: ${data.reason}`);
  endAttempt(work, data.epoch, 'released', now);
  work.lease = null;
}
