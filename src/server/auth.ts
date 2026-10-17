import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Refusal, demand, operatorScopeIncludes, type Principal } from '../model.js';
import { laneOnlyProducer, type Credential } from './principals.js';
import { readImports } from '../validation-import.js';
import { ProofGrants, readGrant } from '../proof-grants.js';
import { proofProducer, withRecordedProofs } from '../delegation.js';
import type { Store } from '../store.js';
import type { Engine } from '../engine.js';
import type { GitHub } from '../github.js';
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
import { Next, type Route, type RouteModule, type Services } from './routes.js';
import { leaseCommandRequest } from './routes/work.js';
import { signinClaimFromEnv } from './routes/signin.js';
import { interventionPolicyFromEnv } from './routes/interventions.js';

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
      // Judgement about delivered work is intent (GY-98): recording it and turning it into an item.
      || /^\/api\/judgements(?:\/[^/]+\/work)?$/.test(url.pathname)
      // The loop's pipeline-doctor run summaries (GY-711): a record of what the doctor found and did, posted as the master's identity.
      || url.pathname === '/api/doctor'
      // Retro artefacts are judged by an independent agent identity holding decision:approve (GY-970).
      || /^\/api\/retro(?:\/standing|\/[0-9a-f-]{36}\/(?:approve|refuse))?$/.test(url.pathname)
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

/**
 * Whether `actor` is confined to the external-runs:import lane under effective proof authority.
 * A grant record (including an empty revoke) supersedes the environment `proofs` seed, so a
 * producer configured with both proofs and the import grant is re-confined once those proofs are
 * fully revoked; with no record yet, the seed decides (matching proof-grants.ts `effectiveAuthority`).
 */
export async function confinedLaneProducer(services: Pick<Services, 'engine'>, actor: Principal): Promise<boolean> {
  if (actor.role !== 'producer') return false;
  const record = await services.engine.store.transaction(db => readGrant(db, actor.id));
  return laneOnlyProducer(actor, record ? record.patterns : undefined);
}

/**
 * A lane-only producer (GY-1879: role producer, whose only grant is `external-runs:import`) is held
 * to the routes that grant names, derived from the grant alone, until the grant store records proof
 * authority for it (a producer holding proof grants keeps a producer's access). This guard is the first
 * authenticated route (src/server/index.ts dispatches it ahead of the table), so nothing else runs first: it passes POST /api/validation/import on to the
 * import, answers GET /api/validation/import/{sha} with the runs this principal imported itself and
 * GET /api/principals with its own entry, and refuses every other route before any effect.
 */
export const laneProducerRouteGuard: Route = {
  method: '*', path: /^\/api\//,
  async handle({ actor, url, req, services }) {
    // Read the grant store before any env-seed early return: a revoked seed must re-confine.
    if (!await confinedLaneProducer(services, actor)) return Next;
    if (req.method === 'POST' && url.pathname === '/api/validation/import') return Next;
    const head = req.method === 'GET' ? /^\/api\/validation\/import\/([a-f0-9]{40})$/.exec(url.pathname) : null;
    if (head) return readImports({ store: services.engine.store }, head[1], url.searchParams.get('candidate'), actor.id);
    if (req.method === 'GET' && url.pathname === '/api/principals')
      return { principals: [{ id: actor.id, role: actor.role, sessionKind: actor.sessionKind ?? null, grants: actor.grants ?? [], leases: [] }] };
    demand(false, `${req.method} ${url.pathname} is outside the external-runs:import lane of producer ${actor.id}: it may import a run, read its own imports and read its own principal`, 403);
    return Next;
  },
};
export const laneProducerScope: RouteModule = { name: 'lane-producer-scope', routes: [laneProducerRouteGuard] };

/**
 * The human operator signs into the dashboard without handling a token (GY-738). `graphyard login`,
 * run with the operator's own admin credential, asks for a one-time link; opening it in a browser
 * redeems it for a short-lived session bound to that principal and declared human, so the
 * decisions only a human may make are answered in that browser with one click. A link is single
 * use and expires in minutes; the session it opens expires in hours. Only digests are held, in
 * this process: a restart signs everyone out, and nothing about either is ever written. Both
 * tables are bounded: past the cap the entry nearest expiry goes first, so repeated
 * `graphyard login` calls cannot grow them between prunes.
 */
export const signInLinkTtlMs = 10 * 60_000;
export const signInSessionTtlMs = 12 * 3_600_000;
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

/** Each producer's recorded proof patterns, from the grant store: a record supersedes the environment seed. */
async function recordedProofs(store: Store): Promise<Map<string, string[]>> {
  return new Map((await store.pool.query('SELECT document FROM proof_grants')).rows.map(row => [row.document.principalId, row.document.patterns]));
}
const proofProducers = (principals: readonly Principal[]) => principals.filter(proofProducer).length;

/**
 * The delegation report recomputed from effective proof authority (GY-1879): a reviewer slot is
 * counted from the grant store, so a lane producer granted proofs through the grant API holds one.
 * Start-up assembles the report from the environment before any query can run; this runs once the
 * server is built and after every grant or revoke, updating the limits in force and their drift and
 * attention in place. A roster the recorded grants put over an explicit limit is reported, not refused.
 */
export async function refreshDelegationLimits(services: Services, credentials: Credential[], env: NodeJS.ProcessEnv, known?: readonly string[]) {
  const effective = withRecordedProofs(credentials, await recordedProofs(services.engine.store));
  let report: ReturnType<typeof assembleDelegationLimits>;
  try { report = assembleDelegationLimits(effective, env, known); }
  catch (error) {
    if (!(error instanceof Refusal)) throw error;
    report = { ...assembleDelegationLimits(effective, env, effective.map(p => p.id)), attention: [error.message] };
  }
  Object.assign(services.limits, report.limits);
  Object.assign(services.delegationLimits, { drift: report.drift, attention: report.attention });
}

/**
 * The grant store with reviewer capacity enforced (GY-1879): proof patterns granted to a producer
 * holding none make it a proof producer holding a reviewer slot, so the grant is refused once every slot
 * GRAPHYARD_MAX_REVIEWERS allows is held; every grant or revoke then recomputes the delegation report.
 */
export class SlotCountedProofGrants extends ProofGrants {
  constructor(private readonly grantStore: Store, private readonly configured: readonly Principal[], private readonly maxReviewers: () => number, private readonly refresh: () => Promise<void>) { super(grantStore, configured); }
  override async grant(actor: Principal, id: string, input: unknown, key: string) {
    const target = this.configured.find(p => p.id === id);
    if (actor.role === 'admin' && target) {
      const effective = withRecordedProofs(this.configured, await recordedProofs(this.grantStore));
      const held = proofProducers(effective);
      demand(target.role !== 'producer' || proofProducer(effective.find(p => p.id === id)!) || held < this.maxReviewers(),
        `Granting proofs to ${id} makes it an independent review/proof agent, and all ${held} slots GRAPHYARD_MAX_REVIEWERS=${this.maxReviewers()} allows are held; set GRAPHYARD_MAX_REVIEWERS=${held + 1} on the deployment first`, 409);
    }
    const result = await super.grant(actor, id, input, key);
    await this.refresh();
    return result;
  }
  override async revoke(actor: Principal, id: string, input: unknown, key: string) {
    const result = await super.revoke(actor, id, input, key);
    await this.refresh();
    return result;
  }
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
export function assembleServices(engine: Engine, credentials: Credential[], github: GitHub | null, artifacts: ArtifactOptions = { backend: null, capacityBytes: artifactCapacityFromEnv() }, options: ServerOptions = {}): Services {
  const env = options.env ?? process.env;
  const delegationLimits = assembleDelegationLimits(credentials, env, options.knownPrincipals);
  const principals = credentials.map(({ token, ...actor }) => ({ actor, hash: createHash('sha256').update(token).digest() }));
  // The engine is constructed with the repository this control plane coordinates; GITHUB_REPOSITORY is
  // only a process default (the CI checkout) and never overrides an explicit engine binding.
  const repository = engine.repository || github?.config.repository || process.env.GITHUB_REPOSITORY || '';
  demand(!engine.repository || !github || engine.repository.toLowerCase() === github.config.repository.toLowerCase(),
    'Engine and GitHub repositories must match');
  // Mutations authorize against the same canonical binding as authentication; some embedders pass it only via GitHub.
  engine.repository = repository;
  // Reviewer identities come from deployment configuration alongside the control-plane App,
  // so a single parsed registry authorizes both policy validation and provider observation.
  if (github) { engine.reviewerApps = github.config.reviewerApps ?? []; engine.controlPlaneAppId = github.config.appId; }
  demand(!engine.reviewerApps.some(app => app.appId === engine.controlPlaneAppId),
    'A registered reviewer App must be distinct from the Graphyard control-plane App');
  const validation = new Validation(engine, principals.map(p => p.actor), repository);
  validation.artifactBackend = artifacts.backend; validation.artifactCapacityBytes = artifacts.capacityBytes;
  const delivery = new Delivery(validation);
  const operatorAgents = new OperatorAgents(engine.store, repository, credentials.map(credential => ({ id: credential.id, tokenHash: createHash('sha256').update(credential.token).digest('hex') })));
  const productionDelivery = new ProductionDelivery(engine.store);
  engine.operatorAuthorizer = operatorAgents.revalidate.bind(operatorAgents);
  // Proof authority is Graphyard state. The configured registry only identifies which
  // principals exist and what role each holds; the grant store decides what they may prove.
  const configured = credentials.map(({ token, ...actor }) => actor);
  engine.principals = configured;
  let services: Services;
  const proofGrants = new SlotCountedProofGrants(engine.store, configured, () => services.limits.maxReviewers, () => refreshDelegationLimits(services, credentials, env, options.knownPrincipals));
  return services = { signinClaim: signinClaimFromEnv(env, credentials), engine, github, repository, principals, limits: delegationLimits.limits, delegationLimits, build: buildIdentity(env), production: options.production ?? null, validation, delivery, operatorAgents, proofGrants, productionDelivery, agentRegistry: new AgentRegistry(engine.store), interventionPolicy: interventionPolicyFromEnv(env), responder: options.responder !== undefined ? options.responder : responderFromEnv(env) };
}
