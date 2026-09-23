import type { IncomingMessage } from 'node:http';
import { demand } from '../../model.js';
import { executorHostHeader, registryMutationSchemas, type RegistryMutation } from '../../model/registry.js';
import { defineRoutes, parseJson } from '../routes.js';

const collections = { runtimes: 'runtime', models: 'model', accounts: 'account', roles: 'role' } as const;
/** The executor a read is judged for: `?host=`, or the executor-host header an older server simply ignores. */
export function executorHost(url: URL, req: IncomingMessage) {
  const header = req.headers[executorHostHeader.toLowerCase()];
  const host = (url.searchParams.get('host') ?? (Array.isArray(header) ? header[0] : header))?.trim();
  return host ? host.slice(0, 200) : null;
}

/**
 * The agent registry: the fleet's runtimes, accounts, models and roles, the session an executor's
 * action runs on, and the history of both. Configuration is a POST per collection — set one entry,
 * remove one, mark an account's quota — or one `apply` for a whole proposal.
 */
export const agentRegistryRoutes = defineRoutes('agent-registry', [
  { method: 'GET', path: '/api/agent-registry', handle: ({ actor, req, url, services }) => services.agentRegistry.view(actor, executorHost(url, req)) },
  { method: 'GET', path: '/api/agent-registry/document', handle: ({ actor, services }) => services.agentRegistry.document(actor) },
  { method: 'GET', path: '/api/agent-registry/history', handle: ({ actor, url, services }) => services.agentRegistry.history(actor, Number(url.searchParams.get('limit') ?? 100)) },
  { method: 'POST', path: '/api/agent-registry/apply', handle: async context => context.services.agentRegistry.mutate(context.actor, 'apply', await parseJson(context), context.idempotencyKey()) },
  { method: 'POST', path: '/api/agent-registry/select', handle: async context => context.services.agentRegistry.select(context.actor, await parseJson(context), context.idempotencyKey()) },
  {
    method: 'POST', path: /^\/api\/agent-registry\/sessions\/([0-9a-f-]{36})\/end$/,
    handle: async (context, [id]) => context.services.agentRegistry.endSession(context.actor, id, await parseJson(context), context.idempotencyKey()),
  },
  {
    // POST /api/agent-registry/accounts           {account, reason}  → account.set
    // POST /api/agent-registry/accounts/NAME/remove  {reason}        → account.remove
    // POST /api/agent-registry/accounts/NAME/quota   {quota, reason} → account.quota
    method: 'POST', path: /^\/api\/agent-registry\/(runtimes|models|accounts|roles)(?:\/([^/]+)\/(remove|quota))?$/,
    async handle(context, [collection, name, action]) {
      const entry = collections[collection as keyof typeof collections];
      const kind = `${entry}.${action ?? 'set'}` as RegistryMutation;
      demand(kind in registryMutationSchemas, 'Route not found', 404);
      const data = await parseJson(context);
      return context.services.agentRegistry.mutate(context.actor, kind, name === undefined ? data : { ...data, name: decodeURIComponent(name) }, context.idempotencyKey());
    },
  },
]);
