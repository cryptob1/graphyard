// ---------------------------------------------------------------------------
// The spec check (GY-881). A large share of rework comes from task specs, not code: GY-864
// planned src/server/routes/work.ts while the route its criterion named lived in status.ts, so
// the worker built the wrong file. Before an intent is recorded or an item is released, every
// reference a criterion names — a repository path, a route, an exported symbol — must resolve,
// against the tree of the base branch the item will be worked on, to a file plannedFiles covers
// or one a criterion describes creating, and every criterion must carry at least one proof.
// Anything else is refused at the boundary, naming each unresolved reference with its criterion:
// the same parse-don't-validate shape derivePlannedFiles gives plannedFiles. The check is pure —
// the tree and the base search are handed in — so the intent flow grades against the exact tree
// its one base fetch resolved, and tests hand in a stub. Nothing here reads a file.
// ---------------------------------------------------------------------------
import type { ChildRun } from '../child-runner.js';
import { ChildProcessError, defaultChildRun } from '../child-runner.js';
import { criterionSymbols } from './criterion-scope.js';
import { namedPaths, pathScopeContains } from './scope.js';
import { describedAsNew, scopeExists } from './work.js';

/** A criterion as the check reads it: the raw intent may carry no proofs at all. */
export interface SpecCriterion { id: string; text: string; proofs?: readonly string[] }

/** The base-tree search the check resolves routes and symbols through: the files of one base tree whose text holds the needle. */
export interface SpecSearch { filesMatching(kind: 'route' | 'symbol', needle: string): Promise<Set<string>> }

/** One reference a criterion names that no planned file holds and no criterion describes creating. */
export interface SpecReference { criterion: string; kind: 'path' | 'route' | 'symbol'; reference: string; holder?: string }

/** What one check found: every unresolved reference with its criterion, and every criterion without a proof. */
export interface SpecCheckResult { unresolved: SpecReference[]; proofless: string[] }

/** The holders named per refusal before the rest are counted: a refusal names the fault, it is not a report. */
const namedHoldersMax = 3, unresolvedMax = 8;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The literals a route symbol carries before its first path parameter: `GET /api/work/([^/]+)/x` grounds as `/api/work/`. */
const routePrefix = (route: string) => route.split(/[:{]/)[0].replace(/\/$/, '');
/** The declaration needle a symbol resolves by: an export line, never a mention, an import or prose — a symbol declared nowhere is one the item creates. */
export const symbolDeclarationNeedle = (symbol: string) =>
  `export\\s+(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\s*\\*?\\s+|const\\s+|class\\s+|type\\s+|interface\\s+|enum\\s+)${escapeRegExp(symbol)}\\b`;

/**
 * Every fault in the item's spec, against `tree` (the base files, as scopeExists reads them) and
 * `search` (the same tree's text). A criterion names a path the tree holds that no planned scope
 * covers and no criterion describes creating; a route or an identifier whose holders on the base
 * all sit outside plannedFiles; or it carries no proof. A reference the base does not hold at all
 * is one the item creates and never refuses.
 */
export async function specCheck(item: { criteria: readonly SpecCriterion[]; plannedFiles?: readonly string[] }, tree: ReadonlySet<string>, search: SpecSearch): Promise<SpecCheckResult> {
  const planned = item.plannedFiles ?? [], criteria = item.criteria ?? [];
  const covered = (path: string) => planned.some(entry => pathScopeContains(entry, path));
  const excused = (path: string) => covered(path) || describedAsNew(path, criteria) !== null;
  const unresolved: SpecReference[] = [];
  const note = (finding: SpecReference) => { if (unresolved.length < unresolvedMax) unresolved.push(finding); };
  for (const criterion of criteria) {
    for (const path of namedPaths(criterion.text)) {
      if (scopeExists(path, tree) && !excused(path)) note({ criterion: criterion.id, kind: 'path', reference: path });
    }
  }
  const quoted = "['\"`]";
  for (const { criterion, kind, symbol } of criterionSymbols(criteria)) {
    if (kind === 'route') {
      const prefix = routePrefix(symbol);
      if (prefix.length <= 1) continue;
      const holders = [...await search.filesMatching('route', `${quoted}${escapeRegExp(prefix)}`)];
      if (holders.length && !holders.some(excused)) note({ criterion, kind, reference: symbol, holder: holders.slice(0, namedHoldersMax).join(', ') });
    } else if (kind === 'identifier') {
      const holders = [...await search.filesMatching('symbol', symbolDeclarationNeedle(symbol))];
      if (holders.length && !holders.some(excused)) note({ criterion, kind: 'symbol', reference: symbol, holder: holders.slice(0, namedHoldersMax).join(', ') });
    }
  }
  const proofless = criteria.filter(entry => !entry.proofs?.length).map(entry => entry.id);
  return { unresolved, proofless };
}

/** True when a criterion names something the check resolves against the tree — a repository path, a route or an exported symbol. A criterion naming nothing grades vacuously, so grading it needs no tree at all. */
export const specNamesReferences = (criteria: readonly SpecCriterion[]) =>
  criteria.some(criterion => namedPaths(criterion.text).length > 0 || criterionSymbols([criterion]).some(entry => entry.kind === 'route' || entry.kind === 'identifier'));

/** The refusal a failing check raises, in the shape of plannedFilesRefusal: every unresolved reference named with its criterion, then every proofless one. */
export function specCheckRefusal(result: SpecCheckResult, base: string) {
  const parts = [];
  if (result.unresolved.length) {
    const named = result.unresolved.map(finding => `${finding.criterion} names the ${finding.kind} ${finding.reference}${finding.holder ? `, held by ${finding.holder}` : ''}`);
    parts.push(`the criteria name ${result.unresolved.length === 1 ? 'a reference' : `${result.unresolved.length} references`} no plannedFiles entry covers and no criterion describes creating, checked against ${base}: ${named.join('; ')}. Plan the file that holds each, or state in a criterion that the item creates it`);
  }
  if (result.proofless.length) parts.push(`${result.proofless.join(', ')} ${result.proofless.length === 1 ? 'has' : 'have'} no proof; every criterion carries at least one`);
  return parts.join('. ');
}

/**
 * The base-tree search behind the check, mirroring baseMentions: `git grep` against the one ref
 * the caller's base fetch resolved, over source files, so a mention in docs or prose never
 * grounds a holder. git's "no match" exit (1) is an empty set; any other failure throws, so a
 * search that could not read the tree refuses the item instead of passing it as created.
 */
export function baseSpecSearch(root: string, ref: string, run: ChildRun = defaultChildRun): SpecSearch {
  const filesMatching = async (kind: 'route' | 'symbol', needle: string) => {
    try {
      const listed = await run('git', ['-C', root, 'grep', '-l', '-E', '-e', needle, ref, '--', '*.ts', '*.tsx', '*.js', '*.mjs'], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
      return new Set<string>(String(listed).split('\n').filter(Boolean).map(line => line.startsWith(`${ref}:`) ? line.slice(ref.length + 1) : line));
    } catch (error) {
      if (error instanceof ChildProcessError && error.status === 1) return new Set<string>();
      throw error;
    }
  };
  return { filesMatching };
}

/**
 * The three authoring rules every prompt that writes or judges a work item carries, verbatim
 * (GY-881 AC-2). They are the release gate's terms as much as the author's: an item whose
 * criteria name code no planned file holds is refused at create, requirements and release.
 */
export const specRulesPrompt = 'Locate each planned file by searching for every symbol and route the criteria name. Write one observable behaviour per criterion with its test. Keep an item to at most 6 planned files, splitting larger work into dependent items.';
