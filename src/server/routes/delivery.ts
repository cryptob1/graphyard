import { demand } from '../../model.js';
import { defineRoutes, parseJson } from '../routes.js';

/**
 * D3: releases, expected-release selection and deployment observations. Reads are open to
 * every authenticated non-operator-agent credential; each mutation derives its authority
 * from the credential and the registration it names.
 */
export const deliveryRoutes = defineRoutes('delivery', [
  { method: 'GET', path: '/api/delivery', handle: ({ services }) => services.delivery.status() },
  { method: 'GET', path: '/api/delivery/observations', handle: ({ url, services }) => services.delivery.observations(url.searchParams.get('environment') ?? '', url.searchParams.get('cursor') ?? undefined) },
  {
    method: 'POST', path: /^\/api\/delivery\/(build|release|approve|select|lease|observe|notify|sweep)$/,
    async handle(context, [command]) {
      const { actor, services: { delivery } } = context;
      const data = await parseJson(context, undefined, '{}'), key = context.idempotencyKey();
      if (command === 'sweep') { demand(actor.role === 'admin', 'Operator permission required', 403); return delivery.sweep(); }
      return command === 'build' ? delivery.attestBuild(actor, data, key)
        : command === 'release' ? delivery.createRelease(actor, data, key)
        : command === 'approve' ? delivery.approve(actor, data, key)
        : command === 'select' ? delivery.select(actor, data, key)
        : command === 'lease' ? delivery.lease(actor, data)
        : command === 'observe' ? delivery.observe(actor, data, key)
        : delivery.notify(actor, data);
    },
  },
]);
