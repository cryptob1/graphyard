import { demand } from '../../model.js';
import { idleActionable, queueSnapshot, type ActionRow } from '../../model/actions.js';
import { mechanicalActionKinds, nextActionKinds } from '../../model/next-action.js';
import { openAgentRequests } from '../../model/agent-requests.js';
import { runningSessions } from '../../model/sessions.js';
import type { Work } from '../../model.js';
import { defineRoutes, parseJson } from '../routes.js';

/**
 * The action rows, read only: what each item needs next (model/next-action.ts) and the durable row
 * per outstanding action (model/actions.ts), which the board and master status show. Nothing claims
 * them; the loop's own steps do the work.
 *
 * `POST /api/assignments/claim` is how a free worker session asks for its next assignment.
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
        requests: work.flatMap(item => openAgentRequests(item, now).map(request => ({ ...request, key: item.key, work: item.id }))),
        sessions: runningSessions(work, now),
      };
    },
  },
  {
    // A fresh provider reading and a reconciliation pass for one item, which the loop's reclaim step
    // sends for a lapsed lease. It carries no verdict of its own — see Engine.resyncWork. The body
    // may name an instant (`since`), and the answer says whether an observation newer than it has
    // been saved; `wake: false` only reads (GY-607).
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
