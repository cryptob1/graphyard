import { defineScenario, recordCaseRun, scenarios, trackedCases } from '../../scenarios.js';
import { runHistory } from '../../test-runs.js';
import { defineRoutes, parseJson } from '../routes.js';

/**
 * The versioned E2E test-case registry, and its run history (GY-162): every case with its latest
 * result, and one case's runs paged by sequence. Trusted evidence runs are written only by the
 * evidence command and the validation collector; the one run route appends an operator's
 * `graphyard e2e run` of a repository case (GY-1351) to the revision it measured. The summary reads
 * at most `historyWindow` runs per case, and older runs page. Operator agents are refused here by
 * the route guard, as they are for the registry itself.
 */
export const scenarioRoutes = defineRoutes('scenarios', [
  { method: 'GET', path: '/api/scenarios', handle: ({ services }) => scenarios(services.engine.store) },
  { method: 'POST', path: '/api/scenarios', handle: async context => defineScenario(context.services.engine.store, context.actor, await parseJson(context), context.idempotencyKey()) },
  { method: 'POST', path: /^\/api\/scenarios\/([^/]+)\/runs$/, handle: async (context, [id]) => recordCaseRun(context.services.engine.store, context.actor, decodeURIComponent(id), await parseJson(context)) },
  { method: 'GET', path: '/api/tests', handle: ({ services }) => trackedCases(services.engine.store.pool) },
  { method: 'GET', path: /^\/api\/tests\/([^/]+)\/runs$/, handle: ({ services, url }, [id]) => runHistory(services.engine.store.pool, decodeURIComponent(id), url.searchParams) },
]);
