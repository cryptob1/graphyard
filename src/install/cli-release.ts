// Deployment artifacts stay at their original paths for processes that already loaded them.
// Only current moves; neither the source tree nor node_modules of a published CLI is rebuilt.
import { existsSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ChildRun } from '../child-runner.js';

export const cliReleasePath = (directory: string, commit: string) => join(directory, 'deploy', 'releases', commit);
export const currentCliPath = (directory: string) => join(directory, 'deploy', 'current');

export function activeCliRoot(root: string): string {
  try { return realpathSync(join(root, '.graphyard', 'cli-current')); } catch { return root; }
}

/** Create once, install once. A failed install can be retried without touching any published tree. */
export async function prepareCliRelease(directory: string, source: string, commit: string, run: ChildRun) {
  const target = cliReleasePath(directory, commit);
  await mkdir(resolve(target, '..'), { recursive: true });
  if (!existsSync(join(target, '.git'))) await run('git', ['-C', source, 'worktree', 'add', '--detach', '--quiet', target, commit]);
  if (!existsSync(join(target, '.graphyard', 'cli-ready'))) {
    await run('npm', ['ci', '--prefix', target], { cwd: target, timeoutMs: 1_800_000 });
    await mkdir(join(target, '.graphyard'), { recursive: true });
    await writeFile(join(target, '.graphyard', 'cli-ready'), commit);
  }
  return target;
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
