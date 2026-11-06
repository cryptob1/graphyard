import { activeLease } from '../../model.js';
import { blockedAttemptMarker, retainedExhaustions } from '../../model/capacity.js';
import type { ExhaustionRecord } from '../../model/capacity.js';
import { credentialBlockedReason, credentialFailure } from '../../worker-credential.js';
import { endAttempt, recordIntervention } from '../../pipeline-speed.js';
import type { Ctx } from './types.js';

export function run(c: Ctx) {
  const { actor, data, now, work } = c;
  activeLease(work, actor, data.epoch, now);
  work.blocker = data.reason;
  if (data.reason) {
    recordIntervention(work, 'blocked');
    // GY-1008: recording a blocker ends the attempt in this same transaction, so a blocked
    // item holds no worker slot while the loop re-checks its cause. The work it had is kept
    // (committed on its branch, and what it had not committed as the CLI's WIP commit), and
    // the next attempt's request names that commit, as for any interrupted attempt.
    const partialWork = data.partialWork ?? { state: 'not-applicable' as const, detail: 'the blocked attempt reported no partial work; its commits stay on its branch' };
    const record: ExhaustionRecord = { role: 'worker', cause: 'interrupted', epoch: data.epoch, profile: actor.id.slice(0, 80), account: null, runtime: actor.runtime?.slice(0, 40) ?? null,
      // A GitHub credential failure's end carries GY-999's marker, so it counts on the retry
      // ladder: a failure no freshly minted credential cures is relaunched after a backoff
      // and held at the cap for the master, never ended and relaunched for ever.
      reason: (credentialFailure(data.reason) ? credentialBlockedReason(work, data.epoch, data.reason) : `${blockedAttemptMarker}${data.epoch}: ${data.reason}`).slice(0, 500),
      resetsAt: null, partialWork, at: now.toISOString(), owner: actor.id, recordedBy: actor.id };
    const capacity = work.capacity ?? { exhaustions: [], spent: [] };
    work.capacity = { ...capacity, exhaustions: [...capacity.exhaustions, record].slice(-retainedExhaustions) };
    endAttempt(work, data.epoch, 'released', now);
    work.lease = null;
  }
}
