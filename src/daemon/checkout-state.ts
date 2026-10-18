// Concern: GY-1773 — how the coordinator checkout stands (commit, HEAD, dirty paths), read from git.
// GY-1899 — which checkout that is: the one the running CLI comes from, never the managed repository's root.
// GY-2018 — under the test runner the checkout the suite itself runs from is never a judged one, wherever it stands.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildRun } from '../child-runner.js';
import { checkoutGuardApplies, coordinatorCheckoutRoot } from '../master/profiles.js';
import { underTestRunner } from '../supervisor.js';

/** How the coordinator checkout stands: its commit, whether HEAD is detached, and whether tracked files differ from the commit (`dirtyPaths` names them: both paths of a rename). */
export interface CheckoutState { commit: string | null; detached: boolean | null; dirty: boolean | null; dirtyPaths: string[]; branch: string | null }
/** A porcelain path unquoted: git quotes one holding spaces at either end, control characters, a quote or a backslash. Shared with the alignment's `--name-only` listings, so both readings resolve the same names (GY-1790). */
export const unquotePath = (path: string) => {
  if (!path.startsWith('"') || !path.endsWith('"') || path.length < 2) return path;
  const escapes: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, '\\': 92 };
  const bytes: number[] = [];
  const body = path.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') { bytes.push(...Buffer.from(body[i]!)); continue; }
    const octal = body.slice(i + 1, i + 4);
    if (/^[0-3][0-7]{2}$/.test(octal)) { bytes.push(parseInt(octal, 8)); i += 3; }
    else { const code = escapes[body[++i] ?? '']; bytes.push(code ?? 92); }
  }
  return Buffer.from(bytes).toString('utf8');
};
/** The end of a leading quoted path in `text`, or -1 when it does not start with one. */
const quotedEnd = (text: string) => {
  if (!text.startsWith('"')) return -1;
  for (let i = 1; i < text.length; i++) { if (text[i] === '\\') i++; else if (text[i] === '"') return i; }
  return -1;
};
/**
 * The paths one porcelain line names: one for a modified path (even one that itself contains
 * " -> "), both of a rename or copy — the source the commit holds and the destination the tree
 * holds (GY-1773: a rename out of a loaded path leaves the tree without that source, which the
 * loaded-path decisions must see). An unquoted pair is ambiguous when either side holds " -> ",
 * so it yields every possible split, longest destination first, and `checkoutState` keeps the
 * one whose destination the index holds.
 */
const porcelainCandidates = (line: string): { pairs: [string, string][]; single: string | null } => {
  const text = line.slice(3).trim();
  if (!/[RC]/.test(line.slice(0, 2))) return { pairs: [], single: unquotePath(text) };
  const end = quotedEnd(text);
  if (end >= 0) {
    const rest = text.slice(end + 1);
    return rest.startsWith(' -> ') ? { pairs: [[unquotePath(text.slice(0, end + 1)), unquotePath(rest.slice(4).trim())]], single: null } : { pairs: [], single: unquotePath(text) };
  }
  const pieces = text.split(' -> ');
  const pairs = pieces.slice(1).map((_, i): [string, string] => [unquotePath(pieces.slice(0, i + 1).join(' -> ').trim()), unquotePath(pieces.slice(i + 1).join(' -> ').trim())]);
  return pairs.length ? { pairs, single: null } : { pairs: [], single: unquotePath(text) };
};
/**
 * The checkout this process's own running code comes from: the directory above this tree's `src/`.
 * Under the test runner that is the suite's checkout, and GY-2018 keeps it out of every code-root
 * reading, wherever the suite stands.
 */
export function runningCheckoutRoot(): string {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  try { return realpathSync(root); } catch { return resolve(root); }
}
/** Whether two paths name one directory, compared as the filesystem resolves them. */
const sameCheckout = (left: string, right: string) => {
  const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
  return real(left) === real(right);
};
/**
 * The checkout the loop's loaded code comes from and its self-upgrade acts on: the one the running
 * CLI comes from — the directory above the configured launcher's `bin/` — never the managed
 * repository's root, whose HEAD names the managed project, not the code this process loaded (GY-1899).
 * For Graphyard's own install the two are one directory and nothing changes; a loop configured with
 * no CLI launcher could only ever have loaded the repository root, so that stands in. Under the test
 * runner only a checkout under the temporary directories is judged (`checkoutGuardApplies`, the
 * guard's own gate): a launcher a test passes from the checkout the suite itself runs from never
 * moves a test's upgrade off the root the test injected. That gate alone no longer holds the suite
 * out (GY-2018): the merge writer's trial runs this suite from a checkout under a temporary
 * directory, which the gate judged, so every fixture config's launcher — the bare `graphyard` one,
 * whose double dirname is the process's working directory — resolved to the suite's own tree and
 * eight proofs failed on the base tip itself. Wherever the suite stands, its own checkout is never
 * a judged one; `suite` names it so a test can hold a trial-shaped checkout to the same rule.
 */
export function loopCodeRoot(cliPath: string | null | undefined, repositoryRoot: string, suite: string | null = runningCheckoutRoot()): string {
  if (typeof cliPath !== 'string' || cliPath.length === 0) return repositoryRoot;
  const checkout = coordinatorCheckoutRoot(cliPath);
  // In production the guard does not apply and the CLI checkout stands (GY-1899); the suite's own
  // checkout is refused only under the test runner, which is the only place it is a gate.
  if (checkoutGuardApplies(checkout) && !(underTestRunner() && suite !== null && sameCheckout(checkout, suite))) return checkout;
  return repositoryRoot;
}

/**
 * The release the loop records, corrected to the commit its code checkout stands at when the
 * recorded commit could not be code this process loaded: it names a commit this checkout's
 * repository does not hold, so a startup read of the managed repository's HEAD wrote it (GY-1899).
 * A commit the repository holds is left alone, whether the checkout still stands there or moved on
 * after the load (GY-1464) — that gap is the restart the pass owes, never rewritten away — and a
 * read that fails corrects nothing. Null when the recorded release stands.
 */
export async function reconcileLoadedRelease(codeRoot: string, release: { commit: string | null; dirty: boolean | null } | null | undefined, run: ChildRun): Promise<{ commit: string; dirty: boolean | null } | null> {
  if (!release?.commit) return null;
  const standing = await checkoutState(codeRoot, run);
  if (!standing.commit || standing.commit === release.commit) return null;
  // git answers exit 1, and nothing else, for a well-formed commit the repository does not hold; every other
  // failure — a stub that cannot answer it included — leaves the recorded release standing.
  try { await run('git', ['-C', codeRoot, 'cat-file', '-e', release.commit]); return null; }
  catch (error: any) { if (error?.status !== 1) return null; }
  return { commit: standing.commit, dirty: standing.dirty };
}

export async function checkoutState(root: string, run: ChildRun): Promise<CheckoutState> {
  const git = (...args: string[]) => run('git', ['-C', root, ...args]);
  let commit: string | null;
  try { commit = (await git('rev-parse', 'HEAD')).trim() || null; }
  catch { return { commit: null, detached: null, dirty: null, dirtyPaths: [], branch: null }; }
  let detached: boolean | null = null, branch: string | null = null;
  try { branch = (await git('symbolic-ref', '-q', 'HEAD')).trim() || null; detached = branch ? false : null; }
  catch (error: any) { if (error?.status === 1) detached = true; }
  let dirty: boolean | null, dirtyPaths: string[] = [];
  try {
    for (const line of (await git('status', '--porcelain', '--untracked-files=no')).split('\n').filter(entry => entry.length > 3)) {
      const { pairs, single } = porcelainCandidates(line);
      let named = single ? [single] : pairs.at(-1)!;
      if (pairs.length > 1) for (const pair of pairs) { if ((await git('--literal-pathspecs', 'ls-files', '--', pair[1])).trim()) { named = pair; break; } }
      for (const path of named) if (path && !dirtyPaths.includes(path)) dirtyPaths.push(path);
    }
    dirty = dirtyPaths.length > 0;
  } catch { dirty = null; dirtyPaths = []; }
  return { commit, detached, dirty, dirtyPaths, branch };
}
