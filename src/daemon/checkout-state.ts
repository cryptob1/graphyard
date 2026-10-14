// Concern: GY-1773 — how the coordinator checkout stands (commit, HEAD, dirty paths), read from git.
import type { ChildRun } from '../child-runner.js';

/** How the coordinator checkout stands: its commit, whether HEAD is detached, and whether tracked files differ from the commit (`dirtyPaths` names them). */
export interface CheckoutState { commit: string | null; detached: boolean | null; dirty: boolean | null; dirtyPaths: string[]; branch: string | null }
/** The paths of a porcelain status: the second of a rename's pair is the path the tree holds. */
const unquotePath = (path: string) => {
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
 * Only a rename or copy line holds a pair; a modified path that itself contains " -> " is one path.
 * An unquoted pair is ambiguous when the destination holds " -> " too, so it yields every possible
 * destination, longest first, and `checkoutState` keeps the one the index holds.
 */
const porcelainCandidates = (line: string): { paths: string[]; pair: boolean } => {
  const text = line.slice(3).trim();
  if (!/[RC]/.test(line.slice(0, 2))) return { paths: [unquotePath(text)], pair: false };
  const end = quotedEnd(text);
  if (end >= 0) return { paths: [unquotePath(text.slice(end + 1).startsWith(' -> ') ? text.slice(end + 5).trim() : text)], pair: false };
  const pieces = text.split(' -> ');
  const paths = pieces.slice(1).map((_, i) => unquotePath(pieces.slice(i + 1).join(' -> ').trim()));
  return { paths: paths.length ? paths : [unquotePath(text)], pair: paths.length > 1 };
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
      const { paths, pair } = porcelainCandidates(line);
      let chosen = paths.at(-1)!;
      if (pair) for (const path of paths) { if ((await git('--literal-pathspecs', 'ls-files', '--', path)).trim()) { chosen = path; break; } }
      if (chosen) dirtyPaths.push(chosen);
    }
    dirty = dirtyPaths.length > 0;
  } catch { dirty = null; dirtyPaths = []; }
  return { commit, detached, dirty, dirtyPaths, branch };
}
