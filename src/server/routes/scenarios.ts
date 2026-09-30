import { defineScenario, scenarios } from '../../scenarios.js';
import { runHistory, testSummary } from '../../test-runs.js';
import { defineRoutes, parseJson } from '../routes.js';

/**
 * The versioned E2E test-case registry, and its run history (GY-162): every case with its latest
 * result, and one case's runs paged by sequence. Runs are written only by the evidence command and
 * the validation collector, never through a route of their own. Operator agents are refused here
 * by the route guard, as they are for the registry itself.
 */
export const scenarioRoutes = defineRoutes('scenarios', [
  { method: 'GET', path: '/api/scenarios', handle: ({ services }) => scenarios(services.engine.store) },
  { method: 'POST', path: '/api/scenarios', handle: async context => defineScenario(context.services.engine.store, context.actor, await parseJson(context), context.idempotencyKey()) },
  { method: 'GET', path: '/api/tests', handle: ({ services }) => testSummary(services.engine.store.pool) },
  { method: 'GET', path: /^\/api\/tests\/([^/]+)\/runs$/, handle: ({ services, url }, [id]) => runHistory(services.engine.store.pool, decodeURIComponent(id), url.searchParams) },
]);
