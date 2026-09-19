import { demand, type Principal } from '../../model.js';
import type { Command } from '../../engine.js';
import { producerIndependenceRefusal, recordEvidenceRefusal, recordLeadViolation } from '../../delegation.js';
import { defineRoutes, parseJson, type RouteContext } from '../routes.js';

// Every mutating work route refuses a slice lead the same way and leaves the same
// ledger entry. Routing order decides which handler matches first; it must never
// decide whether the attempt is recorded.
const refuseLead = async ({ actor, services }: RouteContext, id: string | null, attemptedAction: string) => {
  if (actor.role !== 'slice-lead') return;
  await recordLeadViolation(services.engine.store, actor, id, attemptedAction);
  demand(false, 'Slice leads cannot perform lifecycle mutations', 403);
};

/** Work mutations: the guarded merge broker and every engine command. */
export const workRoutes = defineRoutes('work', [
  {
    method: 'POST', path: /^\/api\/work\/([^/]+)\/merge-(acquire|cancel|verify|commit)$/,
    async handle(context, [id, action]) {
      const { actor, services: { engine, github } } = context;
      // These routes sit above the generic work route, so their own refusal
      // is recorded here rather than inherited from a handler never reached.
      await refuseLead(context, id, `merge-${action}`);
      const data = await parseJson(context, undefined, '{}'), key = context.idempotencyKey();
      if (action === 'acquire') return engine.acquireMerge(actor, id, data, key);
      if (action === 'cancel') return engine.cancelMerge(actor, id, data, key);
      if (action === 'commit') return engine.commitMerge(actor, id, data, key);
      demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
      demand(github, 'GitHub integration is required for merge verification', 503);
      const work = (await engine.store.list()).find(item => item.id === id || item.key === id); demand(work?.submission, 'Submitted work item required', 404);
      const replay = await engine.replayMergeVerification(actor, work.id, data, key); if (replay) return replay;
      const observation = await github.verify(work);
      const before = (await engine.store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
      const providerTime = await github.serverTime();
      const after = (await engine.store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
      // Bound DB minus GitHub time using the request interval and GitHub's
      // whole-second Date precision. Keep all network I/O outside transactions.
      observation.clockOffset = { min: before.getTime() - providerTime - 1000, max: after.getTime() - providerTime };
      return engine.verifyMerge(actor, work.id, data, observation, key);
    },
  },
  {
    method: 'POST', path: /^\/api\/work(?:\/([^/]+)\/([a-z]+))?$/,
    async handle(context, [id, command]) {
      const { actor, services: { engine } } = context;
      const attempted = command ?? 'create';
      // Creating work names no existing item, so the refusal is recorded
      // unscoped rather than dropped for want of a ledger to append to.
      await refuseLead(context, id ?? null, attempted);
      const raw = await context.body();
      if (attempted === 'evidence' && id && actor.role !== 'worker') {
        const item = (await engine.store.list()).find(w => w.id === id || w.key === id);
        const dependent = item ? producerIndependenceRefusal(actor as Principal, item, engine.principals) : null;
        if (item && dependent) {
          // An unparsable body is still a recorded refusal; the engine repeats this decision.
          let proof: unknown = null;
          try { proof = JSON.parse(raw.toString() || '{}')?.proof; } catch { proof = null; }
          await recordEvidenceRefusal(engine.store, actor, item.id, proof, dependent);
          demand(false, dependent, 403);
        }
      }
      return engine.execute(actor, attempted as Command, id ?? null, JSON.parse(raw.toString() || '{}'), context.idempotencyKey());
    },
  },
]);
