// Concern: folding a wide plannedFiles widening into directory entries, and merging an attempt's pending scope asks (GY-549).
import { type ScopeCriterion, type ScopeRequestState, namedPaths, pathScope, pathScopeContains, unplannedPaths } from './scope.js';

// ---------------------------------------------------------------------------
// Collapsing a wide widening into directory entries (GY-549).
//
// plannedFiles holds at most `plannedFilesMax` entries. A mechanical change that touches every test
// file (GY-421: 158 of them) can never be scoped file by file: the list hits the cap and the item
// stalls. So the widening the loop proposes folds the requested files into their deepest common
// directory entries — `tests/` for the 158 — when a directory would otherwise be named more than
// `collapseDirectoryFiles` times, or when the list would exceed the cap. A fold never reaches the
// repository root and stays inside the item's own area: the top-level directories its criteria
// name or its plannedFiles already carry. The decision names each directory and the files it covers.
// ---------------------------------------------------------------------------

/** The most entries plannedFiles holds (model/work.ts). */
export const plannedFilesMax = 100;
/** More requested files than this under one directory are proposed as that directory. */
export const collapseDirectoryFiles = 20;
/** A directory entry a widening proposes in place of the requested files it covers. */
export interface CollapsedScope { scope: string; files: string[] }

/** Every directory above a path, deepest first: `tests/a/b.ts` → `tests/a/`, `tests/`. Never the root. */
const directoriesAbove = (path: string) => {
  const segments = pathScope(path).path.replace(/\/$/, '').split('/');
  return segments.slice(0, -1).map((_, index) => `${segments.slice(0, segments.length - 1 - index).join('/')}/`);
};
const depth = (scope: string) => pathScope(scope).path.split('/').length;

/** The top-level directories an item's criteria name or its plannedFiles carry: where a fold may land. */
export function collapseArea(item: { criteria?: readonly ScopeCriterion[]; plannedFiles?: readonly string[] }) {
  const top = (path: string) => directoriesAbove(path).at(-1) ?? (pathScope(path).prefix ? `${pathScope(path).path.split('/')[0]}/` : null);
  return [...new Set([...(item.criteria ?? []).flatMap(criterion => namedPaths(criterion.text)), ...(item.plannedFiles ?? [])].map(top).filter((scope): scope is string => !!scope))];
}

/**
 * The plannedFiles a widening by `paths` proposes, with every directory entry it folded files into.
 * Deepest directories first: one naming more than `collapseDirectoryFiles` entries becomes one
 * entry. Then, while the list is over `plannedFilesMax`, the directory that removes the most
 * entries is folded (the deepest on a tie). Only directories inside `area` that hold a requested
 * path are considered, so a fold never widens past what the request and the item already name;
 * planned entries it contains are folded with it. Paths already planned are not asked for again.
 */
export function collapsePlannedFiles(plannedFiles: readonly string[], paths: readonly string[], area: readonly string[]): { plannedFiles: string[]; collapsed: CollapsedScope[] } {
  const adding = unplannedPaths(plannedFiles, paths);
  let entries = [...new Set([...plannedFiles, ...adding])];
  const candidates = [...new Set(adding.flatMap(directoriesAbove))]
    .filter(directory => area.some(scope => pathScopeContains(scope, directory)))
    .sort((a, b) => depth(b) - depth(a) || a.localeCompare(b));
  const inside = (directory: string) => entries.filter(entry => pathScopeContains(directory, entry)).length;
  const fold = (directory: string) => { entries = [...entries.filter(entry => !pathScopeContains(directory, entry)), directory]; };
  for (const directory of candidates) if (!entries.includes(directory) && inside(directory) > collapseDirectoryFiles) fold(directory);
  while (entries.length > plannedFilesMax) {
    const best = candidates.filter(directory => !entries.includes(directory)).map(directory => ({ directory, count: inside(directory) }))
      .filter(entry => entry.count > 1).sort((a, b) => b.count - a.count || depth(b.directory) - depth(a.directory))[0];
    if (!best) break;
    fold(best.directory);
  }
  const collapsed = entries.filter(entry => !plannedFiles.includes(entry) && !adding.includes(entry))
    .map(scope => ({ scope, files: adding.filter(path => pathScopeContains(scope, path)) }));
  return { plannedFiles: entries, collapsed };
}

/**
 * A widening as the approver reads it: each folded directory with the requested files it covers
 * (so the decision names both), then the files listed as asked. The fold is said first, since a
 * long file list is what gets cut.
 */
export function describeWidening(paths: readonly string[], collapsed: readonly CollapsedScope[], max = 400) {
  const cut = (text: string, room: number) => text.length <= room ? text : `${text.slice(0, Math.max(0, room - 1))}…`;
  const folded = collapsed.map(entry => `${entry.scope} (one directory entry, plannedFiles holding at most ${plannedFilesMax}; covers ${entry.files.length} requested file${entry.files.length === 1 ? '' : 's'}: ${cut(entry.files.join(', '), Math.max(60, Math.floor(max / (collapsed.length + 1))))})`);
  const listed = paths.filter(path => !collapsed.some(entry => pathScopeContains(entry.scope, path)));
  return cut([...folded, ...listed].join(', '), max);
}

/** True when every path of `current` is still inside some scope of `next`: kept, or folded into a directory. */
export const plannedFilesCovered = (current: readonly string[], next: readonly string[]) =>
  current.every(path => next.some(scope => pathScopeContains(scope, path)));

/**
 * One requirements decision covers every outstanding path of an attempt (GY-549): a new additive
 * ask while the same attempt's earlier one is still pending — undecided, or refused by the rule and
 * so with the approver — is merged into it, the paths still outside plannedFiles carried over. The
 * merged request is a new ask (its own instant), so a decision standing for the earlier one is
 * moved past and withdrawn, and one decision is requested for the whole. A request the approver
 * or a master refused, or one that drops paths or rewrites criteria, is replaced as before.
 */
export function mergedScopeRequest(pending: ScopeRequestState | null | undefined, ask: ScopeRequestState, plannedFiles: readonly string[] = []): ScopeRequestState {
  const additive = (request: ScopeRequestState) => !request.remove?.length && !request.criteria?.length;
  if (!pending || pending.epoch !== ask.epoch || !additive(pending) || !additive(ask) || (pending.decision && pending.decision.decidedBy !== 'graphyard')) return ask;
  const carried = unplannedPaths(plannedFiles, pending.paths);
  if (!carried.length) return ask;
  const reason = pending.reason === ask.reason || pending.reason.includes(ask.reason) ? pending.reason : `${pending.reason} | ${ask.reason}`;
  return { ...ask, paths: [...new Set([...carried, ...ask.paths])], reason: reason.length <= 2000 ? reason : `${reason.slice(0, 1999)}…` };
}
