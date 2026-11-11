import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { demand, operatorScopeIncludes, type Principal } from '../model.js';
import { laneOnlyProducer, teamRoles, type Credential, type PrincipalGrant, type TeamRole } from './principals.js';
import { readImports } from '../validation-import.js';
import type { Store } from '../store.js';
import type { Engine } from '../engine.js';
import { Validation } from '../validation.js';
import { Delivery } from '../delivery.js';
import { OperatorAgents } from '../operator-agent.js';
import { AgentRegistry } from '../agent-registry.js';
import { buildIdentity } from '../protocol-version.js';
import type { ProductionWatch } from '../production-watch.js';
import { responderFromEnv, type Responder } from '../closed-question.js';
import { assembleDelegationLimits } from './limits.js';
import { Next, type Route, type RouteContext, type RouteModule, type Services } from './routes.js';
import { leaseCommandRequest } from './routes/work.js';
import { launchTokenActor } from './review-verdict.js';
import { signinClaimFromEnv } from './routes/signin.js';

/**
 * Resolve the bearer token to a principal: a configured credential first, then a human session a
 * one-time sign-in link opened (GY-738, `HumanSignIn` below), a live operator-agent credential,
 * then an unused durable reviewer launch. A lease command (`method` and `pathname`)
 * authenticates on the lease pool (GY-558), so an exhausted
 * general pool cannot stop a renewal before it reaches its own connections. A tokenless `localRead`
 * request is the local viewer.
 */
export async function authenticate(services: Services, authorization: string | undefined, repository: string, method?: string, pathname = '', localRead = false): Promise<Principal> {
  const lease = leaseCommandRequest(method, pathname);
  // A browser trims the empty token's "Bearer " to "Bearer".
  const token = String(authorization ?? '').replace(/^Bearer\s*/, '');
  if (!token && localRead) return localViewer;
  const hash = createHash('sha256').update(token).digest();
  const configured = configuredCredential(services, hash);
  if (configured) await services.operatorAgents.assertConfiguredPrincipalSafe({ id: configured.actor.id, tokenHash: hash.toString('hex') }, { lease });
  const actor = configured?.actor ?? await humanSignIn(services).authenticate(token) ?? await services.operatorAgents.authenticate(token) ?? await launchTokenActor(services, hash.toString('hex'));
  demand(actor, 'A valid Graphyard bearer token is required', 401);
  if (actor.role === 'operator-agent') demand(actor.scope?.repositories.includes(repository), 'Repository is outside operator-agent scope', 403);
  return actor;
}

/** Whoever reads the dashboard on this machine without signing in: a reader, so every action and human-only decision still needs a signed-in session. */
export const localViewer: Principal = { id: 'local-viewer', role: 'reader', displayName: 'Local viewer' };
const loopbackHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?$/i;
/**
 * A read addressed to the loopback host and served (or Compose-published) port. Another Host header (a
 * DNS-rebinding page, the tailnet proxy), a forwarded request or a cross-origin browser request
 * is not one. Headerless local clients and direct browser navigation remain readable.
 */
export function localRead(req: IncomingMessage) {
  const host = loopbackHost.exec(req.headers.host ?? '');
  // Compose publishes only on host loopback, but NAT changes both the port and socket peer.
  // This installer-owned setting declares that boundary; direct servers still require loopback.
  const publishedPort = process.env.GRAPHYARD_LOCAL_VIEW_PORT;
  return req.method === 'GET' && !!host && Number(host[1] ?? 80) === (publishedPort ? Number(publishedPort) : req.socket.localPort)
    && (!!publishedPort || ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? ''))
    && !req.headers.forwarded && !req.headers['x-forwarded-for']
    && (req.headers.origin === undefined || req.headers.origin === new URL(`http://${req.headers.host}`).origin)
    && (req.headers['sec-fetch-site'] === undefined || ['same-origin', 'none'].includes(String(req.headers['sec-fetch-site'])));
}

const configuredCredential = (services: Services, hash: Buffer) => services.principals.find(p => timingSafeEqual(p.hash, hash));
/** The configured principal a bearer token names, read without any effect; null without one. */
export function configuredActor(services: Services, authorization: string | undefined): Principal | null {
  if (!authorization) return null;
  return configuredCredential(services, createHash('sha256').update(authorization.replace(/^Bearer /, '')).digest())?.actor ?? null;
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
  async handle({ actor, url, req }) {
    if (actor.role === 'operator-agent') demand(
      url.pathname === '/api/status' || url.pathname === '/api/work-snapshot' || url.pathname === '/api/work' || url.pathname === '/api/events'
      || url.pathname === '/api/delegation' || url.pathname === '/api/intake' || /^\/api\/work(?:\/[^/]+(?:\/[a-z]+)?)?$/.test(url.pathname)
      // E2E case recording (GY-1614): the registry and its run route, only for a holder of e2e:record.
      || (/^\/api\/scenarios(?:\/[^/]+\/runs)?$/.test(url.pathname) && !!actor.capabilities?.includes('e2e:record'))
      // The release-filing identity reads imported runs and seals a released candidate; never imports.
      || (req.method === 'GET' && /^\/api\/validation\/import\/[a-f0-9]{40}$/.test(url.pathname))
      || (req.method === 'POST' && /^\/api\/validation\/import\/[a-f0-9]{40}\/seal$/.test(url.pathname)),
      'Route is not available to operator agents', 403);
    return Next;
  },
};

/** Whether `actor` is confined to its lanes: a producer whose roster entry carries lane grants and no proof patterns (GY-1879, GY-1912). */
export const confinedLaneProducer = (actor: Principal) => laneOnlyProducer(actor);

type Lane = { may: string; answer(context: RouteContext): unknown };
/** Each grant's routes: `answer` returns Next to pass the request on, a response to answer it here, or undefined when it is not one of the lane's. */
const lanes: Record<PrincipalGrant, Lane> = {
  'external-runs:import': {
    may: 'import a run, read its own imports',
    answer({ req, url, actor, services }) {
      if (req.method === 'POST' && url.pathname === '/api/validation/import') return Next;
      const head = req.method === 'GET' ? /^\/api\/validation\/import\/([a-f0-9]{40})$/.exec(url.pathname) : null;
      // Only the runs this principal imported itself.
      return head ? readImports({ store: services.engine.store }, head[1], url.searchParams.get('candidate'), actor.id) : undefined;
    },
  },
  // GY-1912: the GY-1861 observation by commit, and nothing beside it.
  'delivery:observe-sha': {
    may: 'record a deployment observation by commit (POST /api/delivery/observe-sha)',
    answer: ({ req, url }) => req.method === 'POST' && url.pathname === '/api/delivery/observe-sha' ? Next : undefined,
  },
};
/**
 * A lane-only producer is held to the routes its grants name. This guard is the first authenticated
 * route (src/server/index.ts dispatches it ahead of the table): each grant passes or answers its own
 * routes, GET /api/principals answers with its own entry alone, and every other route is refused.
 */
export const laneProducerRouteGuard: Route = {
  method: '*', path: /^\/api\//,
  async handle(context) {
    const { actor, url, req } = context;
    if (!confinedLaneProducer(actor)) return Next;
    const grants = (actor.grants ?? []) as PrincipalGrant[];
    for (const grant of grants) {
      const answer = await lanes[grant].answer(context);
      if (answer !== undefined) return answer;
    }
    if (req.method === 'GET' && url.pathname === '/api/principals')
      return { principals: [{ id: actor.id, role: actor.role, sessionKind: actor.sessionKind ?? null, grants, leases: [] }] };
    demand(false, `${req.method} ${url.pathname} is outside the ${grants.join(' and ')} lane of producer ${actor.id}: it may ${grants.map(grant => lanes[grant].may).join(', ')} and read its own principal`, 403);
    return Next;
  },
};
export const laneProducerScope: RouteModule = { name: 'lane-producer-scope', routes: [laneProducerRouteGuard] };

/**
 * The human operator signs into the dashboard without handling a token (GY-738). `graphyard login`,
 * run with the operator's own admin credential, asks for a one-time link; opening it in a browser
 * redeems it for a short-lived session bound to that principal and declared human, so the
 * decisions only a human may make are answered in that browser with one click. A link is single
 * use and expires in minutes; the session it opens expires 90 days after its last use. Session digests, actors and expiry
 * are persisted in Postgres; pending link digests stay in memory. Both
 * tables are bounded: links evict the oldest entry, while session capacity refuses new
 * sign-ins until an existing session expires or signs out.
 */
export const signInLinkTtlMs = 10 * 60_000;
export const signInSessionTtlMs = 90 * 86_400_000;
export const maxSignInLinks = 16;
export const maxSignInSessions = 32;
/**
 * Only a configured admin credential declared a human session issues a link or an invite: never an agent identity, a reader, or a worker, and
 * never an admin declared an AI session or declaring nothing, since redeeming the link declares the session human.
 */
function operatorOnly(issuer: Principal, configured: boolean) {
  demand(configured && issuer.role === 'admin', 'Only the operator\'s own admin credential issues a sign-in link', 403);
  demand(issuer.sessionKind === 'human', `A sign-in link opens a human session; ${issuer.id} is ${issuer.sessionKind === 'ai' ? 'declared an AI session' : 'not declared "sessionKind": "human"'} and issues none`, 403);
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export class HumanSignIn {
  private readonly links = new Map<string, { principal: Principal; expiresAt: number }>();
  constructor(private readonly store: Store, private readonly clock: () => number = Date.now) {}

  /** A link for the issuing operator (`operatorOnly`). An install declares its operator human (install/index.ts); an undeclared session is never human. */
  issue(issuer: Principal, configured: boolean) {
    operatorOnly(issuer, configured);
    // The session keeps the issuer's roster --proof patterns: proof authority is the roster's alone.
    const { displayName, proofs } = issuer;
    return this.link({ id: issuer.id, role: 'admin', ...(displayName ? { displayName } : {}), ...(proofs ? { proofs: [...proofs] } : {}) });
  }

  /**
   * GY-3215: the operator invites a teammate. NAME is recorded as a human principal with its team role
   * (inviting it again changes the role and issues a fresh link), and the link opens that teammate's own
   * session: role reader, so it reads everything; a maintainer also files work.
   */
  async invite(issuer: Principal, configured: string[], name: string, team: string) {
    operatorOnly(issuer, configured.includes(issuer.id));
    demand(typeof name === 'string' && /^[^\s\u0000-\u001f\u007f]{1,100}$/.test(name), 'NAME is a label of 1-100 characters without spaces, such as an email or GitHub login', 400);
    demand((teamRoles as readonly string[]).includes(team), `--role is one of ${teamRoles.join(', ')}`, 400);
    demand(!configured.includes(name), `${name} is a configured principal; invite a teammate under a name of their own`, 409);
    await this.store.pool.query(`INSERT INTO team_members (name, team, invited_by, invited_at) VALUES ($1, $2, $3, $4)
      ON CONFLICT (name) DO UPDATE SET team=EXCLUDED.team, invited_by=EXCLUDED.invited_by, invited_at=EXCLUDED.invited_at`, [name, team, issuer.id, new Date(this.clock())]);
    return { ...this.link({ id: name, role: 'reader', team: team as TeamRole, displayName: name }), role: team };
  }

  /** GY-3215: revoking a teammate removes them, their unopened links and every session they hold, at once. */
  async revoke(issuer: Principal, configured: string[], name: string) {
    operatorOnly(issuer, configured.includes(issuer.id));
    for (const [key, entry] of this.links) if (entry.principal.team && entry.principal.id === name) this.links.delete(key);
    const { rowCount } = await this.store.pool.query('DELETE FROM team_members WHERE name=$1', [name]);
    demand(!!rowCount, `${name} is not an invited teammate`, 404);
    const sessions = await this.store.pool.query(`DELETE FROM human_sign_in_sessions WHERE actor->>'id'=$1 AND actor ? 'team'`, [name]);
    return { revoked: name, sessionsEnded: sessions.rowCount ?? 0 };
  }

  private link(principal: Principal) {
    const now = this.prune(), code = randomBytes(32).toString('base64url');
    bounded(this.links, maxSignInLinks - 1);
    this.links.set(digest(code), { principal, expiresAt: now + signInLinkTtlMs });
    return { code, principal: principal.id, expiresAt: new Date(now + signInLinkTtlMs).toISOString() };
  }

  /** Redeem a link once: it is gone whether or not it was still valid, and a live one opens a human session for its principal. */
  async redeem(code: string) {
    const now = this.prune(), key = digest(code), link = this.links.get(key);
    this.links.delete(key);
    demand(link && link.expiresAt > now, 'This sign-in link has expired or was already used; ask for a new one', 401);
    const token = `gyh_${randomBytes(32).toString('base64url')}`;
    const actor: Principal = { ...link!.principal, sessionKind: 'human' };
    await this.store.transaction(async db => {
      // Serialize pruning and insertion across server instances to keep the global size bound.
      await db.query('LOCK TABLE human_sign_in_sessions IN EXCLUSIVE MODE');
      await db.query('DELETE FROM human_sign_in_sessions WHERE expires_at <= $1', [new Date(now)]);
      const { rows } = await db.query('SELECT count(*)::int AS count FROM human_sign_in_sessions');
      demand(rows[0].count < maxSignInSessions, 'The 32-session sign-in limit is reached; sign out an existing session or wait for one to expire, then request a new sign-in link', 409);
      await db.query('INSERT INTO human_sign_in_sessions (token_hash, actor, expires_at) VALUES ($1, $2, $3)', [digest(token), actor, new Date(now + signInSessionTtlMs)]);
    }, { coordinationLock: false });
    return { token, actor, expiresAt: new Date(now + signInSessionTtlMs).toISOString() };
  }

  /** The principal a session token stands for, or null once it has expired or was never issued. Use renews it: its expiry is its last use plus the session lifetime. */
  async authenticate(token: string): Promise<Principal | null> {
    if (!token.startsWith('gyh_')) return null;
    const now = this.clock(), key = digest(token), expiresAt = new Date(now + signInSessionTtlMs);
    const { rows } = await this.store.pool.query(
      'UPDATE human_sign_in_sessions SET expires_at=GREATEST(expires_at, $3) WHERE token_hash=$1 AND expires_at > $2 RETURNING actor',
      [key, new Date(now), expiresAt]);
    return rows[0]?.actor ?? null;
  }

  /** Revoke only the session named by the bearer token. */
  async signOut(token: string) {
    await this.store.pool.query('DELETE FROM human_sign_in_sessions WHERE token_hash=$1', [digest(token)]);
  }

  private prune() {
    const now = this.clock();
    for (const [key, entry] of this.links) if (entry.expiresAt <= now) this.links.delete(key);
    return now;
  }
}

/** Drop the entries nearest expiry until at most `room` remain. Every entry of a table has the same lifetime, so insertion order is expiry order. */
function bounded(table: Map<string, { expiresAt: number }>, room: number) {
  for (const key of table.keys()) { if (table.size <= room) break; table.delete(key); }
}

const signIns = new WeakMap<Services, HumanSignIn>();
/** The sign-in table of one assembled control plane. */
export function humanSignIn(services: Services) {
  let table = signIns.get(services);
  if (!table) signIns.set(services, table = new HumanSignIn(services.engine.store));
  return table;
}


/**
 * What an embedder tells the control plane about the installation: the principals it already
 * ran with (the seeded proof-grant roster, deciding whether an over-limit roster warns or
 * refuses), the environment the limits are read from, the deployment watch, and the responder.
 */
export interface ServerOptions { knownPrincipals?: readonly string[]; env?: NodeJS.ProcessEnv; production?: ProductionWatch | null; responder?: Responder | null }

/** Wire the engine, its integrations and the principals into the shared services. */
export function assembleServices(engine: Engine, credentials: Credential[], options: ServerOptions = {}): Services {
  const env = options.env ?? process.env;
  const delegationLimits = assembleDelegationLimits(credentials, env, options.knownPrincipals);
  const principals = credentials.map(({ token, ...actor }) => ({ actor, hash: createHash('sha256').update(token).digest() }));
  // The engine is constructed with the repository this control plane coordinates; GITHUB_REPOSITORY is
  // only a process default (the CI checkout) and never overrides an explicit engine binding.
  const repository = engine.repository || process.env.GITHUB_REPOSITORY || '';
  // Mutations authorize against the same canonical binding as authentication; embedders may leave it to the process default.
  engine.repository = repository;
  const validation = new Validation(engine, principals.map(p => p.actor), repository);
  const delivery = new Delivery(validation);
  const operatorAgents = new OperatorAgents(engine.store, repository, credentials.map(credential => ({ id: credential.id, tokenHash: createHash('sha256').update(credential.token).digest('hex') })));
  engine.operatorAuthorizer = operatorAgents.revalidate.bind(operatorAgents);
  // Proof authority is the roster's: each principal may prove exactly the --proof patterns its entry carries.
  engine.principals = credentials.map(({ token, ...actor }) => actor);
  return { signinClaim: signinClaimFromEnv(env, credentials), engine, repository, principals, limits: delegationLimits.limits, delegationLimits, build: buildIdentity(env), production: options.production ?? null, validation, delivery, operatorAgents, agentRegistry: new AgentRegistry(engine.store), responder: options.responder !== undefined ? options.responder : responderFromEnv(env) };
}
