import { defineScenario, scenarios } from '../../scenarios.js';
import { defineRoutes, parseJson } from '../routes.js';

/** The versioned E2E test-case registry. */
export const scenarioRoutes = defineRoutes('scenarios', [
  { method: 'GET', path: '/api/scenarios', handle: ({ services }) => scenarios(services.engine.store) },
  { method: 'POST', path: '/api/scenarios', handle: async context => defineScenario(context.services.engine.store, context.actor, await parseJson(context), context.idempotencyKey()) },
]);
