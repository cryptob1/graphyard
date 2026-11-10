import type { GitHubCli } from './github.js';
import type { PreflightItem } from './types.js';

/**
 * GY-3219: an organization may disable deploy keys for its repositories, which fails the install's
 * `github.deploy-key` step with a 422 after other provisioning has run. Read the org setting with the
 * host's gh login first; a personal repository, a login that cannot read it, or an absent field passes.
 */
export async function orgDeployKeysPreflight(gh: GitHubCli, repository: string): Promise<PreflightItem | null> {
  const org = repository.split('/')[0];
  let enabled: unknown;
  try { enabled = JSON.parse((await gh(['api', `orgs/${org}`], { allowFailure: true })).stdout).deploy_keys_enabled_for_repositories; } catch { return null; }
  if (enabled !== false) return null;
  return { name: 'Organization deploy keys', ok: false, detail: `the ${org} organization disables deploy keys for repositories (deploy_keys_enabled_for_repositories=false), and the merge writer pushes ${repository} with a deploy key`, fix: `HUMAN: an owner of ${org} enables deploy keys under Organization settings → Member privileges → Deploy keys, then rerun; or use the repository-scoped token instead of a deploy key once it is available` };
}
