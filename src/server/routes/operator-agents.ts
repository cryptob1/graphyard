import { demand } from '../../model.js';
import { CoordinatorRecovery } from '../../coordinator-recovery.js';
import { defineRoutes, parseJson, type Services } from '../routes.js';
import { humanSignIn } from '../auth.js';

/** Scoped operator automation identities: listing, setup, and credential lifecycle. */
export const operatorAgentRoutes = defineRoutes('operator-agents', [
  // The configured roster without credentials: who the server authenticates, in which role, with
  // which lane grants (GY-1879) and proof patterns, and which of them hold a live lease. A roster rotation is previewed against it so it can never
  // drop a live principal; it answers operator agents itself, like every route in this module.
  {
    method: 'GET', path: '/api/principals',
    async handle({ actor, services }) {
      demand(['admin', 'coordinator', 'operator-agent'].includes(actor.role), 'The principal roster is available to admin, coordinator and operator-agent identities', 403);
      const now = Date.now(), leased = (await services.engine.store.fleet()).filter(work => work.lease && Date.parse(work.lease.expiresAt) > now);
      return { principals: services.principals.map(({ actor: principal }) => ({ id: principal.id, role: principal.role, sessionKind: principal.sessionKind ?? null, grants: principal.grants ?? [], proofs: principal.proofs ?? [],
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
  // The merger (merger-mode.ts): always the control plane; read-only, so nothing can set another.
  // The end-to-end runner probes delivery support through this read-only route.
  { method: 'GET', path: '/api/merger', handle: async () => ({ merger: 'control-plane', mode: 'control-plane', line: 'The control plane is the merge writer' }) },
  // GY-1529: the known-good coordinator's recovery, recorded with an admin credential only.
  { method: 'POST', path: '/api/coordinator/recovered', handle: async context => new CoordinatorRecovery(context.services.engine.store).record(context.actor, await parseJson(context), context.idempotencyKey()) },
  { method: 'POST', path: '/api/sign-out', handle: async ({ req, services }) => {
    await humanSignIn(services).signOut(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
    return { signedOut: true };
  } },
  // The operator's own sign-in link (GY-738): only their configured admin credential asks for one.
  { method: 'POST', path: '/api/sign-in-links', handle: async ({ actor, services }) => humanSignIn(services).issue(actor, services.principals.some(entry => entry.actor.id === actor.id && entry.actor.role === 'admin')) },
  // GY-3215: the operator invites a teammate (a one-time link to their own session) or revokes one.
  { method: 'POST', path: '/api/invites', handle: async context => {
    const { name, role } = await parseJson(context) as { name: string; role: string };
    return humanSignIn(context.services).invite(context.actor, configuredIds(context.services), name, role);
  } },
  { method: 'POST', path: /^\/api\/invites\/([^/]+)\/revoke$/, handle: async ({ actor, services }, [name]) => humanSignIn(services).revoke(actor, configuredIds(services), decodeURIComponent(name)) },
]);

/** Every configured principal id; the issuer must be one of them, and no invite may take one's name. */
const configuredIds = (services: Services) => services.principals.map(entry => entry.actor.id);
