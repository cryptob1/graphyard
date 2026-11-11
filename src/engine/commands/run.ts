import { decisionWork } from '../../store/decision-read.js';
import { once } from '../../store/mutations.js';
import { save, wakeJob } from '../../store.js';
import { leaseCommands } from '../../store/pools.js';
import { compactHeartbeatReceipt } from '../../store/receipts.js';
import { lockedWork } from '../../store/locked-read.js';
import { demand, type Observation, type Principal, type Work } from '../../model.js';
import { demandWork } from '../../model/refusal.js';
import { leadMay } from '../../delegation.js';
import { settleDelivered } from '../../model-boundary/actions.js';
import type { Engine } from '../../engine.js';
import { recordDispatch } from '../evaluate.js';
import { preserveAssignment, renewalGrace } from '../leases.js';
import { commands, type Command } from './schemas.js';
import { table } from './index.js';
import { renewHeartbeat } from './heartbeat.js';
import { authorizeOperatorCommand } from './shared.js';
import type { Ctx } from './types.js';

/** The commands whose work only a gate observes later: a submitted item is woken after any other. */
const noWake = new Set<Command>(['heartbeat', 'release', 'claim', 'workspace', 'priority']);

/**
 * Run one command: validate it, prepare what must happen outside the transaction, then in one
 * transaction authorize the caller, apply the command's entry in the table, evaluate the item and
 * save it under the command's receipt.
 */
export async function runCommand(engine: Engine, actor: Principal, command: Command, id: string | null, input: unknown, key: string, context: { observation?: Observation } = {}) {
  demand(Object.hasOwn(commands, command), 'Unknown command', 404);
  // Leads coordinate through rulings; no lifecycle command is lead-permitted.
  demand(actor.role !== 'slice-lead' || leadMay(command), 'Slice leads cannot perform lifecycle mutations', 403);
  demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
  const data: any = commands[command].parse(input);
  const receiptInput = { command, id, data };
  const entry = table[command];
  if (command === 'heartbeat' && actor.role !== 'operator-agent') return renewHeartbeat(engine, actor, id, key, data, receiptInput);
  // Provider I/O stays outside the coordination transaction.
  const observation = (await entry.prepare?.({ engine, actor, id, key, data, context })) ?? null;
  // The transaction reruns this closure on a stale write: each run authorizes the principal as the
  // caller presented it, never the one an earlier run already resolved (GY-1276).
  const caller = actor;
  return engine.store.transaction(async (db, now) => {
    actor = caller;
    if (actor.role === 'operator-agent') {
      demand(engine.operatorAuthorizer, 'Operator-agent authorization is unavailable', 503);
      actor = await engine.operatorAuthorizer(db, now, caller);
    }
    return once<Work>(db, actor, key, receiptInput, async () => {
      // Creation/requirement changes validate the dependency graph; workspace registration checks
      // every reservation. Those are board decisions. Lifecycle decisions read only their peers.
      const all = ['create', 'requirements', 'workspace'].includes(command)
        ? await lockedWork(db, [id])
        : await decisionWork(db, [id], command === 'submit' ? data.pr : undefined);
      const found = all.find(w => w.id === id || w.key === id);
      const before = found ? structuredClone(found) : null;
      const c = { engine, db, actor, command, id, data, all, now, observation, work: found } as Ctx;
      if (entry.open) c.work = await entry.open(c);
      demandWork(c.work);
      const work = c.work;
      entry.screen?.(c);
      // A lease past its expiry that a recorded server-side renewal fault still covers stays live (GY-558).
      // Priority edits preserve the assignment and gates; the next loop evaluates their new order.
      if (command !== 'priority') await renewalGrace(engine, db, work, now);
      if (actor.role === 'operator-agent') {
        authorizeOperatorCommand(actor, command, c.data, work, engine.repository);
        entry.operator?.(c);
      }
      // A delivered item accepts only what its command names (the post-deployment smoke fact, ending a session handle).
      const delivered = entry.delivered?.(c) ?? false;
      if (command !== 'priority') preserveAssignment(work);
      demand(delivered || work.stage !== 'done', 'Delivered work is immutable; create a follow-up task');
      await entry.run?.(c);
      // Delivery is an immutable snapshot. A post-deployment fact may append its audit/revision
      // metadata, but stale inputs must not re-evaluate it.
      if (!delivered && command !== 'priority') engine.evaluate(work, all, now);
      // A delivered item's gates are an immutable snapshot; its queue is settled without re-evaluating the delivery.
      else if (delivered) settleDelivered(work, all, now);
      await recordDispatch(db, work, now);
      await save(db, work, actor.id, command, now, actor.role === 'operator-agent' && command !== 'priority' ? { before, intent: c.data, reason: c.data.reason ?? null } : c.data);
      if (work.submission && !delivered && !noWake.has(command)) await wakeJob(db, work.id);
      return work;
    }, {
      store: work => command === 'heartbeat' ? compactHeartbeatReceipt(work) : work,
      replay: async work => { if (actor.role === 'operator-agent') authorizeOperatorCommand(actor, command, data, work, engine.repository); },
    });
  // Lease commands take the lease pool (GY-274, GY-558): however busy every other pool is, a live
  // worker is never stopped because its renewal, claim, completion or blocker could not reach the database.
  }, { lane: leaseCommands.has(command) ? 'lease' : 'request', itemLock: id ?? undefined });
}
