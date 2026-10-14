// Concern: the documentation word budget (GY-574, GY-1515) — a project's configured total and
// per-page budget, the headroom the loop keeps on the base branch, the trim item it files, and the
// judgement the budget test gives a change.
import { isDocumentation, parseRepositoryConfig, repositoryConfigFile, type DocumentationPolicy } from './documentation.js';

const listed = (paths: readonly string[]) => paths.join(', ');

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
  /** The total at which the set is saturated: docsHeadroomWarning below the budget. */
  band: number;
  /** The total the trim item must reach: docsHeadroomTarget below the budget. */
  target: number;
  /** The largest pages, largest first: where a trim starts. */
  largest: { page: string; words: number }[];
}
/** The headroom of one count against the budget. */
export function docsHeadroom(count: DocsWordCount, configured: Pick<DocsWordBudget, 'total' | 'paths'>): DocsHeadroom {
  const total = docsTotal(count), budget = configured.total, band = Math.floor(budget * (1 - docsHeadroomWarning));
  const largest = Object.entries(count).map(([page, words]) => ({ page, words })).sort((a, b) => b.words - a.words || a.page.localeCompare(b.page)).slice(0, 5);
  return { total, budget, paths: [...configured.paths], remaining: budget - total, saturated: total >= band, band, target: Math.floor(budget * (1 - docsHeadroomTarget)), largest };
}
const pageList = (pages: { page: string; words: number }[]) => pages.map(entry => `${entry.page} (${entry.words})`).join(', ');
/**
 * The attention line `master status` shows for a saturated set, or null. Inside the band the set
 * is held by the budget test (docsBudgetJudgement) and restored by the trim item; over the budget
 * the band was overrun by changes merged together, and the set is a resource at its bound (GY-1515).
 */
export function docsHeadroomText(headroom: DocsHeadroom, base: string): string | null {
  if (!headroom.saturated) return null;
  const over = headroom.remaining < 0;
  return `The documentation (${listed(headroom.paths)}) on ${base} is ${headroom.total} of its ${headroom.budget}-word budget (${over ? `over it by ${-headroom.remaining}` : `${headroom.remaining} left, within ${Math.round(docsHeadroomWarning * 100)}% of it`}): ${over
    ? 'changes merged together overran the band the docs budget test holds, and the test now fails on the base branch'
    : `${docsBudgetProof} refuses every change that adds a word to it until the set is under ${headroom.band}`}. Trim to ${headroom.target} or fewer; largest pages: ${pageList(headroom.largest)}`;
}
/** Each page stays this far under its cap (GY-1069), so one merge-queue tip that adds a paragraph cannot fail the cap. */
export const docsPageHeadroom = 200;
/** What docsBudgetJudgement knows of the change's base: its pages, `null` when it could not be counted, or `'base-branch'` when the candidate is the base branch itself. */
export type DocsBudgetBase = DocsWordCount | null | 'base-branch';
export interface DocsBudgetJudgement { failed: string | null; warning: string | null; headroom: DocsHeadroom }
/**
 * The budget's judgement of a change (GY-574, GY-1515): a page over its cap or past its headroom
 * fails by name. The total was never a gate, so main re-saturated within hours of every trim
 * (14,972 words at 02:12Z on 8 October 2026, 15,766 by 05:00Z) and sat over its budget for 25
 * minutes while seven changes landed green: a saturated total now fails any change that adds a
 * word to it, so each change that documents itself into a saturated set trims first. A change that
 * adds none passes with the warning, so a base already in the band blocks nothing that leaves the
 * documentation alone; the base branch itself only warns, since nothing can be refused there and a
 * tip that overran the band must not fail the base; a base that could not be counted warns too.
 */
export function docsBudgetJudgement(candidate: DocsWordCount, budget: Pick<DocsWordBudget, 'total' | 'perPage' | 'paths'>, base: DocsBudgetBase): DocsBudgetJudgement {
  const counts = Object.entries(candidate).map(([page, words]) => ({ page, words })), pageTarget = budget.perPage - docsPageHeadroom;
  const overCap = counts.filter(entry => entry.words > budget.perPage), pastHeadroom = counts.filter(entry => entry.words > pageTarget);
  const headroom = docsHeadroom(candidate, budget), set = `The budgeted documentation (${listed(headroom.paths)})`;
  const failed = overCap.length ? `pages over the ${budget.perPage}-word page budget: ${pageList(overCap)}`
    : pastHeadroom.length ? `pages within ${docsPageHeadroom} words of the ${budget.perPage}-word page budget (over ${pageTarget}): ${pageList(pastHeadroom)}` : null;
  if (!headroom.saturated) return { failed, warning: null, headroom };
  const standing = `${set} totals ${headroom.total} words, ${headroom.remaining < 0 ? `over its ${headroom.budget}-word budget by ${-headroom.remaining}` : `within ${Math.round(docsHeadroomWarning * 100)}% of its ${headroom.budget}-word budget (over ${headroom.band})`}`;
  const trim = `trim it to ${headroom.target} or fewer; largest pages: ${pageList(headroom.largest)}`;
  const added = base === 'base-branch' || base === null ? null : headroom.total - docsTotal(base);
  if (added !== null && added > 0) return { failed: failed ?? `${standing}, and this change adds ${added} to it: a saturated set may not grow, so ${trim}`, warning: null, headroom };
  const passes = base === 'base-branch' ? 'this is the base branch, where nothing can be refused' : base === null ? 'its base could not be counted, so the growth this change brings is not judged' : `this change adds ${added === 0 ? 'none' : `${added}`}`;
  return { failed, warning: `${standing}; ${passes}, so it passes, and the loop's trim item restores the headroom: ${trim}`, headroom };
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

