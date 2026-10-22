import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Refusal, demand, operatorScopeIncludes, type Principal } from '../model.js';
import { laneOnlyProducer, type Credential, type PrincipalGrant } from './principals.js';
import { readImports } from '../validation-import.js';
import type { Engine } from '../engine.js';
import { Validation } from '../validation.js';
import { Delivery } from '../delivery.js';
import { OperatorAgents } from '../operator-agent.js';
import { AgentRegistry } from '../agent-registry.js';
import { ProductionDelivery } from '../production-delivery.js';
import { artifactCapacityFromEnv, type ArtifactBackend } from '../artifacts.js';
import { buildIdentity } from '../protocol-version.js';
import type { ProductionWatch } from '../production-watch.js';
import { responderFromEnv, type Responder } from '../closed-question.js';
import { assembleDelegationLimits } from './limits.js';
import { Next, type Route, type RouteContext, type RouteModule, type Services } from './routes.js';
import { leaseCommandRequest } from './routes/work.js';
import { signinClaimFromEnv } from './routes/signin.js';

/**
 * Resolve the bearer token to a principal: a configured credential first, then a human session a
 * one-time sign-in link opened (GY-738, `HumanSignIn` below), then a live operator-agent credential. A lease command (`method` and `pathname`) authenticates on the lease pool (GY-558), so an exhausted
 * general pool cannot stop a renewal before it reaches its own connections.
 */
export async function authenticate(services: Services, authorization: string | undefined, repository: string, method?: string, pathname = ''): Promise<Principal> {
  const lease = leaseCommandRequest(method, pathname);
  const token = String(authorization ?? '').replace(/^Bearer /, '');
  const hash = createHash('sha256').update(token).digest();
  const configured = configuredCredential(services, hash);
  if (configured) await services.operatorAgents.assertConfiguredPrincipalSafe({ id: configured.actor.id, tokenHash: hash.toString('hex') }, { lease });
  const actor = configured?.actor ?? humanSignIn(services).authenticate(token) ?? await services.operatorAgents.authenticate(token);
  demand(actor, 'A valid Graphyard bearer token is required', 401);
  if (actor.role === 'operator-agent') demand(actor.scope?.repositories.includes(repository), 'Repository is outside operator-agent scope', 403);
  return actor;
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
      // A candidate's imported runs and hold (GY-1860): the promotion workflows read it, and seal a released one, as the release-filing identity; never import.
      || (req.method === 'GET' && /^\/api\/validation\/import\/[a-f0-9]{40}$/.test(url.pathname))
      // GY-1882: whether the release-filing identity may seal, which the uat imports job checks before any seal.
      || (req.method === 'GET' && url.pathname === '/api/validation/import/seal-authority')
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
 * use and expires in minutes; the session it opens lasts 30 days (GY-2171). Only digests are held, in
 * this process: a restart signs everyone out, and nothing about either is ever written. Both
 * tables are bounded: past the cap the entry nearest expiry goes first, so repeated
 * `graphyard login` calls cannot grow them between prunes.
 */
export const signInLinkTtlMs = 10 * 60_000;
export const signInSessionTtlMs = 30 * 86_400_000;
export const maxSignInLinks = 16;
export const maxSignInSessions = 32;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export class HumanSignIn {
  private readonly links = new Map<string, { principal: Principal; expiresAt: number }>();
  private readonly sessions = new Map<string, { actor: Principal; expiresAt: number }>();
  constructor(private readonly clock: () => number = Date.now) {}

  /**
   * A link for the issuing principal. Only a configured admin credential declared a human session
   * issues one: never an agent identity, a reader, or a worker, and never an admin declared an AI
   * session or declaring nothing, since redeeming the link declares the session human and would hand
   * whoever holds that credential the decisions only a human may make. An install declares its
   * operator human (install/index.ts), and the server treats an undeclared session as never human.
   */
  issue(issuer: Principal, configured: boolean) {
    demand(configured && issuer.role === 'admin', 'Only the operator\'s own admin credential issues a sign-in link', 403);
    demand(issuer.sessionKind === 'human', `A sign-in link opens a human session; ${issuer.id} is ${issuer.sessionKind === 'ai' ? 'declared an AI session' : 'not declared "sessionKind": "human"'} and issues none`, 403);
    const now = this.prune(), code = randomBytes(32).toString('base64url');
    const { displayName } = issuer;
    bounded(this.links, maxSignInLinks - 1);
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
    bounded(this.sessions, maxSignInSessions - 1);
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

/** Drop the entries nearest expiry until at most `room` remain. Every entry of a table has the same lifetime, so insertion order is expiry order. */
function bounded(table: Map<string, { expiresAt: number }>, room: number) {
  for (const key of table.keys()) { if (table.size <= room) break; table.delete(key); }
}

const signIns = new WeakMap<Services, HumanSignIn>();
/** The sign-in table of one assembled control plane. */
export function humanSignIn(services: Services) {
  let table = signIns.get(services);
  if (!table) signIns.set(services, table = new HumanSignIn());
  return table;
}

/** Where retained validation artifacts live and how much the postgres backend may hold. */
export interface ArtifactOptions { backend: ArtifactBackend | null; capacityBytes: number }

/**
 * What an embedder tells the control plane about the installation: the principals it already
 * ran with (the seeded proof-grant roster, deciding whether an over-limit roster warns or
 * refuses), the environment the limits are read from, the deployment watch, and the responder.
 */
export interface ServerOptions { knownPrincipals?: readonly string[]; env?: NodeJS.ProcessEnv; production?: ProductionWatch | null; responder?: Responder | null }

/** Wire the engine, its integrations and the principals into the shared services. */
export function assembleServices(engine: Engine, credentials: Credential[], artifacts: ArtifactOptions = { backend: null, capacityBytes: artifactCapacityFromEnv() }, options: ServerOptions = {}): Services {
  const env = options.env ?? process.env;
  const delegationLimits = assembleDelegationLimits(credentials, env, options.knownPrincipals);
  const principals = credentials.map(({ token, ...actor }) => ({ actor, hash: createHash('sha256').update(token).digest() }));
  // The engine is constructed with the repository this control plane coordinates; GITHUB_REPOSITORY is
  // only a process default (the CI checkout) and never overrides an explicit engine binding.
  const repository = engine.repository || process.env.GITHUB_REPOSITORY || '';
  // Mutations authorize against the same canonical binding as authentication; embedders may leave it to the process default.
  engine.repository = repository;
  demand(!(engine.reviewerApps ?? []).some(app => app.appId === engine.controlPlaneAppId),
    'A registered reviewer App must be distinct from the Graphyard control-plane App');
  const validation = new Validation(engine, principals.map(p => p.actor), repository);
  validation.artifactBackend = artifacts.backend; validation.artifactCapacityBytes = artifacts.capacityBytes;
  const delivery = new Delivery(validation);
  const operatorAgents = new OperatorAgents(engine.store, repository, credentials.map(credential => ({ id: credential.id, tokenHash: createHash('sha256').update(credential.token).digest('hex') })));
  const productionDelivery = new ProductionDelivery(engine.store);
  engine.operatorAuthorizer = operatorAgents.revalidate.bind(operatorAgents);
  // Proof authority is the roster's: each principal may prove exactly the --proof patterns its entry carries.
  engine.principals = credentials.map(({ token, ...actor }) => actor);
  return { signinClaim: signinClaimFromEnv(env, credentials), engine, repository, principals, limits: delegationLimits.limits, delegationLimits, build: buildIdentity(env), production: options.production ?? null, validation, delivery, operatorAgents, productionDelivery, agentRegistry: new AgentRegistry(engine.store), responder: options.responder !== undefined ? options.responder : responderFromEnv(env) };
}
