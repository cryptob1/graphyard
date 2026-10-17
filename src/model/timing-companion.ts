// The timing baseline as an implied scope companion (GY-1023), apart from model/scope.ts so that
// module keeps its budget.
import { pathScope, testFile } from './scope.js';
import type { ScopeFile } from './work.js';

/**
 * The per-file test durations CI balances its shards by (scripts/ci-tests.mjs). A change that adds a
 * test file records that file's line here, so the baseline is implied by the test, exactly as the
 * guide a behaviour change touches is implied by the documentation rule: no operator widens
 * plannedFiles for it. The implication covers the lines of the candidate's own test files only.
 */
export const timingBaselinePath = 'tests/helpers/timing-baseline.json';

/** A test file whose execution duration is tracked in the baseline: top-level tests/*.test.ts. */
export const timedTestFile = (path: string) => testFile(path) && /^tests\/[^/]+\.test\.ts$/.test(path);

/** The test files a change adds, changes or removes: the files whose baseline lines it may write. */
export const changedTestFiles = (files: readonly { path: string; previousPath?: string; status?: string }[]) =>
  [...new Set(files.filter(file => file.status !== 'unchanged').flatMap(file => [file.path, ...(file.previousPath && file.status !== 'copied' ? [file.previousPath] : [])]))]
    .filter(path => path !== timingBaselinePath && timedTestFile(path));

export interface TimingCompanion { allowed: boolean; detail: string }
const canonical = (value: unknown) => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
const parse = (text: string) => { try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; } };
const listed = (lines: readonly string[]) => lines.length > 5 ? `${lines.slice(0, 5).join(', ')} and ${lines.length - 5} more` : lines.join(', ');

/**
 * Whether a baseline change writes only the lines of the candidate's own test files: every field
 * but `files` unchanged, and each `files` line it adds, alters or removes names a test file the
 * candidate adds or changes (`tests`), or adds a line for a test file the base records none for,
 * with a non-negative duration. Anything else is refused,
 * naming the lines, and the file is judged as any out-of-scope rewrite.
 */
export function timingBaselineCompanion(base: string, head: string, tests: readonly string[]): TimingCompanion {
  const before = parse(base), after = parse(head);
  if (!before || !after) return { allowed: false, detail: `${timingBaselinePath} does not parse as a JSON object on both sides, so its lines cannot be judged` };
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => key !== 'files' && canonical(before[key]) !== canonical(after[key]));
  if (fields.length) return { allowed: false, detail: `changes the baseline's recorded ${fields.join(', ')}, not only the lines of this change's test files` };
  const was = before.files && typeof before.files === 'object' ? before.files : {}, now = after.files && typeof after.files === 'object' ? after.files : {};
  const own = new Set(tests), changed = [...new Set([...Object.keys(was), ...Object.keys(now)])].filter(path => canonical(was[path]) !== canonical(now[path])).sort();
  const describe = (path: string) => `"${path}" (${!(path in now) ? 'removed' : !(path in was) ? 'added' : 'altered'})`;
  // A line added for a test file the baseline does not record yet fills a gap nobody's line holds
  // (GY-1397): when unrecorded files push coverage below ci-shards' floor, the change that crosses it
  // records them without a widening. Altering or removing another file's line stays foreign.
  const gap = (path: string) => !(path in was) && timedTestFile(path);
  const foreign = changed.filter(path => !(own.has(path) || gap(path)) || (path in now && !(typeof now[path] === 'number' && Number.isFinite(now[path]) && now[path] >= 0)));
  if (foreign.length) return { allowed: false, detail: `changes the timing lines ${listed(foreign.map(describe))}, which are neither for test files this change adds or changes nor new lines for test files the baseline does not record` };
  return { allowed: true, detail: changed.length ? `implied companion of this change's test files and the baseline's unrecorded ones: writes only the lines ${listed(changed.map(describe))}` : 'implied companion of this change\'s test files: no line differs' };
}

const serialize = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The baseline a conflicted `graphyard sync` writes (GY-1875): the base tip's file with, for each
 * test file the branch adds or changes relative to the merge base, the branch's own line, and the
 * lines of test files the branch deleted removed. A line the branch added for a test file neither
 * the merge base nor the base tip records is a gap fill the companion rule allows, and is kept; a
 * line of either kind whose test file the merge result no longer holds (`exists`) is dropped, so a
 * test the base deleted leaves no line behind. Every other line stays the base tip's — one the
 * branch altered for a test file it does not touch is dropped, exactly as the companion rule would
 * refuse it — so the result always satisfies timingBaselineCompanion against the base tip. Returns
 * null, leaving the conflict for the worker, when either side does not parse into the object the
 * companion judges, or when the base tip's text is not what this writer emits: the merge is only
 * resolved by writing the base tip's file plus nothing else, never a reformatted one.
 */
export function resolveTimingBaseline(base: string, branch: string, files: readonly { path: string; previousPath?: string; status?: string }[], options: { mergeBase?: string | null; exists?: (path: string) => boolean } = {}): string | null {
  const baseSide = parse(base), branchSide = parse(branch);
  if (!baseSide || !branchSide || serialize(baseSide) !== base) return null;
  const linesOf = (side: Record<string, any> | null): Record<string, unknown> => side?.files && typeof side.files === 'object' && !Array.isArray(side.files) ? side.files : {};
  const branchLines = linesOf(branchSide), recorded = linesOf(options.mergeBase ? parse(options.mergeBase) : null);
  const gone = new Set(files.flatMap(file => [...(file.status === 'removed' ? [file.path] : []), ...(file.previousPath && file.status !== 'copied' ? [file.previousPath] : [])]));
  const lines = { ...linesOf(baseSide) };
  const own = changedTestFiles(files);
  // Gap fills: lines the branch added for timed test files nobody's baseline recorded (GY-1397).
  const gaps = options.mergeBase ? Object.keys(branchLines).filter(path => !(path in recorded) && !(path in lines) && timedTestFile(path) && !own.includes(path)) : [];
  const exists = options.exists ?? (() => true);
  for (const path of [...own, ...gaps]) {
    const line = branchLines[path];
    if (gone.has(path) || !exists(path)) delete lines[path];
    else if (typeof line === 'number' && Number.isFinite(line) && line >= 0) lines[path] = line;
  }
  const resolved = serialize({ ...baseSide, files: lines });
  return timingBaselineCompanion(base, resolved, own).allowed ? resolved : null;
}

/** True when the item's planned scope or observed diff holds a test file, so the baseline is implied by it. */
export const addsTestFile = (item: { plannedFiles?: readonly string[]; observation?: { files?: readonly string[] } | null }) =>
  (item.plannedFiles ?? []).some(planned => { const scope = pathScope(planned); return scope.path !== timingBaselinePath && (scope.prefix ? scope.path === 'tests/' : timedTestFile(scope.path)); })
  || changedTestFiles((item.observation?.files ?? []).map(path => ({ path }))).length > 0;

/**
 * Attaches the companion verdict to the baseline among compared files, reading the base and head
 * versions through `read` (a blob by sha). A baseline the planned scope covers, or one whose
 * versions cannot be read, carries none and is judged by blob identity as before.
 */
export async function judgeTimingCompanion(files: ScopeFile[], read: (sha: string) => Promise<string | null>, planned: (path: string) => boolean = () => false) {
  const file = files.find(entry => entry.path === timingBaselinePath);
  if (!file || planned(file.path) || file.status === 'removed' || !file.sha || !file.baseSha || file.sha === file.baseSha) return;
  const inScopeTests = files.filter(f => planned(f.path) || f.status === 'added' || f.baseSha === null);
  const [base, head] = await Promise.all([read(file.baseSha), read(file.sha)]);
  if (base !== null && head !== null) file.companion = timingBaselineCompanion(base, head, changedTestFiles(inScopeTests));
}
