import { shippingPulse } from '../../shipping-pulse.js';
import { refuseCiProducer } from '../../model/ci-proofs.js';
import { defineRoutes, parseJson } from '../routes.js';

/** Provider deployment observations and the repository shipping pulse derived from them. */
export const shippingPulseRoutes = defineRoutes('shipping-pulse', [
  { method: 'POST', path: '/api/production-observations', handle: async context => { refuseCiProducer(context.actor, 'deployment observation'); return context.services.productionDelivery.observe(context.actor, await parseJson(context), context.idempotencyKey()); } },
  { method: 'GET', path: '/api/shipping-pulse', handle: ({ services }) => shippingPulse(services.engine.store.pool) },
]);
