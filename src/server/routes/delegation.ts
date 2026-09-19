import { delegationSnapshot, recordIntake, recordLeadRuling } from '../../delegation.js';
import { defineRoutes, parseJson } from '../routes.js';

/**
 * Slice-lead delegation. Delegation is a read over work items, so it is filtered by the
 * same scope rule as every other read; a scoped agent never sees out-of-scope owners,
 * workers, or bottlenecks here or inside /api/status.
 */
export const delegationRoutes = defineRoutes('delegation', [
  { method: 'GET', path: '/api/delegation', handle: async ({ services, operatorVisible }) => delegationSnapshot(services.principals.map(p => p.actor), operatorVisible(await services.engine.store.list()), Date.now(), services.limits) },
  { method: 'POST', path: '/api/intake', handle: async context => recordIntake(context.services.engine.store, context.actor, await parseJson(context), context.idempotencyKey()) },
  { method: 'POST', path: /^\/api\/work\/([^/]+)\/lead-ruling$/, handle: async (context, [id]) => recordLeadRuling(context.services.engine.store, context.actor, id, await parseJson(context), context.idempotencyKey()) },
]);
