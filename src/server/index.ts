import { createServer, type IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Engine } from '../engine.js';
import { Refusal, demand, type Principal } from '../model.js';
import type { GitHub } from '../github.js';
import { Validation } from '../validation.js';
import { Delivery } from '../delivery.js';
import { OperatorAgents } from '../operator-agent.js';
import { assembleDelegationLimits } from './limits.js';
import { ProofGrants } from '../proof-grants.js';
import { AgentRegistry } from '../agent-registry.js';
import { ProductionDelivery } from '../production-delivery.js';
import { artifactCapacityFromEnv, type ArtifactBackend } from '../artifacts.js';
import { buildIdentity } from '../protocol-version.js';
import type { ProductionWatch } from '../production-watch.js';
import { responderFromEnv, type Responder } from '../closed-question.js';
import { Next, Sent, matchRoute, requestFailure, type RouteContext, type RouteModule, type Services } from './routes.js';
import { authenticate, operatorAgentRouteGuard, operatorVisible } from './auth.js';
import type { Credential } from './principals.js';
import { healthRoutes } from './routes/health.js';
import { githubRoutes } from './routes/github.js';
import { operatorAgentRoutes } from './routes/operator-agents.js';
import { proofGrantRoutes } from './routes/proof-grants.js';
import { agentRegistryRoutes } from './routes/agent-registry.js';
import { delegationRoutes } from './routes/delegation.js';
import { validationRoutes } from './routes/validation.js';
import { deliveryRoutes } from './routes/delivery.js';
import { scenarioRoutes } from './routes/scenarios.js';
import { shippingPulseRoutes } from './routes/shipping-pulse.js';
import { flowAnalyticsRoutes } from './routes/flow-analytics.js';
import { attributionRoutes } from './routes/attribution.js';
import { statusRoutes } from './routes/status.js';
import { actionRoutes } from './routes/actions.js';
import { workRoutes } from './routes/work.js';
import { interventionPolicyFromEnv, interventionRoutes } from './routes/interventions.js';
import { staticRoutes } from './static.js';

export { principalSchema, type Credential } from './principals.js';

/** Routes that answer without a bearer token. */
export const publicRoutes: readonly RouteModule[] = [healthRoutes, githubRoutes];
/**
 * Every authenticated `/api/` route, in matching order. A resource adds its module here;
 * the identity-administration modules precede the operator-agent guard because they
 * authorize their callers themselves.
 */
export const apiRoutes: readonly RouteModule[] = [
  operatorAgentRoutes, proofGrantRoutes,
  { name: 'operator-agent-scope', routes: [operatorAgentRouteGuard] },
  agentRegistryRoutes, delegationRoutes, validationRoutes, deliveryRoutes, shippingPulseRoutes, flowAnalyticsRoutes, attributionRoutes, scenarioRoutes, interventionRoutes, actionRoutes, statusRoutes, workRoutes,
];

async function body(req: IncomingMessage, limit = 1_000_000) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; demand(size <= limit, 'Request exceeds size limit', 413); chunks.push(chunk); }
  return Buffer.concat(chunks);
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
  // The engine is constructed with the repository this control plane is authorized to coordinate.
  // GITHUB_REPOSITORY is merely a process default (automatically set to the CI checkout), so it
  // must not override an explicit engine binding or scope validation becomes environment-dependent.
  const repository = engine.repository || github?.config.repository || process.env.GITHUB_REPOSITORY || '';
  demand(!engine.repository || !github || engine.repository.toLowerCase() === github.config.repository.toLowerCase(),
    'Engine and GitHub repositories must match');
  // Keep mutation authorization on the same canonical repository binding used
  // by authentication and operator-agent administration. Some embedders pass
  // the repository only through their GitHub adapter.
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
  const proofGrants = new ProofGrants(engine.store, configured);
  return { engine, github, repository, principals, limits: delegationLimits.limits, delegationLimits, build: buildIdentity(env), production: options.production ?? null, validation, delivery, operatorAgents, proofGrants, productionDelivery, agentRegistry: new AgentRegistry(engine.store), interventionPolicy: interventionPolicyFromEnv(env), responder: options.responder !== undefined ? options.responder : responderFromEnv(env) };
}

export function server(engine: Engine, credentials: Credential[], github: GitHub | null = null, artifacts: ArtifactOptions = { backend: null, capacityBytes: artifactCapacityFromEnv() }, options: ServerOptions = {}) {
  const services = assembleServices(engine, credentials, github, artifacts, options);
  const unauthenticated: Principal = { id: '', role: 'reader' };
  // The assembled services ride on the server so the process entry can announce what they
  // decided (limit drift, build identity) without assembling them twice.
  return Object.assign(createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; img-src 'self' data:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('Cache-Control', 'no-store');
    const send = (status: number, data: unknown): typeof Sent => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); return Sent; };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const context: RouteContext = {
        req, res, url, actor: unauthenticated, services, send,
        body: limit => body(req, limit),
        idempotencyKey: () => String(req.headers['idempotency-key'] ?? ''),
        operatorVisible: items => operatorVisible(context.actor, items),
      };
      const dispatch = async (modules: readonly RouteModule[]) => {
        for (const module of modules) for (const route of module.routes) {
          const params = matchRoute(route, req.method, url.pathname);
          if (!params) continue;
          const result = await route.handle(context, params);
          if (result === Next) continue;
          if (result !== Sent) send(200, result);
          return true;
        }
        return false;
      };
      if (await dispatch(publicRoutes)) return;
      if (url.pathname.startsWith('/api/')) {
        context.actor = await authenticate(services, req.headers.authorization, services.repository);
        if (await dispatch(apiRoutes)) return;
        return send(404, { error: 'Route not found' });
      }
      await dispatch([staticRoutes]);
    } catch (error) {
      if (error instanceof Refusal) return send(error.status, { error: error.message });
      if (error instanceof z.ZodError) return send(400, { error: 'Invalid input', issues: error.issues });
      if (error instanceof SyntaxError || error instanceof URIError) return send(400, { error: 'Malformed request' });
      console.error(requestFailure(req.method, req.url, error));
      send(500, { error: 'Internal error; consult server logs' });
    }
  }), { services });
}
