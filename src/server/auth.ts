import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { demand, operatorScopeIncludes, type Principal } from '../model.js';
import { Next, type Route, type Services } from './routes.js';
import { leaseCommandRequest } from './routes/work.js';

/**
 * Resolve the bearer token to a principal: a configured credential first, then a human session a
 * one-time sign-in link opened (GY-738, `HumanSignIn` below), then a live operator-agent credential. A lease command (`method` and `pathname`) authenticates on the lease pool (GY-558), so an exhausted
 * general pool cannot stop a renewal before it reaches its own connections.
 */
export async function authenticate(services: Services, authorization: string | undefined, repository: string, method?: string, pathname = ''): Promise<Principal> {
  const lease = leaseCommandRequest(method, pathname);
  const token = String(authorization ?? '').replace(/^Bearer /, '');
  const hash = createHash('sha256').update(token).digest();
  const configured = services.principals.find(p => timingSafeEqual(p.hash, hash));
  if (configured) await services.operatorAgents.assertConfiguredPrincipalSafe({ id: configured.actor.id, tokenHash: hash.toString('hex') }, { lease });
  const actor = configured?.actor ?? humanSignIn(services).authenticate(token) ?? await services.operatorAgents.authenticate(token);
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

/**
 * The human operator signs into the dashboard without handling a token (GY-738). `graphyard login`,
 * run with the operator's own admin credential, asks for a one-time link; opening it in a browser
 * redeems it for a short-lived session bound to that principal and declared human, so the
 * decisions only a human may make are answered in that browser with one click. A link is single
 * use and expires in minutes; the session it opens expires in hours. Only digests are held, in
 * this process: a restart signs everyone out, and nothing about either is ever written.
 */
export const signInLinkTtlMs = 10 * 60_000;
export const signInSessionTtlMs = 12 * 3_600_000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export class HumanSignIn {
  private readonly links = new Map<string, { principal: Principal; expiresAt: number }>();
  private readonly sessions = new Map<string, { actor: Principal; expiresAt: number }>();
  constructor(private readonly clock: () => number = Date.now) {}

  /** A link for the issuing principal. Only a configured admin credential issues one: never an agent identity, a reader, or a worker. */
  issue(issuer: Principal, configured: boolean) {
    demand(configured && issuer.role === 'admin', 'Only the operator\'s own admin credential issues a sign-in link', 403);
    const now = this.prune(), code = randomBytes(32).toString('base64url');
    const { displayName } = issuer;
    this.links.set(digest(code), { principal: { id: issuer.id, role: 'admin', ...(displayName ? { displayName } : {}) }, expiresAt: now + signInLinkTtlMs });
    return { code, principal: issuer.id, expiresAt: new Date(now + signInLinkTtlMs).toISOString() };
  }

  /** Redeem a link once: it is gone whether or not it was still valid, and a live one opens a human session for its principal. */
  redeem(code: string) {
    const now = this.prune(), key = digest(code), link = this.links.get(key);
    this.links.delete(key);
    demand(link && link.expiresAt > now, 'This sign-in link has expired or was already used; ask for a new one', 401);
    const token = `gyh_${randomBytes(32).toString('base64url')}`;
    const actor: Principal = { ...link!.principal, sessionKind: 'human' };
    this.sessions.set(digest(token), { actor, expiresAt: now + signInSessionTtlMs });
    return { token, actor, expiresAt: new Date(now + signInSessionTtlMs).toISOString() };
  }

  /** The principal a session token stands for, or null once it has expired or was never issued. */
  authenticate(token: string): Principal | null {
    const now = this.prune(), session = this.sessions.get(digest(token));
    return session && session.expiresAt > now ? { ...session.actor } : null;
  }

  private prune() {
    const now = this.clock();
    for (const table of [this.links, this.sessions]) for (const [key, entry] of table) if (entry.expiresAt <= now) table.delete(key);
    return now;
  }
}

const signIns = new WeakMap<Services, HumanSignIn>();
/** The sign-in table of one assembled control plane. */
export function humanSignIn(services: Services) {
  let table = signIns.get(services);
  if (!table) signIns.set(services, table = new HumanSignIn());
  return table;
}
