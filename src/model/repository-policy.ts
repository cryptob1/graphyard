import { z } from 'zod';

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
export type SensitiveEntry = z.infer<typeof sensitiveEntrySchema>;
const declaredEntrySchema = sensitiveEntrySchema.extend({ only: z.enum(['risk', 'lane']).optional() }).strict();
export const pendingOutcomeRules = ['non-blocking', 'blocking'] as const;
/** What a failed release candidate does (GY-1848): `hold` names the failure and reverts nothing; `revert` is the behaviour a repository that declares nothing keeps. */
export const releaseFailureActions = ['revert', 'hold'] as const;
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
export type E2eServe = z.infer<typeof e2eServeSchema>;
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
export type RepositoryPolicyInput = z.infer<typeof repositoryPolicySchema>;
/** The policy in force: every section resolved, the declared one or its default. */
export interface RepositoryPolicy {
  risk: { sensitive: SensitiveEntry[]; declared: boolean };
  e2e: { pendingOutcomes: typeof pendingOutcomeRules[number]; serve: E2eServe | null };
  release: { onFailure: typeof releaseFailureActions[number]; revertUnmatched: boolean };
  product: { ui: string[] } | null;
}

const anywhere = (rule: string, ...globs: string[]) => globs.map(glob => ({ rule, glob }));
/**
 * The sensitive surfaces of a repository that declares none: CI configuration, dependency manifests
 * and lockfiles, database migrations, container and compose files, deploy and infrastructure trees,
 * and files or directories named auth or secrets, wherever they sit in the tree.
 */
export const genericSensitiveRules: readonly SensitiveEntry[] = [
  ...anywhere('CI configuration', '.github/', '.gitlab-ci.yml', '.circleci/', '.buildkite/'),
  ...anywhere('dependencies', '**/package.json', '**/package-lock.json', '**/npm-shrinkwrap.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/bun.lockb',
    '**/requirements*.txt', '**/pyproject.toml', '**/poetry.lock', '**/Pipfile', '**/Pipfile.lock', '**/uv.lock', '**/Cargo.toml', '**/Cargo.lock',
    '**/go.mod', '**/go.sum', '**/Gemfile', '**/Gemfile.lock', '**/composer.json', '**/composer.lock', '**/pom.xml', '**/build.gradle', '**/build.gradle.kts'),
  ...anywhere('migrations', '**/migrations/**', '**/migrate/**'),
  ...anywhere('Dockerfile', '**/Dockerfile*', '**/*.dockerfile', '**/.dockerignore'),
  ...anywhere('compose file', '**/compose.yml', '**/compose.yaml', '**/docker-compose*.yml', '**/docker-compose*.yaml'),
  ...anywhere('deployment', '**/deploy/**', '**/deployment/**'),
  ...anywhere('infrastructure', '**/infra/**', '**/terraform/**', '**/*.tf'),
  ...anywhere('auth', '**/auth/**', '**/auth.*'),
  ...anywhere('secrets', '**/secrets/**', '**/secrets.*', '**/.env*'),
];

export const defaultRepositoryPolicy: RepositoryPolicy = {
  risk: { sensitive: [...genericSensitiveRules], declared: false },
  e2e: { pendingOutcomes: 'non-blocking', serve: null },
  release: { onFailure: 'revert', revertUnmatched: true },
  product: null,
};

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

/** One rule compiled for a reader: its name, the entries' globs and one anchored pattern over them. */
export interface CompiledRule { rule: string; globs: string[]; pattern: RegExp }
const globSource = (pattern: string) => {
  // The documentation glob syntax (documentation-glob.ts), except that a terminal `/*` stays one segment:
  // `config/*` names config's own files, not `config/public/images/logo.svg`; `config/` or `config/**` is the tree.
  const glob = pattern.replace(/^\.\//, '');
  const source = glob.endsWith('/') ? `${glob}**` : glob;
  return source.split(/(\*\*\/?|\*|\?)/).map(part => part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('');
};
/** The rules a policy applies to `use`, grouped by rule name in declaration order. */
export function compiledRules(policy: Pick<RepositoryPolicy, 'risk'>): CompiledRule[] {
  const rules = new Map<string, string[]>();
  for (const entry of policy.risk.sensitive) rules.set(entry.rule, [...(rules.get(entry.rule) ?? []), entry.glob]);
  return [...rules].map(([rule, globs]) => ({ rule, globs, pattern: new RegExp(`^(?:${globs.map(globSource).join('|')})$`) }));
}
/**
 * The literal head of a glob, up to its first wildcard: the surface a directory scope must overlap to
 * possibly hold a match. Empty for a glob that may match anywhere (`**\/auth/**`).
 */
export const globSurface = (pattern: string) => {
  const glob = pattern.replace(/^\.\//, '');
  const wildcard = glob.search(/[*?]/);
  return wildcard < 0 ? glob : glob.slice(0, wildcard);
};

// ---- The policy in force for this process --------------------------------------------------------

/** The deployment variable the control plane reads the policy from, as compact JSON of graphyard.json's `risk`, `e2e` and `release`. */
export const repositoryPolicyVariable = 'GRAPHYARD_REPOSITORY_POLICY' as const;
/** The committed file the policy is read from when the variable is unset. */
const configFile = 'graphyard.json';

type Source = 'environment' | 'graphyard.json' | 'default';
let inForce: { policy: RepositoryPolicy; source: Source } | null = null;

/** The `risk`, `e2e`, `release` and `product` sections of a parsed graphyard.json. */
export const policySections = (config: Record<string, unknown> | null | undefined) =>
  Object.fromEntries(['risk', 'e2e', 'release', 'product'].filter(key => config?.[key] !== undefined).map(key => [key, config![key]]));

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

/** The nearest directory from `start` up holding `.git` (a directory, or a worktree's file); `start` when none does. */
function gitToplevel(fs: any, path: any, start: string): string {
  for (let directory = start; ; directory = path.dirname(directory)) {
    if (fs.existsSync(path.join(directory, '.git'))) return directory;
    if (path.dirname(directory) === directory) return start;
  }
}

/** The policy this process judges every change by, read once (`loadRepositoryPolicy`). */
export const repositoryPolicy = (): RepositoryPolicy => (inForce ??= loadRepositoryPolicy()).policy;
/** Where the policy in force came from, for doctor. */
export const repositoryPolicySource = (): Source => (inForce ??= loadRepositoryPolicy()).source;
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
