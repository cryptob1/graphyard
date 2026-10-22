import type pg from 'pg';

/**
 * The deployment-provider environment whose successful deployments count as production. Providers
 * name environments freely, so the name is configuration, not a guess.
 */
export const defaultProductionEnvironment = 'production';
export function productionEnvironmentFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.GRAPHYARD_PRODUCTION_ENVIRONMENT;
  if (raw === undefined) return defaultProductionEnvironment;
  const value = raw.trim();
  if (!value || value.length > 100) throw new Error('GRAPHYARD_PRODUCTION_ENVIRONMENT must name a deployment-provider environment (1-100 characters)');
  return value;
}

/**
 * The installation ledger entry (an event with no work item) in which the master loop publishes
 * the production environment it verifies deployments under, so the control plane learns it.
 */
export const productionEnvironmentEvent = 'production.environment';
export const productionEnvironmentName = (value: unknown) => typeof value === 'string' && value.trim() && value.trim().length <= 100 ? value.trim() : null;

/** The production environment every read uses: the master's latest publication, else this process's own setting. */
export async function resolvedProductionEnvironment(pool: pg.Pool, env: NodeJS.ProcessEnv = process.env) {
  const row = (await pool.query('SELECT payload->>\'environment\' AS environment FROM events WHERE work_id IS NULL AND kind=$1 ORDER BY seq DESC LIMIT 1', [productionEnvironmentEvent])).rows[0];
  return productionEnvironmentName(row?.environment) ?? productionEnvironmentFromEnv(env);
}
