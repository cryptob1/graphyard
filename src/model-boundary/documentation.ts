import { z } from 'zod';
import { deliveryPolicySchema } from './delivery-policy.js';
import { repositoryPolicySchema } from './repository-policy.js';
import { type RepositoryConfig, repositoryConfigFile } from '../model/documentation.js';
/**
 * The whole committed file: delivery, and the repository's own risk, review and E2E policy
 * (model/repository-policy.ts, GY-1843). A `documentation` policy written before GY-2875 is ignored.
 */
const featureMap = z.array(z.object({
  name: z.string().trim().min(1),
  url: z.string().regex(/^\/(?!\/)/).optional(),
  command: z.string().trim().min(1).optional(),
  traps: z.array(z.string()),
}).strict().refine(feature => !!(feature.url || feature.command), 'A feature needs a URL path or command')).min(1);
export const repositoryConfigSchema = z.object({ featureMap: featureMap.optional(), documentation: z.unknown().optional(), delivery: deliveryPolicySchema.optional(), ...repositoryPolicySchema.shape }).strict();

/** The policy a committed `graphyard.json` declares; refuses a file that does not parse. */
export function parseRepositoryConfig(text: string): RepositoryConfig {
  let value: unknown;
  try { value = JSON.parse(text); } catch (error: any) { throw new Error(`${repositoryConfigFile} is not JSON: ${error.message}`); }
  return repositoryConfigSchema.parse(value);
}
