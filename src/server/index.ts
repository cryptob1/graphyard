import { createServer, type IncomingMessage } from 'node:http';
import { z } from 'zod';
import type { Engine } from '../engine.js';
import { Refusal, demand, type Principal } from '../model.js';
import { artifactCapacityFromEnv } from '../artifacts.js';
import { Next, Sent, matchRoute, registerApiRoutes, requestFailure, type RouteContext, type RouteModule } from './routes.js';
import { assembleServices, authenticate, configuredActor, confinedLaneProducer, laneProducerScope, operatorAgentRouteGuard, operatorVisible, refreshDelegationLimits, type ArtifactOptions, type ServerOptions } from './auth.js';
import { type Credential } from './principals.js';
import { healthRoutes } from './routes/health.js';
import { signinRoutes } from './routes/signin.js';
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
import { mergeSettingsRoutes } from './routes/merge-settings.js';
import { actionRoutes } from './routes/actions.js';
import { workRoutes } from './routes/work.js';
import { staticRoutes } from './static.js';
export { principalSchema, type Credential } from './principals.js';
export type { ArtifactOptions, ServerOptions } from './auth.js';
export { assembleServices } from './auth.js';

/** Routes that answer without a bearer token. */
export const publicRoutes: readonly RouteModule[] = [healthRoutes, signinRoutes];
/**
 * Every authenticated `/api/` route, in matching order. A resource adds its module here or in
 * routes.ts (`registerApiRoutes`); modules ahead of the operator-agent guard authorize their
 * callers themselves.
 */
export const apiRoutes: readonly RouteModule[] = registerApiRoutes([
  operatorAgentRoutes, proofGrantRoutes,
  { name: 'operator-agent-scope', routes: [operatorAgentRouteGuard] },
  agentRegistryRoutes, delegationRoutes, validationRoutes, deliveryRoutes, shippingPulseRoutes, flowAnalyticsRoutes, attributionRoutes, scenarioRoutes, actionRoutes, statusRoutes, mergeSettingsRoutes, workRoutes,
]);

async function body(req: IncomingMessage, limit = 1_000_000) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; demand(size <= limit, 'Request exceeds size limit', 413); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

export function server(engine: Engine, credentials: Credential[], artifacts: ArtifactOptions | null = null, options: ServerOptions = {}) {
  const artifactOptions: ArtifactOptions = artifacts ?? { backend: null, capacityBytes: artifactCapacityFromEnv() };
  const services = assembleServices(engine, credentials, artifactOptions, options);
  // Reviewer slots counted from the grant store once it can be read; status reports it as soon as it lands.
  const delegationReady = refreshDelegationLimits(services, credentials, options.env ?? process.env, options.knownPrincipals)
    .catch(error => console.error('Delegation limits could not be recounted from recorded proof grants:', error instanceof Error ? error.message : 'unknown'));
  const unauthenticated: Principal = { id: '', role: 'reader' };
  // The services ride on the server so the entry announces decisions without reassembling.
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
      // A lane-only producer's credential is held to its lane before any public /api/ handler runs (GY-1879):
      // sign-in and claim answer it with the lane refusal, while an unauthenticated request reaches them as before.
      // Effective authority (grant store over the env seed) decides confinement, matching the authenticated guard.
      const lane = url.pathname.startsWith('/api/') ? configuredActor(services, req.headers.authorization) : null;
      if (!(lane && await confinedLaneProducer(services, lane)) && await dispatch(publicRoutes)) return;
      if (url.pathname.startsWith('/api/')) {
        context.actor = await authenticate(services, req.headers.authorization, services.repository, req.method, url.pathname);
        if (await dispatch([laneProducerScope, ...apiRoutes])) return;
        return send(404, { error: 'Route not found' });
      }
      await dispatch([staticRoutes]);
    } catch (error) {
      if (error instanceof Refusal) return send(error.status, { ...error.details, error: error.message });
      if (error instanceof z.ZodError) return send(400, { error: 'Invalid input', issues: error.issues });
      if (error instanceof SyntaxError || error instanceof URIError) return send(400, { error: 'Malformed request' });
      console.error(requestFailure(req.method, req.url, error));
      send(500, { error: 'Internal error; consult server logs' });
    }
  }), { services, delegationReady });
}
