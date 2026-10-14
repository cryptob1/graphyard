import { demand } from '../../model.js';
import { executorPresenceSchema } from '../../engine.js';
import { idleActionable, queueSnapshot, type ActionRow } from '../../model/actions.js';
import { durablePresence, executorRegistry, executorReport, loopRegistry, presenceQuery, recordPresence, reportedLoopMerger } from '../../model/executor-presence.js';
import { mechanicalActionKinds, nextActionKinds } from '../../model/next-action.js';
import { openAgentRequests } from '../../model/agent-requests.js';
import { runningSessions } from '../../model/sessions.js';
import type { Work } from '../../model.js';
import { defineRoutes, parseJson } from '../routes.js';

/**
 * The executor API.
 *
 * Coordination is inverted: the control plane computes what each item needs (model/next-action.ts)
 * and keeps a durable row per outstanding action (model/actions.ts); these routes are how any
 * number of stateless executors read that queue, take one row at a time under a bounded lease,
 * and report what their attempt did. An executor holds no state between calls, knows nothing
 * about other executors, and needs no master session to tell it what to do.
 *
 * `POST /api/assignments/claim` is the same inversion for workers: a free session asks for its
 * next assignment rather than waiting to be dispatched into.
 */
export const actionRoutes = defineRoutes('actions', [
  {
    method: 'GET', path: '/api/actions',
    async handle({ url, services, operatorVisible }) {
      const work: Work[] = operatorVisible(await services.engine.store.fleet());
      const now = new Date((await services.engine.store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now);
      const kind = url.searchParams.get('kind');
      if (kind) demand((nextActionKinds as readonly string[]).includes(kind), `Unknown action kind ${kind}`, 400);
      const rows: (ActionRow & { work: string })[] = work.flatMap(item => (item.actionQueue?.actions ?? []).filter(row => !kind || row.kind === kind));
      return {
        now: now.toISOString(), kinds: nextActionKinds, mechanical: mechanicalActionKinds,
        queue: queueSnapshot(work, now), actions: rows,
        // What each open item needs next, whether or not a row has been claimed for it yet.
        nextActions: work.filter(item => item.nextAction).map(item => item.nextAction),
        idle: idleActionable(work, now),
        // Who is alive to claim, and every pending row whose kind none of them serves (GY-105):
        // an action nobody can run, reported apart from one waiting its turn. Presence any process
        // recorded durably counts, so a replaced control plane reads the fleet live (GY-1289).
        executors: executorReport(work, executorRegistry(services.engine), now, undefined, await reportedLoopMerger(loopRegistry(services.engine), (text, values) => services.engine.store.pool.query(text, values), now), await durablePresence(presenceQuery(services.engine))),
        requests: work.flatMap(item => openAgentRequests(item, now).map(request => ({ ...request, key: item.key, work: item.id }))),
        sessions: runningSessions(work, now),
      };
    },
  },
  {
    method: 'POST', path: '/api/actions/claim',
    async handle(context) {
      const body = await parseJson(context, undefined, '{}') as { executor?: string; host?: string; kinds?: string[]; serves?: string[] };
      const result = await context.services.engine.claimNextAction(context.actor, body, context.idempotencyKey()) as { action: ActionRow | null; at?: string };
      // The poll itself is the presence signal, whether or not it claimed: the engine validated
      // the body, so what is recorded here is exactly what an executor can run. It is recorded in
      // memory and as the executor's one durable presence row — never an event row (GY-1289).
      const poll = { executor: body.executor ?? context.actor.id, host: body.host!, principal: context.actor.id, kinds: (body.serves ?? body.kinds ?? nextActionKinds) as typeof nextActionKinds[number][] };
      const at = new Date(result.at ?? Date.now());
      executorRegistry(context.services.engine).observe(poll, at, !!result.action);
      await recordPresence(presenceQuery(context.services.engine), poll, at, { claimed: !!result.action });
      return result;
    },
  },
  {
    // A poll that asks for nothing (GY-1288): an executor behind a fleet restart's fence may not
    // claim, yet it is alive and claims again the moment the fence is lowered, so it says so here.
    // It claims nothing and writes nothing; it is the presence half of a claim poll alone.
    method: 'POST', path: '/api/actions/presence',
    async handle(context) {
      demand(context.actor.role === 'coordinator' || context.actor.role === 'admin', 'Coordinator permission required', 403);
      const body = executorPresenceSchema.parse(await parseJson(context, undefined, '{}'));
      const at = new Date();
      const poll = { executor: body.executor ?? context.actor.id, host: body.host, principal: context.actor.id, kinds: body.serves ?? body.kinds ?? [...nextActionKinds] };
      executorRegistry(context.services.engine).observe(poll, at);
      await recordPresence(presenceQuery(context.services.engine), poll, at);
      return { observed: true, at: at.toISOString() };
    },
  },
  {
    // An executor still inside a handler holds its claim by saying so; see Engine.renewClaimedAction.
    // The renewal is also its presence: a long handler polls nothing until it ends (GY-1288).
    method: 'POST', path: /^\/api\/actions\/([0-9a-f]{32})\/renew$/,
    async handle(context, [id]) {
      const result = await context.services.engine.renewClaimedAction(context.actor, id, await parseJson(context, undefined, '{}'));
      const claim = result.action?.claim;
      if (claim) {
        const at = new Date();
        const presence = executorRegistry(context.services.engine).renewed({ executor: claim.executor, host: claim.host, principal: context.actor.id, kind: result.action!.kind }, at);
        // Durably too, keeping the kinds the executor last polled with wherever that poll landed.
        await recordPresence(presenceQuery(context.services.engine), presence, at, { renewal: true });
      }
      return result;
    },
  },
  {
    method: 'POST', path: /^\/api\/actions\/([0-9a-f]{32})\/settle$/,
    async handle(context, [id]) {
      return context.services.engine.settleClaimedAction(context.actor, id, await parseJson(context, undefined, '{}'), context.idempotencyKey());
    },
  },
  {
    // The loop's record of the remedy a stalled row's reason binds to (GY-949); see Engine.recordActionRemedy.
    method: 'POST', path: /^\/api\/actions\/([0-9a-f]{32})\/remedy$/,
    async handle(context, [id]) {
      return context.services.engine.recordActionRemedy(context.actor, id, await parseJson(context, undefined, '{}'));
    },
  },
  {
    // What the `resync` and `reclaim` actions run: a fresh provider reading and a reconciliation
    // pass for one item. It carries no verdict of its own — see Engine.resyncWork. The body may name
    // the instant the executor's claim was made (`since`), and the answer says whether an
    // observation newer than it has been saved; `wake: false` only reads (GY-607).
    method: 'POST', path: /^\/api\/work\/([^/]+)\/resync$/,
    handle: async (context, [id]) => context.services.engine.resyncWork(context.actor, decodeURIComponent(id), await parseJson(context, undefined, '{}')),
  },
  {
    method: 'POST', path: '/api/assignments/claim',
    async handle(context) {
      return context.services.engine.pullAssignment(context.actor, await parseJson(context, undefined, '{}'), context.idempotencyKey());
    },
  },
]);
