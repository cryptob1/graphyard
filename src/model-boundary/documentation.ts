import { z } from 'zod';
import { deliveryPolicySchema } from './delivery-policy.js';
import { repositoryPolicySchema } from './repository-policy.js';
import { type RepositoryConfig, repositoryConfigFile } from '../model/documentation.js';
/**
 * The whole committed file: delivery, and the repository's own risk, review and E2E policy
 * (model/repository-policy.ts, GY-1843). A `documentation` policy written before GY-2875 is ignored.
 * `app.healthUrl` (GY-3452) is where an install that deploys elsewhere answers its live commit.
 */
export const repositoryConfigSchema = z.object({
  documentation: z.unknown().optional(),
  delivery: deliveryPolicySchema.optional(),
  app: z.object({ healthUrl: z.url().max(500) }).strict().optional(),
  ...repositoryPolicySchema.shape,
}).strict();

/** The policy a committed `graphyard.json` declares; refuses a file that does not parse. */
export function parseRepositoryConfig(text: string): RepositoryConfig {
  let value: unknown;
  try { value = JSON.parse(text); } catch (error: any) { throw new Error(`${repositoryConfigFile} is not JSON: ${error.message}`); }
  return repositoryConfigSchema.parse(value);
}
