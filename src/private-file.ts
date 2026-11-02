import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, chmod } from 'node:fs/promises';
import { resolve, isAbsolute, dirname, basename, relative, sep } from 'node:path';
import { defaultChildRun } from './child-runner.js';
import { writeFailure } from './disk-space.js';

export async function privateFile(file: string) {
  const info = await lstat(file);
  if (!info.isFile() || info.mode & 0o077) throw new Error(`${file} must be a regular file with mode 0600`);
  return info;
}
export async function readCredentialFile(file: string) {
  await privateFile(file);
  const value = (await readFile(file, 'utf8')).trim();
  if (value.length < 32 || value.length > 10_000) throw new Error('Worker credential file must contain one valid token');
  return value;
}
async function repositoryWorktrees(root: string) {
  let worktrees: string[];
  try {
    const records = (await defaultChildRun('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: root })).split('\0');
    worktrees = records.filter(record => record.startsWith('worktree ')).map(record => resolve(record.slice('worktree '.length)));
  } catch { throw new Error('Cannot verify credential location because the complete Git worktree inventory is unavailable'); }
  if (!worktrees.length) throw new Error('Cannot verify credential location because Git returned an empty worktree inventory');
  // A registered worktree whose path is missing or hidden (a removed proof worktree, or one under
  // a mount this process cannot see) is compared by its registered path: it cannot be resolved,
  // but a target lexically inside it is still refused, and it never stops the loop.
  return Promise.all(worktrees.map(worktree => realpath(worktree).catch(() => worktree)));
}
/**
 * Where a path is, or would be created: a target that does not exist yet is judged by its nearest
 * existing ancestor, so a directory can be refused before anything is written into a worktree.
 */
async function canonicalLocation(target: string) {
  const missing: string[] = [];
  for (let current = resolve(target); ; current = dirname(current)) {
    try { return resolve(await realpath(current), ...missing); }
    catch (error: any) { if (error?.code !== 'ENOENT' || dirname(current) === current) throw error; missing.unshift(basename(current)); }
  }
}
export async function assertOutsideWorktrees(root: string, target: string, label: string, options: { create?: boolean } = {}) {
  const canonicalTarget = options.create ? await canonicalLocation(target) : await realpath(target);
  const worktrees = await repositoryWorktrees(root);
  for (const worktree of worktrees) {
    const fromRoot = relative(worktree, canonicalTarget);
    const inside = fromRoot === '' || fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
    if (inside) throw new Error(`${label} must be outside every worktree of the repository`);
  }
}
export async function atomicPrivateWrite(file: string, value: unknown) {
  return atomicPrivateText(file, JSON.stringify(value, null, 2));
}
export async function atomicPrivateText(file: string, value: string) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const { writeFile, rename } = await import('node:fs/promises');
  // A master file that cannot be written because the host is out of room says so: the same
  // failure reported as an unexplained write error costs an investigation every time.
  try { await writeFile(temporary, value, { mode: 0o600, flag: 'wx' }); await rename(temporary, file); }
  catch (error) { throw writeFailure(error, `Writing ${file}`); }
  await chmod(file, 0o600);
}
