// Concern: plannedFiles as `master create` and `master requirements` record it (GY-140), apart from
// model/work.ts so that module keeps its budget: every planned path resolved against the base
// branch's tree, the files and companions the criteria carry in, and the paths refused as missing —
// among them a test path that misnames a test the base already holds (GY-1684).
import type { WorkOrigin } from './interventions.js';
import { itemDocumentationPaths, namedPaths, pathScope, pathScopeContains, plannedCompanions, testFile, type ItemDocumentation } from './scope.js';
import { askGrounds } from './scope-collapse.js';

interface CriterionText { id: string; text: string; proofs?: readonly string[] }
const creationWords = /\b(new|creat\w*|add(?:s|ed|ing)?|introduc\w*)\b/i, testPath = /(^|\/)tests?\/|\.test\.[A-Za-z]+$/, sentences = (text: string) => text.split(/(?<=[.!?;])\s+/);
/** True when the tree holds the planned scope: the file itself, or any file under a directory scope. */
export function scopeExists(path: string, tree: ReadonlySet<string>) {
  const scope = pathScope(path);
  if (!scope.prefix && tree.has(scope.path)) return true;
  const directory = scope.path.endsWith('/') ? scope.path : `${scope.path}/`;
  for (const file of tree) if (file.startsWith(directory)) return true;
  return false;
}

/** How many edits apart two test stems may be for one to misname the other: one per four characters of the longer, at most two. */
const misnameEdits = (longer: number) => Math.min(2, Math.floor(longer / 4));
/** The Levenshtein distance of two stems when it is within `bound`, else null; rows past the bound are abandoned early. */
function editDistance(a: string, b: string, bound: number): number | null {
  if (Math.abs(a.length - b.length) > bound) return null;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row++) {
    const current = [row];
    for (let column = 1; column <= b.length; column++) current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1));
    if (Math.min(...current) > bound) return null;
    previous = current;
  }
  return previous[b.length] <= bound ? previous[b.length] : null;
}
/** A test file's directory, stem and test suffix (`tests/orphan-supervisor.test.ts` → `tests/`, `orphan-supervisor`, `.test.ts`), spelt as the tree lists it (no leading `./`), or null for any other path. */
const testParts = (path: string) => {
  const match = /^((?:[^/]+\/)*)([^/]+?)(\.(?:test|spec)\.[cm]?[jt]sx?)$/.exec(pathScope(path).path);
  return match && testFile(path) ? { directory: match[1], stem: match[2], suffix: match[3] } : null;
};
/**
 * The test file the base holds that a planned test path most likely misnames (GY-1684), or null:
 * one in the same directory with the same test suffix whose stem is an edit or two away — a plural,
 * a dropped or doubled letter — the closest first, by name on a tie. GY-1617 planned
 * `tests/orphan-supervisors.test.ts` beside the base's `tests/orphan-supervisor.test.ts`; `master
 * create` read the plural as the new test a criterion's "a test drives that snapshot" describes, and
 * the master added the real file by hand 1.7 seconds after the first claim. Two names a letter
 * apart may both be meant: a criterion that names the new path beside a creation word still plans it.
 */
export function misnamedTest(path: string, tree: Iterable<string>): string | null {
  const parts = testParts(path), own = pathScope(path).path;
  if (!parts) return null;
  let best: { file: string; distance: number } | null = null;
  for (const file of tree) {
    if (file === own) return null;
    const candidate = testParts(file);
    if (!candidate || candidate.directory !== parts.directory || candidate.suffix !== parts.suffix) continue;
    const distance = editDistance(parts.stem, candidate.stem, misnameEdits(Math.max(parts.stem.length, candidate.stem.length)));
    if (distance !== null && (!best || distance < best.distance || (distance === best.distance && file < best.file))) best = { file, distance };
  }
  return best?.file ?? null;
}

/**
 * The criterion that describes creating `path`, or null: a sentence naming the path beside a
 * creation word (new, create, add, introduce), or — for a test file — a criterion that requires a
 * test, since "a test asserts …" is a criterion describing the test it will be written in. Given the
 * base's tree, that second reading stops at a test path misnaming a test the tree holds
 * (`misnamedTest`): the criterion's test is the existing file, which the plan must name as it is.
 */
export function describedAsNew(path: string, criteria: readonly CriterionText[], tree?: Iterable<string>) {
  const explicit = criteria.find(c => sentences(c.text).some(s => creationWords.test(s) && namedPaths(s).some(n => pathScopeContains(n, path))));
  if (explicit) return explicit.id;
  if (!testPath.test(path) || (tree && misnamedTest(path, tree))) return null;
  return criteria.find(c => /\btests?\b/i.test(c.text))?.id ?? null;
}
export interface PlannedFilesDerivation {
  plannedFiles: string[];
  /** Files a criterion names that resolve in the tree and were not planned, with the criterion that named each. */
  added: { path: string; criterion: string }[];
  /** Planned paths the tree does not hold and no criterion describes creating: the item is refused naming them. */
  missing: string[];
  /** The missing paths that misname a test the tree holds, with the file each most likely means (GY-1684); a test file a criterion's proofs name rather than the plan carries that criterion. */
  misnamed: { path: string; existing: string; criterion?: string }[];
}
/**
 * plannedFiles as `master create` and `master requirements` record it: every planned path is
 * resolved against the tree of the base branch the item will be worked on, and every file a
 * criterion names that the tree holds is carried in. Only criteria are read — a path the description mentions in prose is not a requirement and adds nothing — and only exact files
 * are carried: a criterion naming a directory widens nothing on its own. So are a change's inevitable companions (GY-955, model/scope-companions.ts) —
 * but the test file a criterion's proofs name is judged as a planned test is: one that misnames a test the tree holds is refused, not planned (GY-1684).
 */
export function derivePlannedFiles(
  item: { plannedFiles?: readonly string[]; criteria: readonly CriterionText[]; documentation?: ItemDocumentation | null; origin?: WorkOrigin | null; description?: string | null },
  tree: ReadonlySet<string>, asked: readonly string[] = [], // the scopes an open ask grounds (askedScopes, GY-1676): planned though the tree lacks them
): PlannedFilesDerivation {
  const planned = [...new Set(item.plannedFiles ?? [])], added: PlannedFilesDerivation['added'] = [];
  const missing = planned.filter(path => !scopeExists(path, tree) && !describedAsNew(path, item.criteria, tree) && !askGrounds(path, asked));
  const misnamed: PlannedFilesDerivation['misnamed'] = missing.flatMap(path => { const existing = misnamedTest(path, tree); return existing ? [{ path, existing }] : []; });
  for (const criterion of item.criteria) for (const path of namedPaths(criterion.text)) {
    if (tree.has(path) && !planned.some(entry => pathScopeContains(entry, path)) && !added.some(entry => entry.path === path)) added.push({ path, criterion: criterion.id });
  }
  for (const entry of plannedCompanions({ plannedFiles: [...planned, ...added.map(entry => entry.path)], criteria: item.criteria, origin: item.origin, description: item.description }, tree, itemDocumentationPaths(item))) {
    if (added.some(entry2 => entry2.path === entry.path) || planned.some(entry2 => pathScopeContains(entry2, entry.path))) continue;
    // A proof-named test the tree lacks that misnames a test it holds (`unit:orphan-supervisors` beside tests/orphan-supervisor.test.ts) is GY-1617's plural by another route: refused the same way, unless an open ask names it.
    const existing = entry.criterion && !scopeExists(entry.path, tree) && !askGrounds(entry.path, asked) ? misnamedTest(entry.path, tree) : null;
    if (existing) { missing.push(entry.path); misnamed.push({ path: entry.path, existing, criterion: entry.criterion! }); continue; }
    added.push({ path: entry.path, criterion: entry.criterion ?? 'DOCS' });
  }
  return { plannedFiles: [...planned, ...added.map(entry => entry.path)], added, missing, misnamed };
}
/** The refusal of a plan naming missing paths; a misnamed test is named with the file the base holds in its place, and one a criterion's proofs named with that criterion and its own remedy. */
export function plannedFilesRefusal(missing: readonly string[], base: string, misnamed: Readonly<PlannedFilesDerivation['misnamed']> = []) {
  const hint = (path: string) => misnamed.find(entry => entry.path === path);
  const named = missing.map(path => { const entry = hint(path); return entry ? `${path} (${entry.criterion ? `the test file ${entry.criterion}'s proofs name; ` : ''}${base} holds ${entry.existing})` : path; });
  const remedies = [...new Set(missing.map(path => hint(path)?.criterion ? 'plan the existing test, or name the new one in plannedFiles beside a criterion that creates it' : 'correct the path, or state in a criterion that the item creates it'))];
  return `plannedFiles names ${missing.length === 1 ? 'a path' : 'paths'} that ${base} does not hold and no criterion describes creating: ${named.join(', ')}. ${remedies.map((remedy, index) => index ? remedy : remedy[0].toUpperCase() + remedy.slice(1)).join('; ')}`;
}
