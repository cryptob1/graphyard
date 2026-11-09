import type { z } from 'zod';
import type { sensitiveEntrySchema, e2eServeSchema } from '../model-boundary/repository-policy.js';
export type SensitiveEntry = z.infer<typeof sensitiveEntrySchema>;
export const pendingOutcomeRules = ['non-blocking', 'blocking'] as const;
/** What a failed release candidate does (GY-1848): `hold` names the failure and reverts nothing; `revert` is the behaviour a repository that declares nothing keeps. */
export const releaseFailureActions = ['revert', 'hold'] as const;
export type E2eServe = z.infer<typeof e2eServeSchema>;
/** The policy in force: every section resolved, the declared one or its default. */
export interface RepositoryPolicy {
  risk: { sensitive: SensitiveEntry[]; declared: boolean };
  e2e: { pendingOutcomes: typeof pendingOutcomeRules[number]; serve: E2eServe | null };
  release: { onFailure: typeof releaseFailureActions[number]; revertUnmatched: boolean };
  product: { ui: string[] } | null;
  /** GY-3119: the E2E cases the batch gate on main always runs. */
  gate: { core: string[] };
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
  gate: { core: [] },
};

/** One rule compiled for a reader: its name, the entries' globs and one anchored pattern over them. */
export interface CompiledRule { rule: string; globs: string[]; pattern: RegExp }
const globSource = (pattern: string) => {
  // The documentation glob syntax (documentation-glob.ts), except that a terminal `/*` stays one segment:
  // `config/*` names config's own files, not `config/public/images/logo.svg`; `config/` or `config/**` is the tree.
  const glob = pattern.replace(/^\.\//, '');
  const source = glob.endsWith('/') ? `${glob}**` : glob;
  return source.split(/(\*\*\/?|\*|\?)/).map(part => part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('');
};
/** The rules a policy applies to `use`, grouped by rule name in declaration order; exclusions (`!glob`) are left to `compiledExclusion`. */
export function compiledRules(policy: Pick<RepositoryPolicy, 'risk'>): CompiledRule[] {
  const rules = new Map<string, string[]>();
  for (const entry of policy.risk.sensitive) if (!entry.glob.startsWith('!')) rules.set(entry.rule, [...(rules.get(entry.rule) ?? []), entry.glob]);
  return [...rules].map(([rule, globs]) => ({ rule, globs, pattern: new RegExp(`^(?:${globs.map(globSource).join('|')})$`) }));
}
/** One matcher over every exclusion (GY-3203): a path it matches is sensitive under no rule. Null when the policy excludes nothing. */
export function compiledExclusion(policy: Pick<RepositoryPolicy, 'risk'>): RegExp | null {
  const globs = policy.risk.sensitive.filter(entry => entry.glob.startsWith('!')).map(entry => entry.glob.slice(1));
  return globs.length ? new RegExp(`^(?:${globs.map(globSource).join('|')})$`) : null;
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
export const configFile = 'graphyard.json';

export type Source = 'environment' | 'graphyard.json' | 'default';

/** The `risk`, `e2e`, `release` and `product` sections of a parsed graphyard.json. */
export const policySections = (config: Record<string, unknown> | null | undefined) =>
  Object.fromEntries(['risk', 'e2e', 'release', 'product', 'gate'].filter(key => config?.[key] !== undefined).map(key => [key, config![key]]));

/** The nearest directory from `start` up holding `.git` (a directory, or a worktree's file); `start` when none does. */
export function gitToplevel(fs: any, path: any, start: string): string {
  for (let directory = start; ; directory = path.dirname(directory)) {
    if (fs.existsSync(path.join(directory, '.git'))) return directory;
    if (path.dirname(directory) === directory) return start;
  }
}
