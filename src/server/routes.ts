import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Engine } from '../engine.js';
import type { GitHub } from '../github.js';
import type { Validation } from '../validation.js';
import type { Delivery } from '../delivery.js';
import type { OperatorAgents } from '../operator-agent.js';
import type { ProofGrants } from '../proof-grants.js';
import type { AgentRegistry } from '../agent-registry.js';
import type { ProductionDelivery } from '../production-delivery.js';
import type { delegationLimits } from '../delegation.js';
import type { DelegationLimitReport } from './limits.js';
import type { BuildIdentity } from '../protocol-version.js';
import type { ProductionWatch } from '../production-watch.js';
import type { Principal } from '../model.js';
import type { Responder } from '../closed-question.js';

/** Everything the assembled control plane owns, handed to every route. */
export interface Services {
  engine: Engine; github: GitHub | null; repository: string;
  principals: { actor: Principal; hash: Buffer }[];
  limits: ReturnType<typeof delegationLimits>;
  /** The limits in force, the deployed variables, and every way they fail to cover the roster. */
  delegationLimits: DelegationLimitReport;
  /** The commit this build runs and the merge protocol it speaks. */
  build: BuildIdentity;
  /** Production deployment observation, when the process hosts one. */
  production: ProductionWatch | null;
  validation: Validation; delivery: Delivery; operatorAgents: OperatorAgents; proofGrants: ProofGrants; productionDelivery: ProductionDelivery;
  /** The fleet: runtimes, accounts, models and roles, and the sessions chosen from them. */
  agentRegistry: AgentRegistry;
  /** The closed-question responder (GY-109), or null when none is configured and every such proof takes its ordinary path. */
  responder: Responder | null;
}

/** The response was written by the handler itself (raw bytes, or a status other than 200). */
export const Sent: unique symbol = Symbol('sent');
/** The handler declined; matching continues with the next route in the table. */
export const Next: unique symbol = Symbol('next');

export interface RouteContext {
  req: IncomingMessage; res: ServerResponse; url: URL;
  /** The authenticated principal; public routes see a placeholder that authorizes nothing. */
  actor: Principal;
  services: Services;
  /** The request body, refused with 413 above `limit` bytes. */
  body(limit?: number): Promise<Buffer>;
  idempotencyKey(): string;
  send(status: number, data: unknown): typeof Sent;
  /** Items the actor may read: everything, or an operator-agent's scoped subset. */
  operatorVisible<T extends { id: string; key: string }>(items: T[]): T[];
}

/**
 * One HTTP route. A string path matches the pathname exactly; a regular expression's
 * capture groups arrive as `params`. The handler's return value is sent as a 200 JSON body
 * unless it is `Sent` (already written) or `Next` (pass the request on).
 */
export interface Route {
  method: 'GET' | 'POST' | '*';
  path: string | RegExp;
  handle(context: RouteContext, params: string[]): Promise<unknown>;
}

/** A resource's routes. The index lists modules in the order they are matched. */
export interface RouteModule { name: string; routes: Route[] }

export const defineRoutes = (name: string, routes: Route[]): RouteModule => ({ name, routes });

/** Match one route against a request; `null` when it does not apply. */
export function matchRoute(route: Route, method: string | undefined, pathname: string): string[] | null {
  if (route.method !== '*' && route.method !== method) return null;
  if (typeof route.path === 'string') return route.path === pathname ? [] : null;
  const match = pathname.match(route.path);
  return match ? match.slice(1) : null;
}

/** Parse a JSON body; `fallback` stands in for an empty body where a route accepts one. */
export const parseJson = async (context: RouteContext, limit?: number, fallback = '') => JSON.parse((await context.body(limit)).toString() || fallback);
