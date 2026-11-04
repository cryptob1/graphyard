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
