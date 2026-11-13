import { createServer, type IncomingMessage } from 'node:http';
import { z } from 'zod';
import type { Engine } from '../engine.js';
import { Refusal, demand, type Principal } from '../model.js';
import { Next, Sent, matchRoute, requestFailure, type RouteContext, type RouteModule } from './routes.js';
import { assembleServices, authenticate, configuredActor, confinedLaneProducer, laneProducerScope, localRead, operatorAgentRouteGuard, operatorVisible, type ServerOptions } from './auth.js';
import { type Credential } from './principals.js';
import { loopStateRoutes } from './routes/loop-state.js';
import { productBriefRoutes } from './routes/product-brief.js';
import { healthRoutes } from './routes/health.js';
import { signinRoutes } from './routes/signin.js';
import { operatorAgentRoutes } from './routes/operator-agents.js';
import { agentRegistryRoutes } from './routes/agent-registry.js';
import { delegationRoutes } from './routes/delegation.js';
import { validationRoutes } from './routes/validation.js';
import { deliveryRoutes } from './routes/delivery.js';
import { scenarioRoutes } from './routes/scenarios.js';
import { statusRoutes } from './routes/status.js';
import { actionRoutes } from './routes/actions.js';
import { workRoutes } from './routes/work.js';
import { staticRoutes } from './static.js';
import { terminalUpgrade } from './terminal.js';
export { principalSchema, type Credential } from './principals.js';
export type { ServerOptions } from './auth.js';
export { assembleServices } from './auth.js';

/** Routes that answer without a bearer token. */
export const publicRoutes: readonly RouteModule[] = [healthRoutes, signinRoutes];
/**
 * Every authenticated `/api/` route, in matching order. A resource adds its module here;
 * modules ahead of the operator-agent guard authorize their callers themselves.
 */
export const apiRoutes: readonly RouteModule[] = [
  operatorAgentRoutes,
  { name: 'operator-agent-scope', routes: [operatorAgentRouteGuard] },
  loopStateRoutes, agentRegistryRoutes, delegationRoutes, validationRoutes, deliveryRoutes, scenarioRoutes, actionRoutes, statusRoutes, workRoutes, productBriefRoutes,
];

async function body(req: IncomingMessage, limit = 1_000_000) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; demand(size <= limit, 'Request exceeds size limit', 413); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

export function server(engine: Engine, credentials: Credential[], options: ServerOptions = {}) {
  const services = assembleServices(engine, credentials, options);
  const unauthenticated: Principal = { id: '', role: 'reader' };
  // The services ride on the server so the entry announces decisions without reassembling.
  const http = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // The Master page's terminal (GY-3211) loads pinned xterm.js from jsdelivr and sizes and colours its grid with <style> elements.
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data:; script-src 'self' https://cdn.jsdelivr.net; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
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
      const lane = url.pathname.startsWith('/api/') ? configuredActor(services, req.headers.authorization) : null;
      if (!(lane && confinedLaneProducer(lane)) && await dispatch(publicRoutes)) return;
      if (url.pathname.startsWith('/api/')) {
        context.actor = await authenticate(services, req.headers.authorization, services.repository, req.method, url.pathname, localRead(req));
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
  });
  // The Master page's live terminal (GY-3211) is the one WebSocket.
  http.on('upgrade', (req, socket) => { terminalUpgrade(services, req, socket).catch(error => { console.error(requestFailure(req.method, req.url, error)); socket.destroy(); }); });
  return Object.assign(http, { services });
}
