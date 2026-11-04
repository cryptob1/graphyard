import { defineRoutes, parseJson } from '../routes.js';

export const actionRoutes = defineRoutes('actions', [
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
