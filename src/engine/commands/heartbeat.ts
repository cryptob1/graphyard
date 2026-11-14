import { once } from '../../store/mutations.js';
import { save } from '../../store.js';
import { compactHeartbeatReceipt } from '../../store/receipts.js';
import { demand } from '../../model.js';
import { demandWork } from '../../model/refusal.js';
import { workIdByRef } from '../../store/locked-read.js';
import type { Principal, Work } from '../../model.js';
import type { Engine } from '../../engine.js';
import { preserveAssignment, renewLease, renewalGrace } from '../leases.js';
import type { Ctx } from './types.js';

/** The renewal itself: the lease checks every heartbeat passes, written once for the item-locked fast path and the operator-agent path. */
export function run({ engine, work, actor, data, now }: Ctx) {
  renewLease(engine, work, actor, data.epoch, now);
  // GY-3266: a heartbeat naming the policy revision is the worker's sync acknowledging the
  // requirements revision queued under its lease. It must name the item's current revision — one
  // that landed after the worker read names itself, and the worker reloads and syncs again.
  if (data.syncedPolicyRevision !== undefined) {
    demand(data.syncedPolicyRevision === work.policyRevision, `Policy revision changed; the sync named ${data.syncedPolicyRevision}, ${work.key} is at ${work.policyRevision}; reload before syncing`);
    work.unsyncedRevision = null;
  }
  // GY-3298: the sync that showed the master's messages acknowledges them under this live epoch.
  for (const message of work.messages ?? []) if (!message.acknowledged && data.acknowledgedMessages?.includes(message.id)) message.acknowledged = { at: now.toISOString(), by: actor.id, epoch: data.epoch };
}

/**
 * A renewal changes one item's lease and reads nothing else of the fleet (GY-1124): it takes that
 * item's lock alone, so renewals of different items never wait for each other or for a fleet
 * command. It neither evaluates the item nor records a dispatch: both are left to the next
 * reconciliation pass, which sees the row move, so a gate change that waited on this renewal
 * lands one reconcile tick after it rather than in the renewal's own response.
 */
export function renewHeartbeat(engine: Engine, actor: Principal, id: string | null, key: string, data: { epoch: number }, receiptInput: unknown) {
  return engine.store.transaction(async (db, now) => once<Work>(db, actor, key, receiptInput, async () => {
    const work: Work | undefined = (await db.query(`SELECT document FROM work_items WHERE id = ${workIdByRef('$1')}`, [id])).rows[0]?.document;
    demandWork(work);
    // A lease past its expiry that a recorded server-side renewal fault still covers stays live (GY-558).
    await renewalGrace(engine, db, work, now);
    preserveAssignment(work);
    demand(work.stage !== 'done', 'Delivered work is immutable; create a follow-up task');
    run({ engine, db, actor, command: 'heartbeat', id, data, work, all: [], now, observation: null });
    await save(db, work, actor.id, 'heartbeat', now, data);
    // A renewal's replay needs only the lease, not a whole document per renewal.
    return work;
  }, { store: compactHeartbeatReceipt }), { lane: 'lease', fleetLock: false, itemLock: id });
}
