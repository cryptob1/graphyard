import { demand } from '../../model.js';
import { idleActionable, queueSnapshot, type ActionRow } from '../../model/actions.js';
import { executorRegistry, executorReport } from '../../model/executor-presence.js';
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
      const work: Work[] = operatorVisible(await services.engine.store.list());
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
        // an action nobody can run, reported apart from one waiting its turn.
        executors: executorReport(work, executorRegistry(services.engine), now),
        requests: work.flatMap(item => openAgentRequests(item, now).map(request => ({ ...request, key: item.key, work: item.id }))),
        sessions: runningSessions(work, now),
      };
    },
  },
  {
    method: 'POST', path: '/api/actions/claim',
    async handle(context) {
      const body = await parseJson(context, undefined, '{}') as { executor?: string; host?: string; kinds?: string[] };
      const result = await context.services.engine.claimNextAction(context.actor, body, context.idempotencyKey()) as { action: ActionRow | null; at?: string };
      // The poll itself is the presence signal, whether or not it claimed: the engine validated
      // the body, so what is recorded here is exactly what an executor can run.
      executorRegistry(context.services.engine).observe({ executor: body.executor ?? context.actor.id, host: body.host!, principal: context.actor.id, kinds: (body.kinds ?? nextActionKinds) as typeof nextActionKinds[number][] }, new Date(result.at ?? Date.now()), !!result.action);
      return result;
    },
  },
  {
    // An executor still inside a handler holds its claim by saying so; see Engine.renewClaimedAction.
    method: 'POST', path: /^\/api\/actions\/([0-9a-f]{32})\/renew$/,
    async handle(context, [id]) {
      return context.services.engine.renewClaimedAction(context.actor, id, await parseJson(context, undefined, '{}'));
    },
  },
  {
    method: 'POST', path: /^\/api\/actions\/([0-9a-f]{32})\/settle$/,
    async handle(context, [id]) {
      return context.services.engine.settleClaimedAction(context.actor, id, await parseJson(context, undefined, '{}'), context.idempotencyKey());
    },
  },
  {
    // What the `resync` and `reclaim` actions run: a fresh provider reading and a reconciliation
    // pass for one item. It carries no verdict of its own — see Engine.resyncWork.
    method: 'POST', path: /^\/api\/work\/([^/]+)\/resync$/,
    handle: (context, [id]) => context.services.engine.resyncWork(context.actor, decodeURIComponent(id)),
  },
  {
    method: 'POST', path: '/api/assignments/claim',
    async handle(context) {
      return context.services.engine.pullAssignment(context.actor, await parseJson(context, undefined, '{}'), context.idempotencyKey());
    },
  },
]);
