import { z } from 'zod';
import { pendingOutcomeRules, releaseFailureActions, type RepositoryPolicy, defaultRepositoryPolicy, type Source, policySections, repositoryPolicyVariable, gitToplevel, configFile } from '../model/repository-policy.js';
// ---- Per-repository policy (GY-1843) -------------------------------------------------------------

/**
 * What a repository declares about its own changes in `graphyard.json`, beside its documentation and
 * delivery policy: which paths are sensitive (`risk.sensitive`), whether a required E2E case bound to an outcome not yet
 * delivered blocks (`e2e.pendingOutcomes`), and what a failed release candidate does
 * (`release.onFailure`, `release.revertUnmatched`). Nothing here names Graphyard's own layout: a
 * repository that declares no `risk` gets `genericSensitiveRules`, common sensitive surfaces
 * anywhere in a tree, and Graphyard's own graphyard.json declares its list like any other repository.
 *
 * A sensitive entry is one glob (documentation-glob syntax: `dir/` a tree, `*` within a segment,
 * `**` across segments) and the rule a reason cites; several entries may share a rule.
 *
 * Retired keys a policy written before GY-2876 still carries parse and are dropped: `review` and an
 * entry's `only`, whose `lane` entries only ever counted for the retired lanes, never for review.
 */
const glob = z.string().trim().min(1).max(200)
  .refine(path => !path.startsWith('/') && !path.split('/').some(segment => segment === '..' || segment === '.') && !/[\s\u0000-\u001f]/.test(path), 'Sensitive paths are repository-relative globs without . or .. segments or whitespace');
export const sensitiveEntrySchema = z.object({ rule: z.string().trim().min(1).max(120), glob }).strict();
const declaredEntrySchema = sensitiveEntrySchema.extend({ only: z.enum(['risk', 'lane']).optional() }).strict();
/**
 * GY-2965: how a head is served for end-to-end runs in the merge writer's trial — `command` run in
 * the trial checkout until `url` answers, waited for at most `readySeconds`. A repository that
 * already declares a previewable application (delivery.applications) needs no `serve`: the trial
 * serves that application the way a preview does.
 */
export const e2eServeSchema = z.object({
  command: z.string().trim().min(1).max(500),
  url: z.url().max(200),
  readySeconds: z.number().int().min(1).max(600),
}).strict();
export const repositoryPolicySchema = z.object({
  risk: z.object({ sensitive: z.array(declaredEntrySchema).min(1).max(200) }).strict().optional(),
  review: z.unknown().optional(),
  e2e: z.object({ pendingOutcomes: z.enum(pendingOutcomeRules).optional(), serve: e2eServeSchema.optional() }).strict().optional(),
  release: z.object({ onFailure: z.enum(releaseFailureActions).optional(), revertUnmatched: z.boolean().optional() }).strict().optional(),
  // GY-2989: the paths whose change is user-facing, so a product review of one head carries to a
  // later one only when nothing here changed between them. A repository that declares none reviews
  // every new head afresh.
  product: z.object({ ui: z.array(glob).min(1).max(200) }).strict().optional(),
}).strict();

/** The policy in force for a declaration: each section it declares, every other section's default. */
export function resolveRepositoryPolicy(input: unknown): RepositoryPolicy {
  const declared = repositoryPolicySchema.parse(input ?? {});
  return {
    risk: declared.risk ? { sensitive: declared.risk.sensitive.filter(entry => entry.only !== 'lane').map(({ rule, glob }) => ({ rule, glob })), declared: true } : defaultRepositoryPolicy.risk,
    e2e: {
      pendingOutcomes: declared.e2e?.pendingOutcomes ?? defaultRepositoryPolicy.e2e.pendingOutcomes,
      serve: declared.e2e?.serve ?? null,
    },
    release: {
      onFailure: declared.release?.onFailure ?? defaultRepositoryPolicy.release.onFailure,
      revertUnmatched: declared.release?.revertUnmatched ?? defaultRepositoryPolicy.release.revertUnmatched,
    },
    product: declared.product ?? null,
  };
}
let inForce: { policy: RepositoryPolicy; source: Source } | null = null;

/**
 * The deployment value an installer sets from a parsed graphyard.json (null when the repository has
 * none): compact JSON of its `risk`, `e2e` and `release` sections, `{}` when it declares none, so a
 * redeploy also clears a declaration since removed. The runtime image carries no repository, so this
 * variable is how the deployed control plane judges changes by the committed policy. Refuses a
 * declaration the control plane would refuse.
 */
export function repositoryPolicyAssignment(config: Record<string, unknown> | null) {
  const sections = policySections(config);
  repositoryPolicySchema.parse(sections);
  const value = JSON.stringify(sections);
  return { variable: repositoryPolicyVariable, value, line: `${repositoryPolicyVariable}=${value}` };
}

/**
 * Reads the policy a process serves: GRAPHYARD_REPOSITORY_POLICY when set (the control plane's
 * deployment, whose image carries no repository), else the graphyard.json at the root of the managed
 * checkout (the CLI, loop, coordinator and E2E runner all run in it), else the default. The root is
 * `root` when given, else GRAPHYARD_REPOSITORY_ROOT, else the Git toplevel holding `cwd` (the nearest
 * directory with a `.git`), the same root the CLI's commands resolve, so a launch from a
 * subdirectory reads the root's declaration. A value or file that does not parse refuses, rather than
 * silently judging every change by the default. Browser-safe: with no process, the default.
 */
export function loadRepositoryPolicy(env?: Record<string, string | undefined>, root?: string, cwd?: string): { policy: RepositoryPolicy; source: Source } {
  const host = (globalThis as { process?: { env: Record<string, string | undefined>; cwd(): string; getBuiltinModule?(name: string): any } }).process;
  const variables = env ?? host?.env;
  const raw = variables?.[repositoryPolicyVariable]?.trim();
  if (raw) {
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error(`${repositoryPolicyVariable} must be JSON of graphyard.json's risk, e2e and release sections, e.g. {"e2e":{"pendingOutcomes":"blocking"}}`); }
    return { policy: resolveRepositoryPolicy(value), source: 'environment' };
  }
  const fs = host?.getBuiltinModule?.('node:fs'), path = host?.getBuiltinModule?.('node:path');
  if (!fs || !path) return { policy: defaultRepositoryPolicy, source: 'default' };
  let text: string;
  const checkout = root ?? (variables?.GRAPHYARD_REPOSITORY_ROOT?.trim() ? path.resolve(variables.GRAPHYARD_REPOSITORY_ROOT.trim()) : gitToplevel(fs, path, path.resolve(cwd ?? host!.cwd())));
  try { text = fs.readFileSync(path.resolve(checkout, configFile), 'utf8'); } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { policy: defaultRepositoryPolicy, source: 'default' };
    throw error;
  }
  let config: unknown;
  try { config = JSON.parse(text); } catch (error: any) { throw new Error(`${configFile} is not JSON: ${error.message}`); }
  return { policy: resolveRepositoryPolicy(policySections(config as Record<string, unknown>)), source: 'graphyard.json' };
}

/**
 * The policy a checkout itself declares, read from its own graphyard.json and never from the
 * process's GRAPHYARD_REPOSITORY_POLICY: a release candidate's checkout at its exact SHA is the
 * policy that candidate is validated under, though the plane validating it was installed with
 * another (an older declaration, or Graphyard's own).
 */
export const checkoutRepositoryPolicy = (root: string): RepositoryPolicy => loadRepositoryPolicy({}, root).policy;

/** The policy this process judges every change by, read once (`loadRepositoryPolicy`). */
export const repositoryPolicy = (): RepositoryPolicy => (inForce ??= loadRepositoryPolicy()).policy;
/** Replaces the policy in force (a test, or a host that reads it elsewhere); null reads it again on next use. */
export function setRepositoryPolicy(policy: RepositoryPolicy | null, source: Source = 'graphyard.json') {
  inForce = policy ? { policy, source } : null;
}

/** What doctor prints of the policy in force at `root`: its sensitive rules, pending-outcome rule, release failure action and source. */
export function doctorRepositoryPolicy(root: string) {
  try {
    const { policy, source } = loadRepositoryPolicy(undefined, root);
    return { source, sensitive: policy.risk.declared ? policy.risk.sensitive : 'generic default', e2e: policy.e2e, release: policy.release, variable: repositoryPolicyVariable };
  } catch (error: any) { return { error: error.message as string }; }
}
