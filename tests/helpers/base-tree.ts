import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { temporaryDirectory } from './temp-dirs.js';

// GY-1726: run a module of another commit of this repository beside the candidate's own, so a test
// can show an instance reproducing against the base and not recurring against the candidate in one
// run. The commit's `src/` and `package.json` are extracted with `git archive` into a
// temporary directory whose `node_modules` is the one this checkout resolves, and the module is
// imported from there through the same tsx loader the suite runs under. CI's test shards check out
// two commits, so a commit the clone lacks is fetched from origin first, which needs its full sha.

/** The node_modules this checkout resolves packages from: its own, or the nearest ancestor's, as a worktree's is. */
function modules(from: string): string {
  for (let directory = from; ; directory = dirname(directory)) {
    if (existsSync(join(directory, 'node_modules'))) return join(directory, 'node_modules');
    if (dirname(directory) === directory) throw new Error(`No node_modules at or above ${from}`);
  }
}

const trees = new Map<string, Promise<string>>();

/** The extracted tree of `commit` (a full sha), made once per test file. */
export function sourceTree(commit: string): Promise<string> {
  let tree = trees.get(commit);
  if (!tree) trees.set(commit, tree = (async () => {
    const root = process.cwd();
    const resolve = () => execFileSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `${commit}^{commit}`], { encoding: 'utf8' }).trim();
    let sha: string;
    try { sha = resolve(); }
    catch {
      execFileSync('git', ['-C', root, 'fetch', '--quiet', '--no-tags', '--depth=1', 'origin', commit], { stdio: 'ignore' });
      sha = resolve();
    }
    const directory = await temporaryDirectory(`tree-${sha.slice(0, 12)}`);
    const archive = execFileSync('git', ['-C', root, 'archive', '--format=tar', sha, 'src', 'package.json'], { maxBuffer: 256 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', directory], { input: archive });
    symlinkSync(realpathSync(modules(root)), join(directory, 'node_modules'), 'dir');
    return directory;
  })());
  return tree;
}

/** Import `path` (relative to the repository root, such as `src/engine.ts`) as `commit` has it. */
export async function importAt<T = Record<string, any>>(commit: string, path: string): Promise<T> {
  return import(pathToFileURL(resolve(await sourceTree(commit), path)).href) as Promise<T>;
}
