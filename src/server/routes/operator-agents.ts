import { demand } from '../../model.js';
import { DirectMerges } from '../../direct-merge.js';
import { defineRoutes, parseJson, type Services } from '../routes.js';
import { humanSignIn } from '../auth.js';

const directMerges = (services: Services) => new DirectMerges(services.engine.store, () => services.engine.directMergeEnvironment);

/** Scoped operator automation identities: listing, setup, and credential lifecycle; and the admin-only direct-merge mode. */
export const operatorAgentRoutes = defineRoutes('operator-agents', [
  // The configured roster without credentials: who the server authenticates, in which role, and
  // which of them hold a live lease. A roster rotation is previewed against it so it can never
  // drop a live principal; it answers operator agents itself, like every route in this module.
  {
    method: 'GET', path: '/api/principals',
    async handle({ actor, services }) {
      demand(['admin', 'coordinator', 'operator-agent'].includes(actor.role), 'The principal roster is available to admin, coordinator and operator-agent identities', 403);
      const now = Date.now(), leased = (await services.engine.store.list()).filter(work => work.lease && Date.parse(work.lease.expiresAt) > now);
      return { principals: services.principals.map(({ actor: principal }) => ({ id: principal.id, role: principal.role, sessionKind: principal.sessionKind ?? null,
        leases: leased.filter(work => work.lease!.owner === principal.id).map(work => work.key) })) };
    },
  },
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
  // Direct-merge mode (direct-merge.ts): read by the master and dashboard, set and cleared with an admin credential only.
  { method: 'GET', path: '/api/direct-merges', handle: ({ actor, services }) => directMerges(services).status(actor) },
  { method: 'POST', path: /^\/api\/direct-merges\/(on|off)$/, handle: async (context, [action]) => directMerges(context.services).change(context.actor, action as 'on' | 'off', await parseJson(context), context.idempotencyKey()) },
  // The operator's own sign-in link (GY-738): only their configured admin credential asks for one.
  { method: 'POST', path: '/api/sign-in-links', handle: async ({ actor, services }) => humanSignIn(services).issue(actor, services.principals.some(entry => entry.actor.id === actor.id && entry.actor.role === 'admin')) },
]);
