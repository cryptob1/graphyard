import { z } from 'zod';
import { documentationGlobMatches } from './documentation-glob.js';
import { documentationScopes } from './scope.js';
import { deliveryPolicySchema } from './delivery-policy.js';

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
  /**
   * The project's documentation word budget (GY-574), when it keeps one: a total for the set and a
   * per-page cap, counted as `wc -w` counts them over the Markdown pages in the documentation paths
   * (narrowed by `paths`, globs within them, when only some of those pages are budgeted). Absent, no
   * budget is checked: headroom is not monitored, no trim item is filed and no overflow is attributed.
   */
  wordBudget: z.object({
    total: z.number().int().positive(),
    perPage: z.number().int().positive(),
    paths: z.array(documentationPath).min(1).max(50).optional(),
  }).strict().optional(),
}).strict();
export type DocumentationPolicy = z.infer<typeof documentationPolicySchema>;
export const repositoryConfigSchema = z.object({ documentation: documentationPolicySchema, delivery: deliveryPolicySchema.optional() }).strict();
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

/**
 * The committed `graphyard.json` policy against the one the control plane serves (GY-293). The
 * control plane reads only GRAPHYARD_DOCUMENTATION, so a committed edit that was never redeployed
 * stamps new items with stale paths; doctor reports the difference and the assignment that fixes
 * it. Null when they agree, or when the checkout commits no policy (the deployed one is then the
 * only one there is).
 */
export function documentationDrift(committed: DocumentationPolicy | null, deployed: DocumentationPolicy) {
  if (!committed) return null;
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(path => b.includes(path));
  if (same(committed.paths, deployed.paths) && committed.changelog === deployed.changelog) return null;
  const assignment = documentationAssignment(committed);
  return { committed, deployed, variable: assignment.variable,
    attention: `${repositoryConfigFile} declares documentation ${JSON.stringify(committed)} but the control plane serves ${JSON.stringify(deployed)}: set ${assignment.line} on the deployment` };
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

// ---------------------------------------------------------------------------
// The documentation word budget (GY-574). A project that configures `documentation.wordBudget` in
// its graphyard.json keeps its documentation within a total and a per-page budget (Graphyard's own
// is enforced by tests/docs-budget.test.ts); one that configures none is never counted. Every item
// documents its change and each passes the budget against its own base, so a set left at its cap
// overflows as soon as two of them land. So headroom is kept: master status names a set within 3%
// of the budget and the loop files one trim item.
// ---------------------------------------------------------------------------

/** The proof the docs word budget is judged as, which the trim item's criterion names. */
export const docsBudgetProof = 'unit:docs-word-budget';
/** A project's configured budget, resolved: the pages it counts are Markdown pages inside both `documentation` and `paths`. */
export interface DocsWordBudget { total: number; perPage: number; paths: string[]; documentation: string[] }
/** The budget a documentation policy configures, or null when it keeps none. */
export function docsWordBudgetOf(policy: Pick<DocumentationPolicy, 'paths' | 'wordBudget'> | null | undefined): DocsWordBudget | null {
  const budget = policy?.wordBudget;
  return budget ? { total: budget.total, perPage: budget.perPage, paths: [...(budget.paths ?? policy!.paths)], documentation: [...policy!.paths] } : null;
}
/** The budget a committed `graphyard.json` configures; null when the file is missing, unreadable or keeps none. */
export function repositoryDocsBudget(text: string | null | undefined): DocsWordBudget | null {
  if (text == null) return null;
  try { return docsWordBudgetOf(parseRepositoryConfig(text).documentation); } catch { return null; }
}
/** A set within this fraction of the total raises attention and files the trim item. */
export const docsHeadroomWarning = 0.03;
/** The headroom the trim item restores. */
export const docsHeadroomTarget = 0.05;
/** The trim item's title; an open item with this title is the one the loop filed. */
export const docsTrimTitle = 'Restore documentation word-budget headroom';

/** Words as `wc -w` counts them: maximal runs of non-whitespace, markup and code included. */
export const docsWords = (text: string) => text.split(/\s+/).filter(Boolean).length;
/** Is `path` one of the pages `budget` counts: a Markdown page inside its paths and the documentation paths. */
export const budgetedPage = (path: string, budget: Pick<DocsWordBudget, 'paths' | 'documentation'>) =>
  /\.(md|mdx|markdown)$/i.test(path) && isDocumentation(path, budget.paths) && isDocumentation(path, budget.documentation);
/** Words per budgeted page at one commit. */
export type DocsWordCount = Record<string, number>;
export const docsTotal = (count: DocsWordCount) => Object.values(count).reduce((sum, words) => sum + words, 0);

export interface DocsHeadroom {
  total: number; budget: number; remaining: number;
  /** The budgeted paths, as the project configures them. */
  paths: string[];
  /** True when the set is within docsHeadroomWarning of the budget (or over it). */
  saturated: boolean;
  /** The total the trim item must reach: docsHeadroomTarget below the budget. */
  target: number;
  /** The largest pages, largest first: where a trim starts. */
  largest: { page: string; words: number }[];
}
/** The headroom of one count against the budget. */
export function docsHeadroom(count: DocsWordCount, configured: Pick<DocsWordBudget, 'total' | 'paths'>): DocsHeadroom {
  const total = docsTotal(count), budget = configured.total;
  const largest = Object.entries(count).map(([page, words]) => ({ page, words })).sort((a, b) => b.words - a.words || a.page.localeCompare(b.page)).slice(0, 5);
  return { total, budget, paths: [...configured.paths], remaining: budget - total, saturated: total >= Math.floor(budget * (1 - docsHeadroomWarning)), target: Math.floor(budget * (1 - docsHeadroomTarget)), largest };
}
const pageList = (pages: { page: string; words: number }[]) => pages.map(entry => `${entry.page} (${entry.words})`).join(', ');
/** The attention line `master status` shows for a saturated set, or null. */
export function docsHeadroomText(headroom: DocsHeadroom, base: string): string | null {
  if (!headroom.saturated) return null;
  return `The documentation (${listed(headroom.paths)}) on ${base} is ${headroom.total} of its ${headroom.budget}-word budget (${headroom.remaining} left, within ${Math.round(docsHeadroomWarning * 100)}% of it): two queued items that each add a few words will overflow it together on a merge-queue tip. Trim to ${headroom.target} or fewer; largest pages: ${pageList(headroom.largest)}`;
}
/** The open trim item the loop filed, if any. */
export const openDocsTrimItem = <W extends { title: string; stage: string; closed?: unknown }>(work: readonly W[]) =>
  work.find(item => item.title.startsWith(docsTrimTitle) && item.stage !== 'done' && !item.closed) ?? null;
/**
 * What the trim item may give up to reach its target (GY-1366). The criterion used to demand both
 * the target and that everything documented stay documented: once tightening ran out, the two
 * conflicted and the worker parked the item on a goals decision. The operator answered that
 * question once ("cut hard", GY-1070) and was asked it again (GY-998, GY-1292), so the trade-off
 * is the criterion's own: detail goes, accuracy and the command and route index stay.
 */
export const docsTrimLatitude = 'detail-level documentation may be dropped to reach it; what remains stays accurate to the code, and every CLI command and HTTP route documented before the change stays named at least once';
/** The item the loop files once for a saturated set: the largest pages and the headroom to restore. */
export function docsTrimItem(headroom: DocsHeadroom, base: string) {
  return {
    title: `${docsTrimTitle}: ${headroom.total} of ${headroom.budget} words on ${base}`.slice(0, 200), type: 'bug' as const, priority: 1,
    description: [
      `The master loop filed this item itself: the budgeted documentation (${listed(headroom.paths)}) totals ${headroom.total} words on ${base} against the ${headroom.budget}-word budget ${repositoryConfigFile} configures (${docsBudgetProof}), within ${Math.round(docsHeadroomWarning * 100)}% of it. Every item documents its change, so two queued items that each pass the budget alone overflow it together on a merge-queue tip.`,
      `Trim the set to ${headroom.target} words or fewer (${Math.round(docsHeadroomTarget * 100)}% headroom) by tightening prose and linking instead of restating. Where that is not enough, drop detail-level documentation: the target wins, so this needs no human decision. Keep what remains accurate to the code and every CLI command and HTTP route named at least once. Start with the largest pages: ${pageList(headroom.largest)}.`,
    ].join('\n\n'),
    criteria: [{ id: 'AC-1', text: `The budgeted documentation (${listed(headroom.paths)}) totals at most ${headroom.target} words (at least ${Math.round(docsHeadroomTarget * 100)}% under the ${headroom.budget}-word budget); ${docsTrimLatitude}`, proofs: [docsBudgetProof] }],
    reason: `The documentation is ${headroom.total} of ${headroom.budget} words on ${base} and no open item restores its headroom`,
  };
}

