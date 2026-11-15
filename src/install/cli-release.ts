// Deployment artifacts stay at their original paths for processes that already loaded them.
// Only current moves; neither the source tree nor node_modules of a published CLI is rebuilt.
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, readlink, rename, symlink, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

// GY-3214: the paths and the create-once step live in plain JavaScript, which the published npm package runs before any dependency is installed.
import { cliReleasePath, currentCliPath, installLauncherPath, prepareCliRelease } from '../../bin/cli-release.mjs';
export { cliReleasePath, currentCliPath, installLauncherPath, prepareCliRelease };

/** Release launchers need the same stable, credential-free mount as the legacy launcher. */
export function cliMountRoot(root: string): string {
  return basename(dirname(root)) === 'cli-releases' && basename(resolve(root, '../..')) === '.graphyard'
    ? resolve(root, '../../..') : root;
}

export function activeCliRoot(root: string): string {
  try { return realpathSync(join(root, '.graphyard', 'cli-current')); } catch { return root; }
}

/** A path's real self, or null when it resolves to nothing. */
const realPath = (path: string): string | null => {
  try { return realpathSync(path); } catch { return null; }
};

/**
 * What a unit's ExecStart launcher actually starts (GY-3337): the launcher file itself, then the
 * release its own checkout's `cli-current` pointer selects — the same resolution `bin/graphyard.mjs`
 * performs at start. A plain launcher under no pointer resolves to itself.
 */
export function resolvedLauncher(launcher: string): string | null {
  const direct = realPath(launcher);
  if (direct === null) return null;
  const pointer = realPath(join(dirname(dirname(direct)), '.graphyard', 'cli-current'));
  return pointer ? join(pointer, 'bin', 'graphyard.mjs') : direct;
}

/**
 * Write the install's one stable launcher (GY-3337): `<installDir>/bin/graphyard.mjs`, a symlink to
 * the published release's own launcher, so what it starts moves with every publication and a unit
 * naming it can never hold a release path that goes stale. A no-op while this install publishes no
 * release. Written here by every publication, and by the unit's install (install/loop-unit.ts).
 */
export async function writeInstallLauncher(installDir: string): Promise<string | null> {
  const launcher = installLauncherPath(installDir);
  if (!existsSync(join(currentCliPath(installDir), 'bin', 'graphyard.mjs'))) return null;
  const wanted = relative(dirname(launcher), join(currentCliPath(installDir), 'bin', 'graphyard.mjs'));
  try { if (lstatSync(launcher).isSymbolicLink() && await readlink(launcher) === wanted) return launcher; } catch { /* absent: write it */ }
  await mkdir(dirname(launcher), { recursive: true });
  const staging = `${launcher}.tmp`;
  await unlink(staging).catch(() => {});
  await symlink(wanted, staging);
  await rename(staging, launcher);
  return launcher;
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
  // GY-3337: every publication rewrites the install's stable launcher beside the pointer it moves.
  await writeInstallLauncher(directory).catch(() => {});
}

/** The release a path names: the commit under a `cli-releases` store, null when it names none. */
export const releaseOfPath = (path: string): string | null => /\/cli-releases\/([0-9a-f]{6,40})(\/|$)/.exec(path)?.[1] ?? null;

/** A fault a loop unit's ExecStart holds against the release its install serves, with the fix; null when it starts the serving release (or nothing comparable). */
export interface UnitLauncherFault { unit: string; detail: string; fix: string }
export function unitLauncherFault(input: { unit: string; launcher: string | null; installDir: string; configHome?: string }): UnitLauncherFault | null {
  if (!input.launcher) return null;
  const fix = `graphyard master init --token-stdin --replace-supervisor from this checkout rewrites ${input.unit} onto this install's launcher, which always starts the release it serves`;
  const installDir = resolve(input.installDir), configHome = resolve(input.configHome ?? dirname(installDir));
  const within = (path: string, parent: string) => path === parent || path.startsWith(`${parent}/`);
  // The launcher's own spelling, its symlinks followed (the install launcher is one, into the
  // release it serves); a release tree's pointer protocol is not, because the fault is the stale
  // spelling itself — a unit naming an old release tree names a path a later publication may remove,
  // and one naming another install's names code that install serves, not this one's.
  const named = realPath(input.launcher) ?? resolve(input.launcher);
  if (within(named, configHome) && !within(named, installDir))
    return { unit: input.unit, detail: `${input.unit}'s ExecStart runs the CLI ${input.launcher}, which belongs to another install under ${configHome}, never this one's (${installDir})`, fix };
  const serving = realPath(currentCliPath(installDir));
  const running = releaseOfPath(named);
  if (running && (!serving || releaseOfPath(serving) !== running))
    return { unit: input.unit, detail: `${input.unit}'s ExecStart names the release ${running.slice(0, 12)} (${named}), not the release this install serves${serving ? ` (${basename(serving).slice(0, 12)})` : ' (none published)'}`, fix };
  return null;
}
