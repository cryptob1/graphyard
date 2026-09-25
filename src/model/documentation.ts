import { z } from 'zod';
import { documentationGlobMatches, documentationScopes } from './scope.js';

// ---------------------------------------------------------------------------
// Every ticket keeps its project's documentation current (GY-215).
//
// Documentation is a per-repository setting. The managed repository names its documentation
// paths (globs) and optional changelog in its committed Graphyard configuration, `graphyard.json`
// at the repository root; onboarding proposes them from what the repository actually holds and
// writes that file, and the installer deploys the same policy to the control plane as
// GRAPHYARD_DOCUMENTATION. A repository that configures none keeps the default below.
//
// The control plane then stamps every feature and bug with one standard obligation at create time
// — "Documentation reflects this change" — naming those paths. It is satisfied at submission by a
// diff inside them or by the worker's explicit statement that the change alters no documented
// behaviour, and the independent reviewer judges which it is: nobody writes it into a ticket.
// ---------------------------------------------------------------------------

/** The committed repository configuration file that carries the documentation policy. */
export const repositoryConfigFile = 'graphyard.json';
/** The deployment variable the control plane reads the same policy from. */
export const documentationVariable = 'GRAPHYARD_DOCUMENTATION' as const;

const documentationPath = z.string().trim().min(1).max(200)
  .refine(path => !path.startsWith('/') && !path.split('/').some(segment => segment === '..' || segment === '.') && !/[\s\u0000-\u001f]/.test(path), 'Documentation paths are repository-relative globs without . or .. segments or whitespace');
export const documentationPolicySchema = z.object({
  /** Repository-relative globs: `docs/` (a tree), `README.md` (a file), `README*`, `packages/*\/README.md`. */
  paths: z.array(documentationPath).min(1).max(50),
  /** The changelog a user-visible change adds an entry to, when the repository keeps one. */
  changelog: documentationPath.nullable().default(null),
}).strict();
export type DocumentationPolicy = z.infer<typeof documentationPolicySchema>;
export const repositoryConfigSchema = z.object({ documentation: documentationPolicySchema }).strict();
export type RepositoryConfig = z.infer<typeof repositoryConfigSchema>;

/** The policy of a repository that configures none: Graphyard's own historical layout. */
export const defaultDocumentationPolicy: DocumentationPolicy = { paths: [...documentationScopes], changelog: null };

/** Every path the policy counts as documentation: its globs and its changelog. */
export const documentationPaths = (policy: Pick<DocumentationPolicy, 'paths' | 'changelog'>) =>
  [...new Set([...policy.paths, ...(policy.changelog ? [policy.changelog] : [])])];

/** The policy a committed `graphyard.json` declares; refuses a file that does not parse. */
export function parseRepositoryConfig(text: string): RepositoryConfig {
  let value: unknown;
  try { value = JSON.parse(text); } catch (error: any) { throw new Error(`${repositoryConfigFile} is not JSON: ${error.message}`); }
  return repositoryConfigSchema.parse(value);
}

/** The deployment value for a policy: compact JSON, the form the control plane parses back. */
export const documentationAssignment = (policy: DocumentationPolicy) => {
  const value = JSON.stringify(documentationPolicySchema.parse(policy));
  return { variable: documentationVariable, value, line: `${documentationVariable}=${value}` };
};

/**
 * The policy the control plane serves: the deployed GRAPHYARD_DOCUMENTATION, or the default when
 * it is unset. A value that does not parse refuses start-up rather than silently dropping docs.
 */
export function configuredDocumentation(env: NodeJS.ProcessEnv = typeof process === 'undefined' ? {} : process.env): DocumentationPolicy {
  const raw = env[documentationVariable]?.trim();
  if (!raw) return defaultDocumentationPolicy;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(`${documentationVariable} must be the JSON documentation policy from ${repositoryConfigFile}, e.g. {"paths":["docs/"],"changelog":null}`); }
  return documentationPolicySchema.parse(value);
}

/** The standard criterion's short name, as the control plane stamps it on every feature and bug. */
export const documentationCriterionTitle = 'Documentation reflects this change';
export const documentationCriterionId = 'DOCS';

/** What the worker recorded at submission, and what the diff touched inside the documentation paths. */
export interface DocumentationSubmission {
  epoch: number; pr: number; at: string;
  /** The candidate's files inside the documentation paths; null when the submission was not observed. */
  files: string[] | null;
  /** The worker's explicit statement that the change alters no documented behaviour. */
  statement: string | null;
  satisfiedBy: 'diff' | 'statement' | null;
}
export interface DocumentationObligation {
  id: typeof documentationCriterionId;
  text: string;
  paths: string[];
  changelog: string | null;
  submission?: DocumentationSubmission | null;
}
declare module './work.js' { interface Work { documentation?: DocumentationObligation | null } }

const listed = (paths: readonly string[]) => paths.join(', ');

/** The obligation a new item of this type carries, or null for a chore. */
export function documentationObligation(type: string | undefined, policy: DocumentationPolicy): DocumentationObligation | null {
  if (type !== undefined && type !== 'feature' && type !== 'bug') return null;
  const paths = [...policy.paths];
  return { id: documentationCriterionId, paths, changelog: policy.changelog,
    text: `${documentationCriterionTitle}: the diff updates this repository's documentation (${listed(paths)})${policy.changelog ? ` and adds an entry to ${policy.changelog}` : ''} for any user-visible behaviour, command, configuration or API it changes, or the worker states at submission that the change alters no documented behaviour.` };
}

/** True when `file` lies inside one of the documentation globs. */
export const isDocumentation = (file: string, paths: readonly string[]) => paths.some(pattern => documentationGlobMatches(pattern, file));

/**
 * Files whose change is user-visible behaviour in most repositories: commands and their entry
 * points, configuration, HTTP routes and public API surfaces. A heuristic for the flag below, not a
 * definition — the reviewer judges every other file by reading it.
 */
const userVisibleSurface = /(?:^|\/)(?:cli|bin|commands?|cmd|routes?|api|config|configuration|settings|schema)(?:\/|\.[A-Za-z0-9]+$|$)|(?:^|\/)(?:package\.json|pyproject\.toml|Dockerfile|compose\.ya?ml|openapi\.[A-Za-z]+)$/i;
export const userVisibleFiles = (files: readonly string[], paths: readonly string[]) => files.filter(file => !isDocumentation(file, paths) && userVisibleSurface.test(file));

export interface DocumentationCheck {
  state: 'updated' | 'stated' | 'missing';
  /** Changed files inside the documentation paths. */
  documentation: string[];
  /** Changed user-visible surfaces (commands, configuration, APIs) outside them. */
  surfaces: string[];
  /** The finding a reviewer must act on: a user-visible change with neither a docs diff nor a statement. */
  flag: string | null;
}
/**
 * Judge a submission against the obligation: a docs diff satisfies it, a statement satisfies it
 * pending the reviewer's check that it is true, and a change to a command, configuration or API
 * with neither is flagged for the reviewer to request changes on.
 */
export function documentationCheck(obligation: Pick<DocumentationObligation, 'paths' | 'changelog'>, files: readonly string[], statement?: string | null): DocumentationCheck {
  const paths = documentationPaths(obligation);
  const documentation = files.filter(file => isDocumentation(file, paths));
  const surfaces = userVisibleFiles(files, paths);
  const state = documentation.length ? 'updated' : statement?.trim() ? 'stated' : 'missing';
  const flag = state === 'missing' && surfaces.length
    ? `Documentation is missing: the change touches user-visible ${surfaces.length === 1 ? 'surface' : 'surfaces'} ${listed(surfaces.slice(0, 10))}${surfaces.length > 10 ? ` and ${surfaces.length - 10} more` : ''} with no change under ${listed(paths)} and no statement that it alters no documented behaviour`
    : null;
  return { state, documentation, surfaces, flag };
}

/** The obligation as it stands at submission, recorded on the item beside the candidate. */
export function recordDocumentationSubmission(obligation: DocumentationObligation, submission: { epoch: number; pr: number }, files: readonly string[] | null, statement: string | null | undefined, at: Date): DocumentationSubmission {
  const docs = files ? files.filter(file => isDocumentation(file, documentationPaths(obligation))) : null;
  const stated = statement?.trim() || null;
  return { epoch: submission.epoch, pr: submission.pr, at: at.toISOString(), files: docs, statement: stated,
    satisfiedBy: docs?.length ? 'diff' : stated ? 'statement' : null };
}

/** The worker request's paragraph: the obligation, the repository's paths, and how to state the exception. */
export function documentationWorkerSection(obligation: Pick<DocumentationObligation, 'paths' | 'changelog'>, key: string, epoch: number, cli: string) {
  return `Every item carries the standard criterion "${documentationCriterionTitle}": update this repository's documentation (${listed(obligation.paths)})${obligation.changelog ? ` and add an entry to ${obligation.changelog}` : ''} for every user-visible behaviour, command, configuration or API your change alters, in the same pull request. `
    + `If the change alters no documented behaviour, say so when you submit: node ${cli} complete ${key} ${epoch} PR --no-docs "WHY NO DOCUMENTED BEHAVIOUR CHANGED". The independent reviewer checks the docs diff or that statement and requests changes when either is missing or untrue. `;
}

/** The reviewer prompt's paragraph: the check itself, the paths, and what Graphyard saw in the diff. */
export function documentationReviewSection(obligation: Pick<DocumentationObligation, 'paths' | 'changelog'> & { submission?: DocumentationSubmission | null }, files?: readonly string[] | null) {
  const paths = documentationPaths(obligation);
  const statement = obligation.submission?.statement ?? null;
  const check = files ? documentationCheck(obligation, files, statement) : null;
  return `Documentation check (the standard criterion "${documentationCriterionTitle}"): confirm the diff updates this repository's documentation paths (${listed(paths)}) for what it changes, or, when the worker stated the change alters no documented behaviour, that the statement is true. `
    + `Request changes when user-visible behaviour, commands, configuration or APIs changed without a matching documentation update; a stale or contradicted page counts as missing. `
    + (statement ? `The worker's statement at submission: "${statement.slice(0, 500)}". ` : 'The worker made no no-docs statement at submission. ')
    + (check?.documentation.length ? `Documentation files in the diff: ${listed(check.documentation.slice(0, 20))}. ` : check ? 'The diff changes no file under the documentation paths. ' : '')
    + (check?.flag ? `Graphyard flags this submission: ${check.flag}. That is a BLOCKING finding unless the diff shows the behaviour is unchanged. ` : '');
}
