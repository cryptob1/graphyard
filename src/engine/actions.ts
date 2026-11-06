import { readReceipt } from '../store/mutations.js';
import { createHash } from 'node:crypto';
import { wakeJob } from '../store.js';
import { demand } from '../model.js';
import type { Principal, Work } from '../model.js';
import { Refusal } from '../model/refusal.js';
import type { ObservationJobState } from '../model/action-kinds.js';
import { openActions } from '../model/actions.js';
import type { Engine } from '../engine.js';
import { idempotencyMismatch, pullAssignmentSchema, resyncSchema } from './commands/schemas.js';

/**
 * The pull model: a free worker session asks for its next assignment instead of waiting for a
 * dispatcher to inject one.
 *
 * The control plane already names which items need a worker (`nextAction` kind `dispatch`,
 * target `implementation`), in the order the dispatcher would have offered them. The worker
 * claims under its own identity through the ordinary claim command, so every claim rule — ready,
 * dependencies, quarantine, exclusive resources, engineer limits — still decides. An item that
 * refuses is skipped rather than returned as an error, so one worker racing another for the head
 * of the queue simply takes the next item instead of going back to sleep.
 */
export async function pullAssignment(engine: Engine, actor: Principal, input: unknown, key: string) {
  demand(actor.role === 'worker' || actor.role === 'admin', 'Worker permission required', 403);
  demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
  const data = pullAssignmentSchema.parse(input);
  // Every offer this pull tries claims under one key derived from the pull's own, so the claim
  // receipt records which item this pull took — and, because a receipt is written in the same
  // transaction as the claim it belongs to, one pull key can never claim two items. A pull that
  // timed out after its claim committed replays that receipt instead of walking the offers
  // again; without it the retry would take a second item and leave the first held by a worker
  // that was never told it holds it. The race is decided the same way: a concurrent retry that
  // reaches a different offer first is refused for reusing the key with different input, and
  // replays the assignment the winner made rather than claiming beside it.
  const derived = `pull/${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
  const replay = async () => (await readReceipt(engine.store.pool, actor, derived))?.result as Work | undefined;
  const prior = await replay();
  if (prior) return { assigned: prior, offered: 1, refused: [] as { key: string; reason: string }[], replayed: true };
  // Open items whole, settled deliveries as the work index's summary (GY-1376): no settled item has a dispatch to offer.
  const all = await engine.store.fleet();
  const now = new Date((await engine.store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now);
  const offers = openActions(all, now, ['dispatch'])
    .filter(entry => entry.row.inputs.kind === 'dispatch' && entry.row.inputs.target === 'implementation')
    .filter(entry => !data.work || entry.work.id === data.work || entry.work.key === data.work);
  const refused: { key: string; reason: string }[] = [];
  for (const offer of offers) {
    try { return { assigned: await engine.execute(actor, 'claim', offer.work.id, {}, derived), offered: offers.length, refused }; }
    catch (error) {
      if (!(error instanceof Refusal)) throw error;
      if (error.message === idempotencyMismatch) {
        // This pull already claimed a different item — a concurrent retry of the same call got
        // there first. The claim it made is this pull's assignment; taking another is exactly
        // the double claim the key exists to prevent.
        const claimed = await replay();
        if (claimed) return { assigned: claimed, offered: offers.length, refused, replayed: true };
      }
      refused.push({ key: offer.work.key, reason: error.message });
    }
  }
  return { assigned: null, offered: offers.length, refused, at: now.toISOString() };
}

/**
 * Re-read an item: wake the durable provider observation for it and reconcile the graph.
 *
 * This is what the `resync` and `reclaim` actions run. Both say the record is behind the world
 * — a pull request nobody has observed since the base moved, a lease that expired with nobody
 * holding the item — and both are answered the same mechanical way: ask the control plane to
 * look again. It decides nothing itself; it schedules the observation the server already knows
 * how to make and runs the reconciliation that clears a lapsed lease, then returns the item as
 * it now stands, so the executor reports what its attempt actually achieved.
 *
 * A re-read that saves nothing satisfies no `resync` (GY-607): the executor passes `since`, the
 * instant its claim was made, and the answer says whether an observation newer than that has been
 * saved (`observed`) and what the item's observation job is doing (`job`), which is what the
 * executor waits on — reading again with `wake: false` — and what it names when none arrives.
 */
export async function resyncWork(engine: Engine, actor: Principal, id: string, input: unknown = {}) {
  demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
  const data = resyncSchema.parse(input ?? {});
  const before = await engine.store.workDocument(id);
  demand(before, `Unknown work item ${id}`, 404);
  const wake = data.wake !== false;
  // The observation job only exists for an item with a candidate to observe; waking it for one
  // without a submission would schedule a read of nothing.
  // `prioritized` claims the job ahead of the polled backlog, as a webhook wake is (GY-1099).
  // A control-plane candidate is observed here; any other (a pull request GitHub observed) wakes its job, which reads it from the checkout.
  if (wake && before!.observation?.source === 'control-plane' && before!.submission && before!.candidate) {
    try {
      const observation = await engine.observeControlPlaneCandidate(before!);
      if (observation) {
        await engine.observe(before!.id, before!.revision, observation);
      }
    } catch (error) {
      console.warn(`control-plane observation during resync of ${before!.key} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (wake && before!.submission) {
    await engine.store.transaction(async db => { await wakeJob(db, before!.id, data.prioritized === true); });
  }
  // A resync waits for the running tick and then the trailing one that serves it (GY-1115), at most two
  // bounded ticks; reconciling only its own item instead would run a second writer against the tick's
  // batches, the contention GY-1115 removed (GY-1212). A failed tick is a server fault, not this item's:
  // every resync waiting on it would share the rejection, so the resync logs it and answers with the
  // item as it stands, whose `changed`, `observed` and `job` say what the attempt achieved (GY-1212).
  // `wait: false` is a wake alone (GY-1286): the master loop reads the observation it woke on its
  // next cycle, so it waits on no tick; waiting held its decisions step up to the request's 30s
  // timeout per wake, one wake after another.
  if (wake && data.wait !== false) await engine.reconcile().catch(error => { console.warn(`reconciliation tick failed during the resync of ${before!.key}: ${error instanceof Error ? error.message : String(error)}`); });
  const work = (await engine.store.workItem(before!.id))!;
  // Without `since`, the claim of the item's own `resync` row is the instant a reading must beat.
  const since = data.since ?? work.actionQueue?.actions.find(row => row.kind === 'resync' && row.state === 'claimed')?.claim?.claimedAt ?? null;
  const observedAt = work.observation?.at ?? null;
  const observed = !!since && !!observedAt && Date.parse(observedAt) > Date.parse(since);
  return { work, observationScheduled: wake && !!before!.submission, revision: work.revision, changed: work.revision !== before!.revision,
    since, observedAt, observed, job: await observationJob(engine, work.id) };
}

/** The item's durable observation job as the queue holds it, or null when it has none. */
export async function observationJob(engine: Engine, id: string): Promise<ObservationJobState | null> {
  const row = (await engine.store.pool.query('SELECT available_at, locked_until, attempts, error FROM jobs WHERE work_id=$1', [id])).rows[0];
  if (!row) return null;
  const iso = (value: Date | null) => value ? new Date(value).toISOString() : null;
  return { availableAt: iso(row.available_at), lockedUntil: iso(row.locked_until), attempts: Number(row.attempts), error: row.error ?? null };
}
