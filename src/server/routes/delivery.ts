import { demand } from '../../model.js';
import type { Containment } from '../../delivery.js';
import type { Engine } from '../../engine.js';
import { gitRunnerFor, type GitRunner } from '../../merge-writer/local-observation.js';
import { defineRoutes, parseJson } from '../routes.js';

/**
 * Whether a merge is in the commit production serves, read from the checkout the plane serves
 * from: `merge-base --is-ancestor` exits 0 when it is, 1 when it is not, and anything else
 * (an unknown commit, a missing checkout) leaves the answer open, so the item keeps waiting.
 */
export const checkoutContainment = (git: GitRunner): Containment => async (ancestor, descendant) => {
  const { status } = await git(['merge-base', '--is-ancestor', ancestor, descendant]);
  return status === 0 ? true : status === 1 ? false : null;
};
const checkoutGit = (engine: Engine) => engine.gitRunner ??= gitRunnerFor(process.env.GRAPHYARD_REPOSITORY_ROOT ?? process.cwd());

/**
 * D3: releases, expected-release selection and deployment observations. Reads are open to
 * every authenticated non-operator-agent credential; each mutation derives its authority
 * from the credential and the registration it names.
 */
export const deliveryRoutes = defineRoutes('delivery', [
  { method: 'GET', path: '/api/delivery', handle: ({ services }) => services.delivery.status() },
  { method: 'GET', path: '/api/delivery/observations', handle: ({ url, services }) => services.delivery.observations(url.searchParams.get('environment') ?? '', url.searchParams.get('cursor') ?? undefined) },
  // GY-1861: a producer's reading of the commit production serves; containment by ancestry in the checkout.
  {
    method: 'POST', path: '/api/delivery/observe-sha',
    async handle(context) {
      const { actor, services: { delivery } } = context;
      return delivery.observeSha(actor, await parseJson(context, undefined, '{}'), context.idempotencyKey(), checkoutContainment(checkoutGit(context.services.engine)));
    },
  },
  {
    method: 'POST', path: /^\/api\/delivery\/(build|release|approve|select|lease|observe|notify|sweep|rollback|rollback-claim|rollback-settle|rollback-resolve)$/,
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
        : command === 'rollback' ? delivery.requestRollback(actor, data, key)
        : command === 'rollback-claim' ? delivery.claimRollback(actor, data, key)
        : command === 'rollback-settle' ? delivery.settleRollback(actor, data, key)
        : command === 'rollback-resolve' ? delivery.resolveRollback(actor, data, key)
        : delivery.notify(actor, data);
    },
  },
]);
