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
