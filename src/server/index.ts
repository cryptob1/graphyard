import { createServer, type IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Engine } from '../engine.js';
import { Refusal, demand, type Principal } from '../model.js';
import type { GitHub } from '../github.js';
import { Validation } from '../validation.js';
import { Delivery } from '../delivery.js';
import { OperatorAgents } from '../operator-agent.js';
import { delegationLimits, validateDelegationPrincipals } from '../delegation.js';
import { ProofGrants } from '../proof-grants.js';
import { ProductionDelivery } from '../production-delivery.js';
import { artifactCapacityFromEnv, type ArtifactBackend } from '../artifacts.js';
import { Next, Sent, matchRoute, type RouteContext, type RouteModule, type Services } from './routes.js';
import { authenticate, operatorAgentRouteGuard, operatorVisible } from './auth.js';
import { healthRoutes } from './routes/health.js';
import { githubRoutes } from './routes/github.js';
import { operatorAgentRoutes } from './routes/operator-agents.js';
import { proofGrantRoutes } from './routes/proof-grants.js';
import { delegationRoutes } from './routes/delegation.js';
import { validationRoutes } from './routes/validation.js';
import { deliveryRoutes } from './routes/delivery.js';
import { scenarioRoutes } from './routes/scenarios.js';
import { shippingPulseRoutes } from './routes/shipping-pulse.js';
import { flowAnalyticsRoutes } from './routes/flow-analytics.js';
import { attributionRoutes } from './routes/attribution.js';
import { statusRoutes } from './routes/status.js';
import { workRoutes } from './routes/work.js';
import { staticRoutes } from './static.js';

export const principalSchema = z.array(z.object({ id: z.string().min(1), role: z.enum(['admin', 'coordinator', 'slice-lead', 'worker', 'producer', 'reader']), token: z.string().min(32), proofs: z.array(z.string()).optional(), deploymentProviders: z.array(z.string().trim().min(1).max(40)).max(20).optional(), displayName: z.string().trim().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]+$/).optional(), runtime: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/).optional(), slice: z.enum(['product', 'infrastructure', 'docs-experience']).optional(), sessionKind: z.enum(['human', 'ai']).optional() }).strict()).min(1);
export type Credential = Principal & { token: string };

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
  delegationRoutes, validationRoutes, deliveryRoutes, shippingPulseRoutes, flowAnalyticsRoutes, attributionRoutes, scenarioRoutes, statusRoutes, workRoutes,
];

async function body(req: IncomingMessage, limit = 1_000_000) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; demand(size <= limit, 'Request exceeds size limit', 413); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

/** Wire the engine, its integrations and the configured principals into the shared services. */
/** Where retained validation artifacts live and how much the postgres backend may hold. */
export interface ArtifactOptions { backend: ArtifactBackend | null; capacityBytes: number }

export function assembleServices(engine: Engine, credentials: Credential[], github: GitHub | null, artifacts: ArtifactOptions = { backend: null, capacityBytes: artifactCapacityFromEnv() }): Services {
  const limits = delegationLimits();
  validateDelegationPrincipals(credentials, limits);
  const principals = credentials.map(({ token, ...actor }) => ({ actor, hash: createHash('sha256').update(token).digest() }));
  // The engine is constructed with the repository that this control plane is
  // authorized to coordinate.  GITHUB_REPOSITORY is merely a process default
  // (and is automatically set to the CI checkout), so it must not override an
  // explicit engine binding or scope validation becomes environment-dependent.
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
  return { engine, github, repository, principals, limits, validation, delivery, operatorAgents, proofGrants, productionDelivery };
}

export function server(engine: Engine, credentials: Credential[], github: GitHub | null = null, artifacts: ArtifactOptions = { backend: null, capacityBytes: artifactCapacityFromEnv() }) {
  const services = assembleServices(engine, credentials, github, artifacts);
  const unauthenticated: Principal = { id: '', role: 'reader' };
  return createServer(async (req, res) => {
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
      console.error('request failed', error instanceof Error ? error.message : 'unknown');
      send(500, { error: 'Internal error; consult server logs' });
    }
  });
}
