import { createHash, timingSafeEqual } from 'node:crypto';
import { demand, operatorScopeIncludes, type Principal } from '../model.js';
import { Next, type Route, type Services } from './routes.js';
import { leaseCommandRequest } from './routes/work.js';

/**
 * Resolve the bearer token to a principal: a configured credential first, then a live operator-agent
 * credential. A lease command (`method` and `pathname`) authenticates on the lease pool (GY-558), so an exhausted
 * general pool cannot stop a renewal before it reaches its own connections.
 */
export async function authenticate(services: Services, authorization: string | undefined, repository: string, method?: string, pathname = ''): Promise<Principal> {
  const lease = leaseCommandRequest(method, pathname);
  const token = String(authorization ?? '').replace(/^Bearer /, '');
  const hash = createHash('sha256').update(token).digest();
  const configured = services.principals.find(p => timingSafeEqual(p.hash, hash));
  if (configured) await services.operatorAgents.assertConfiguredPrincipalSafe({ id: configured.actor.id, tokenHash: hash.toString('hex') }, { lease });
  const actor = configured?.actor ?? await services.operatorAgents.authenticate(token);
  demand(actor, 'A valid Graphyard bearer token is required', 401);
  if (actor.role === 'operator-agent') demand(actor.scope?.repositories.includes(repository), 'Repository is outside operator-agent scope', 403);
  return actor;
}

/** One scope rule for every scoped read, so a route cannot answer with data its own authorization would refuse. */
export const operatorVisible = <T extends { id: string; key: string }>(actor: Principal, items: T[]) => items.filter(item => operatorScopeIncludes(actor, item));

/**
 * Operator agents reach only the intent and policy routes. This guard sits after the
 * identity-administration routes in the table, which answer for themselves, and before
 * every other authenticated route.
 */
export const operatorAgentRouteGuard: Route = {
  method: '*', path: /^\/api\//,
  async handle({ actor, url }) {
    if (actor.role === 'operator-agent') demand(
      url.pathname === '/api/status' || url.pathname === '/api/work-snapshot' || url.pathname === '/api/work' || url.pathname === '/api/events'
      || url.pathname === '/api/delegation' || url.pathname === '/api/intake' || /^\/api\/work(?:\/[^/]+(?:\/[a-z]+)?)?$/.test(url.pathname)
      // Judgement about delivered work is intent (GY-98): recording it and turning it into an item.
      || /^\/api\/judgements(?:\/[^/]+\/work)?$/.test(url.pathname),
      'Route is not available to operator agents', 403);
    return Next;
  },
};
