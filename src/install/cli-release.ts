// Deployment artifacts stay at their original paths for processes that already loaded them.
// Only current moves; neither the source tree nor node_modules of a published CLI is rebuilt.
import { existsSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, rename, symlink, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

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
