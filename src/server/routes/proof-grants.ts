import { defineRoutes, parseJson } from '../routes.js';

/** Proof authority: the live grant set and its append-only history. */
export const proofGrantRoutes = defineRoutes('proof-grants', [
  { method: 'GET', path: '/api/proof-grants', handle: ({ actor, services }) => services.proofGrants.list(actor) },
  { method: 'GET', path: /^\/api\/proof-grants\/([^/]+)\/history$/, handle: ({ actor, services }, [principal]) => services.proofGrants.history(actor, decodeURIComponent(principal)) },
  {
    method: 'POST', path: /^\/api\/proof-grants\/([^/]+)\/(grant|revoke)$/,
    async handle(context, [principal, action]) {
      const { actor, services: { proofGrants } } = context;
      const data = await parseJson(context), key = context.idempotencyKey(), target = decodeURIComponent(principal);
      return action === 'grant' ? proofGrants.grant(actor, target, data, key) : proofGrants.revoke(actor, target, data, key);
    },
  },
]);
