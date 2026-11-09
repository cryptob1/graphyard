// How a CLI release tree comes to exist under an install directory. Plain JavaScript with no
// dependency: the published npm package (GY-3214) runs it before any dependency is installed, and
// src/install/cli-release.ts runs the same code for the deploy watch.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Keep publication inside the checkout already mounted in legacy masked sessions.
const releaseStore = directory => join(directory, 'deploy', 'build', '.graphyard');
export const cliReleasePath = (directory, commit) => join(releaseStore(directory), 'cli-releases', commit);
export const currentCliPath = directory => join(releaseStore(directory), 'cli-published');

/**
 * Create once, install once. A failed install can be retried without touching any published tree.
 * `source` is a Graphyard checkout, which gains a detached worktree at `commit`, or — on a host
 * that holds no checkout — a clone URL, cloned at `commit` so later releases are worktrees of it.
 */
export async function prepareCliRelease(directory, source, commit, run) {
  const target = cliReleasePath(directory, commit);
  await mkdir(resolve(target, '..'), { recursive: true });
  if (/^[a-z+]+:\/\//.test(source)) {
    if (!existsSync(join(target, '.git'))) await run('git', ['clone', '--quiet', '--no-checkout', source, target], { timeoutMs: 1_800_000 });
    await run('git', ['-C', target, 'checkout', '--quiet', '--detach', commit]);
  } else if (!existsSync(join(target, '.git'))) await run('git', ['-C', source, 'worktree', 'add', '--detach', '--quiet', target, commit]);
  if (!existsSync(join(target, '.graphyard', 'cli-ready'))) {
    await run('npm', ['ci', '--prefix', target], { cwd: target, timeoutMs: 1_800_000 });
    await mkdir(join(target, '.graphyard'), { recursive: true });
    await writeFile(join(target, '.graphyard', 'cli-ready'), commit);
  }
  return target;
}
