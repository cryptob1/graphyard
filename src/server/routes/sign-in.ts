import { createHash, randomBytes } from 'node:crypto';
import { demand, type Principal } from '../../model.js';
import { defineRoutes, parseJson, type Services } from '../routes.js';

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
export const signInFragment = 'sign-in';
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

/** Asking for a link: authenticated, with the operator's own credential. */
export const signInLinkRoutes = defineRoutes('sign-in-links', [
  { method: 'POST', path: '/api/sign-in-links', handle: async ({ actor, services }) => humanSignIn(services).issue(actor, services.principals.some(entry => entry.actor.id === actor.id && entry.actor.role === 'admin')) },
]);
/** Opening a link: the one route a browser reaches without a token, since the link is the credential. */
export const signInRoutes = defineRoutes('sign-in', [
  {
    method: 'POST', path: '/api/sign-in',
    async handle(context) {
      const { code } = ((await parseJson(context, 4_096, '{}')) ?? {}) as { code?: unknown };
      demand(typeof code === 'string' && code.length > 0 && code.length <= 200, 'A sign-in code is required', 400);
      return humanSignIn(context.services).redeem(code as string);
    },
  },
]);
