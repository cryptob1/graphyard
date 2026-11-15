// Deployment artifacts stay at their original paths for processes that already loaded them.
// Only current moves; neither the source tree nor node_modules of a published CLI is rebuilt.
import { existsSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, stat, symlink, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { ChildRun } from '../child-runner.js';
import { directoryBytes } from '../daemon/leftovers.js';
import { livePaths } from '../session-processes.js';

// GY-3214: the paths and the create-once step live in plain JavaScript, which the published npm package runs before any dependency is installed.
import { cliReleasePath, currentCliPath, prepareCliRelease } from '../../bin/cli-release.mjs';
export { cliReleasePath, currentCliPath, prepareCliRelease };

/** Release launchers need the same stable, credential-free mount as the legacy launcher. */
export function cliMountRoot(root: string): string {
  return basename(dirname(root)) === 'cli-releases' && basename(resolve(root, '../..')) === '.graphyard'
    ? resolve(root, '../../..') : root;
}

export function activeCliRoot(root: string): string {
  try { return realpathSync(join(root, '.graphyard', 'cli-current')); } catch { return root; }
}

/** Publish after health. The legacy build path remains loadable, including on the first handover. */
export async function publishCliRelease(directory: string, source: string, commit: string) {
  const target = cliReleasePath(directory, commit), current = currentCliPath(directory);
  const next = `${current}.tmp`;
  // A prior interrupted publication may have left its temporary symlink.
  await unlink(next).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await symlink(target, next);
  await rename(next, current);
  for (const root of new Set([source, join(directory, 'deploy', 'build'), target])) {
    if (!existsSync(join(root, 'bin', 'graphyard.mjs'))) continue;
    // Bring old launchers onto the pointer protocol without replacing their dependencies or code.
    if (root !== target) {
      const launcher = join(root, 'bin', 'graphyard.mjs');
      await copyFile(join(target, 'bin', 'graphyard.mjs'), `${launcher}.tmp`);
      await rename(`${launcher}.tmp`, launcher);
    }
    await mkdir(join(root, '.graphyard'), { recursive: true });
    const pointer = join(root, '.graphyard', 'cli-current');
    if (!existsSync(pointer)) await symlink(current, pointer);
  }
}

/**
 * GY-3334: removes the install's release copies nothing uses. Kept: the one served, every one readied
 * after it (a deploy in flight or a failed tip), the newest readied before it (the previous release),
 * and any a live process names. A copy goes only through `git worktree remove` in the checkout whose
 * worktree entry points back at it, so no other entry is touched and nothing is pruned; a copy whose
 * owner cannot be established (a clone, a broken link) or whose removal fails stays, answered in `left`.
 */
export async function sweepCliReleases(directory: string, run: ChildRun, procRoot = '/proc') {
  const swept = { removed: [] as string[], bytes: 0, left: [] as string[] };
  const store = dirname(cliReleasePath(directory, 'x'));
  let serving: string;
  try { serving = realpathSync(currentCliPath(directory)); } catch { return swept; }
  const readyAt = (path: string) => stat(join(path, '.graphyard', 'cli-ready')).catch(() => stat(path)).then(info => info.mtimeMs, () => 0);
  const copies = await Promise.all((await readdir(store, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory()).map(async entry => ({ path: realpathSync(join(store, entry.name)), at: await readyAt(join(store, entry.name)) })));
  const served = copies.find(copy => copy.path === serving);
  if (!served) return swept;
  const previous = copies.filter(copy => copy.at < served.at).sort((a, b) => b.at - a.at)[0];
  const live = livePaths(procRoot);
  for (const copy of copies) {
    if (copy.at >= served.at || copy === previous || live.some(path => path === copy.path || path.startsWith(`${copy.path}/`))) continue;
    const link = /^gitdir: (.+)$/m.exec(await readFile(join(copy.path, '.git'), 'utf8').catch(() => ''))?.[1]?.trim();
    const entry = link && resolve(copy.path, link);
    const back = entry && await readFile(join(entry, 'gitdir'), 'utf8').then(text => realpathSync(resolve(entry, text.trim())), () => null);
    if (!entry || back !== join(copy.path, '.git')) { swept.left.push(`${copy.path} (no checkout's worktree entry points at it)`); continue; }
    const bytes = await directoryBytes(copy.path) ?? 0;
    try { await run('git', ['--git-dir', resolve(entry, '../..'), 'worktree', 'remove', '--force', copy.path], { timeoutMs: 300_000 }); }
    catch (error) { swept.left.push(`${copy.path} (${error instanceof Error ? error.message : String(error)})`); continue; }
    swept.removed.push(copy.path);
    swept.bytes += bytes;
  }
  return swept;
}
