// Concern: GY-1773 — how the coordinator checkout stands (commit, HEAD, dirty paths), read from git.
import type { ChildRun } from '../child-runner.js';

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
