// Concern: resolving the Git directories a coordinator checkout writes through — its common Git directory and its own linked-worktree admin — when its `.git` is a pointer file (GY-957).
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Whether `path` is a directory (or nothing); symlinks to directories count, as bwrap binds resolve them. */
const isDirectoryPath = (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } };
/** The linked-worktree admin directory a checkout's `.git` pointer file names, resolved against the checkout, or null when its `.git` is unreadable or not a pointer. The path runs to the end of the line as Git writes it, so one holding whitespace resolves too (GY-957, acceptance finding). */
export const gitPointerAdminDirectory = (directory: string): string | null => {
  let pointer: string;
  try { pointer = readFileSync(join(directory, '.git'), 'utf8'); } catch { return null; }
  const match = /^gitdir: (.+?)[\r\n]*$/.exec(pointer);
  return match ? resolve(directory, match[1]) : null;
};

/**
 * The common Git directory the checkout at `root` writes through: its `.git` when that is the repository
 * directory itself, otherwise the common directory the `.git` pointer's worktree admin names through its
 * `commondir` marker — a directory outside the checkout when the checkout itself is a linked worktree
 * (GY-957, review finding). Every Git path the confinement protects or re-exposes resolves here, never
 * under a `.git` that may be a pointer file; a pointer that names no Git directory throws the
 * `checkoutGitProblem` reason rather than falling back to the pointer file.
 */
export const checkoutGitDirectory = (root: string): string => {
  const resolved = resolveCheckoutGitDirectory(root);
  if ('problem' in resolved) throw new Error(resolved.problem);
  return resolved.directory;
};
/**
 * Why the checkout's `.git` is a file that names no Git directory, or null: a pointer that cannot be
 * parsed, whose admin or common directory is missing, or whose worktree admin has no readable
 * `commondir`, would otherwise leave the confinement
 * protecting the pointer file itself and re-exposing nothing, so every launch refuses on it instead
 * (GY-957, review follow-up).
 */
export const checkoutGitProblem = (root: string): string | null => { const resolved = resolveCheckoutGitDirectory(root); return 'problem' in resolved ? resolved.problem : null; };
const resolveCheckoutGitDirectory = (root: string): { directory: string } | { problem: string } => {
  const checkout = resolve(root), gitPath = join(checkout, '.git');
  try { if (statSync(gitPath).isDirectory()) return { directory: gitPath }; } catch { return { directory: gitPath }; }
  const admin = gitPointerAdminDirectory(checkout);
  if (!admin) return { problem: `its .git at ${gitPath} is a file but not a readable "gitdir: <path>" pointer` };
  if (!isDirectoryPath(admin)) return { problem: `its .git pointer names ${admin}, which is not a directory` };
  let common: string;
  // No readable `commondir`: only a whole Git directory — `--separate-git-dir` or a submodule, which
  // carries its own object store — is the directory itself. A linked-worktree admin without one
  // refuses, since binding only the admin would leave the real common directory writable (GY-1054).
  try { common = readFileSync(join(admin, 'commondir'), 'utf8').trim(); } catch {
    return isDirectoryPath(join(admin, 'objects')) ? { directory: admin } : { problem: `its worktree admin ${admin} has no readable commondir naming its common Git directory` };
  }
  const directory = common ? resolve(admin, common) : admin;
  return isDirectoryPath(directory) ? { directory } : { problem: `its worktree admin ${admin} names the common Git directory ${directory}, which is not a directory` };
};

/** The checkout's own linked-worktree admin directory — where its HEAD, index and FETCH_HEAD live — or null when its `.git` is the repository directory itself, so those paths sit directly under the common Git directory. */
export const checkoutWorktreeAdminDirectory = (root: string): string | null => {
  const checkout = resolve(root);
  if (isDirectoryPath(join(checkout, '.git'))) return null;
  const admin = gitPointerAdminDirectory(checkout);
  return admin && isDirectoryPath(admin) ? admin : null;
};
