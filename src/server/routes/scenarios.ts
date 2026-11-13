import { defineScenario, recordCaseRun, scenarios, trackedCases } from '../../scenarios.js';
import { runHistory } from '../../test-runs.js';
import { caseDirectory } from '../../e2e/case.js';
import type { Engine } from '../../engine.js';
import { gitRunnerFor } from '../../merge-writer/local-observation.js';
import { defineRoutes, parseJson } from '../routes.js';

/** The case ids with a file under e2e/cases/ on the base branch the checkout serves, or null with no checkout to read (GY-3278). */
async function mainCases(engine: Engine): Promise<Set<string> | null> {
  if (engine.gitRunner === undefined) engine.gitRunner = gitRunnerFor(process.env.GRAPHYARD_REPOSITORY_ROOT ?? process.cwd());
  if (!engine.gitRunner) return null;
  const listed = await engine.gitRunner(['ls-tree', '--name-only', `refs/remotes/origin/${engine.baseBranch}`, `${caseDirectory}/`]);
  if (listed.status !== 0) return null;
  return new Set(listed.stdout.split('\n').filter(name => name.endsWith('.json')).map(name => name.slice(caseDirectory.length + 1, -'.json'.length)));
}

/**
 * The versioned E2E test-case registry, and its run history (GY-162): every case with its latest
 * result, and one case's runs paged by sequence. Trusted evidence runs are written only by the
 * evidence command and the validation collector; the one run route appends an operator's
 * `graphyard e2e run` of a repository case (GY-1351) to the revision it measured. The summary reads
 * at most `historyWindow` runs per case, and older runs page. Operator agents are refused here by
 * the route guard, as they are for the registry itself.
 */
export const scenarioRoutes = defineRoutes('scenarios', [
  { method: 'GET', path: '/api/scenarios', handle: ({ services }) => scenarios(services.engine.store, services.repository) },
  { method: 'POST', path: '/api/scenarios', handle: async context => defineScenario(context.services.engine.store, context.actor, await parseJson(context), context.idempotencyKey(), context.services.engine.operatorAuthorizer) },
  { method: 'POST', path: /^\/api\/scenarios\/([^/]+)\/runs$/, handle: async (context, [id]) => recordCaseRun(context.services.engine.store, context.actor, decodeURIComponent(id), await parseJson(context), context.services.engine.operatorAuthorizer, context.services.repository) },
  { method: 'GET', path: '/api/tests', handle: async ({ services }) => trackedCases(services.engine.store.pool, services.repository, await mainCases(services.engine)) },
  { method: 'GET', path: /^\/api\/tests\/([^/]+)\/runs$/, handle: ({ services, url }, [id]) => runHistory(services.engine.store.pool, decodeURIComponent(id), url.searchParams) },
]);
