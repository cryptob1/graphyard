import { defineRoutes, parseJson } from '../routes.js';

/** Scoped operator automation identities: listing, setup, and credential lifecycle. */
export const operatorAgentRoutes = defineRoutes('operator-agents', [
  { method: 'GET', path: '/api/operator-agents', handle: ({ actor, services }) => services.operatorAgents.list(actor) },
  { method: 'POST', path: '/api/operator-agents', handle: async context => context.services.operatorAgents.setup(context.actor, await parseJson(context), context.idempotencyKey()) },
  {
    method: 'POST', path: /^\/api\/operator-agents\/([^/]+)\/(configure|rotate|revoke)$/,
    async handle(context, [id, action]) {
      const { actor, services: { operatorAgents } } = context;
      const data = await parseJson(context), key = context.idempotencyKey();
      return action === 'configure' ? operatorAgents.configure(actor, id, data, key)
        : action === 'rotate' ? operatorAgents.rotate(actor, id, data, key) : operatorAgents.revoke(actor, id, data, key);
    },
  },
]);
