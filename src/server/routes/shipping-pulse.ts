import { shippingPulse } from '../../shipping-pulse.js';
import { defineRoutes, parseJson } from '../routes.js';

/** Provider deployment observations and the repository shipping pulse derived from them. */
export const shippingPulseRoutes = defineRoutes('shipping-pulse', [
  { method: 'POST', path: '/api/production-observations', handle: async context => context.services.productionDelivery.observe(context.actor, await parseJson(context), context.idempotencyKey()) },
  { method: 'GET', path: '/api/shipping-pulse', handle: ({ services }) => shippingPulse(services.engine.store.pool) },
]);
