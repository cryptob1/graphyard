// Concern: GY-3418 — two caches keyed by content that spare trials work they already did. A miss
// runs exactly as before; nothing here decides a verdict.
// The warm dependency image: the node_modules an `npm ci` installed, committed in the repository's
// git directory by the trial image and the lockfile, so a later trial of another head with the same two
// reuses it read-only instead of installing again. The test-result cache: a test file that passed
// in a trial (a merge trial or the batch gate, never a worker's own run) is not run again while
// its own content, the local sources it imports (transitively) and the dependency key are the same.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { cp, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);

/** The dependency key: the image the trial runs in and its lockfile's content. */
export const dependencyKey = (image: string, lockfile: string) => sha(`${image}\0${lockfile}`);

/** Where the committed dependency images live in the cache root (the repository's git directory, never the worktree root a trial must leave empty). */
export const dependencyImagesDirectory = (cacheRoot: string) => resolve(cacheRoot, 'graphyard-dependency-images');
/** How many dependency images stay: a lockfile change commits a new one and the oldest goes. */
export const keptDependencyImages = 3;

/** The committed node_modules for `key`, or null when none is committed yet. */
export function warmDependencies(cacheRoot: string, key: string): string | null {
  const modules = join(dependencyImagesDirectory(cacheRoot), key, 'node_modules');
  return existsSync(modules) ? modules : null;
}

/** Commit an installed node_modules under `key` (copied, then renamed into place whole), keeping the newest few. */
export async function commitDependencies(cacheRoot: string, key: string, nodeModules: string): Promise<void> {
  const directory = dependencyImagesDirectory(cacheRoot), target = join(directory, key);
  if (existsSync(target)) return;
  const staging = join(directory, `.staging-${randomUUID()}`);
  await mkdir(staging, { recursive: true });
  try {
    await cp(nodeModules, join(staging, 'node_modules'), { recursive: true, verbatimSymlinks: true });
    await rename(staging, target).catch(() => {}); // another trial committed the same key first
  } finally { await rm(staging, { recursive: true, force: true }); }
  const entries = await Promise.all((await readdir(directory)).map(async name => ({ name, at: (await stat(join(directory, name))).mtimeMs })));
  // A copy a killed trial left half-staged goes after an hour; of the committed images the newest few stay.
  const stale = entries.filter(entry => entry.name.startsWith('.staging-') && entry.at < Date.now() - 3_600_000);
  const old = entries.filter(entry => !entry.name.startsWith('.')).sort((a, b) => b.at - a.at).slice(keptDependencyImages);
  for (const entry of [...stale, ...old]) await rm(join(directory, entry.name), { recursive: true, force: true });
}

/** The extensions whose imports the test-result key follows; a change to any other file runs every selected test. */
export const moduleFile = (path: string) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path);
const importPattern = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/**
 * Each test file's result key in `worktree`: its content, every local source it imports
 * transitively (relative specifiers, `.js` resolving to `.ts` as tsc emits them) and `dependencies`.
 * Contents are read once per call.
 */
export function testResultKeys(worktree: string, files: readonly string[], dependencies: string): Map<string, string> {
  const contents = new Map<string, string | null>();
  const read = (path: string) => {
    if (!contents.has(path)) { try { contents.set(path, statSync(path).isFile() ? readFileSync(path, 'utf8') : null); } catch { contents.set(path, null); } }
    return contents.get(path)!;
  };
  const resolveImport = (from: string, specifier: string) => {
    const base = resolve(dirname(from), specifier);
    return [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), base.replace(/\.mjs$/, '.mts'), `${base}.ts`, join(base, 'index.ts')].find(path => read(path) !== null);
  };
  const keys = new Map<string, string>();
  for (const file of files) {
    const start = join(worktree, file), seen = new Set<string>([start]), queue = [start], hash = createHash('sha256').update(dependencies);
    while (queue.length) {
      const path = queue.shift()!, text = read(path);
      hash.update(`\0${relative(worktree, path)}\0${text ?? ''}`);
      if (text === null) continue;
      for (const match of text.matchAll(importPattern)) {
        const found = resolveImport(path, match[1]!);
        if (found && !seen.has(found) && !relative(worktree, found).startsWith('..')) { seen.add(found); queue.push(found); }
      }
    }
    keys.set(file, hash.digest('hex').slice(0, 40));
  }
  return keys;
}

/** Where passing results live: one directory per UTC day, the last seven read and kept. */
export const testResultsDirectory = (cacheRoot: string) => resolve(cacheRoot, 'graphyard-test-results');
const keptDays = 7;
const days = (now: number) => Array.from({ length: keptDays }, (_, index) => new Date(now - index * 86_400_000).toISOString().slice(0, 10));

/** The files whose key passed in a trial within the last seven days. */
export function cachedPasses(cacheRoot: string, keys: ReadonlyMap<string, string>, now = Date.now()): Set<string> {
  const directory = testResultsDirectory(cacheRoot), recent = days(now);
  return new Set([...keys].filter(([, key]) => recent.some(day => existsSync(join(directory, day, key)))).map(([file]) => file));
}

/** Record each passing file's key under today, and drop days older than seven. */
export async function recordPasses(cacheRoot: string, keys: readonly string[], now = Date.now()): Promise<void> {
  if (!keys.length) return;
  const directory = testResultsDirectory(cacheRoot), recent = days(now);
  await mkdir(join(directory, recent[0]!), { recursive: true });
  await Promise.all(keys.map(key => writeFile(join(directory, recent[0]!, key), '')));
  for (const day of await readdir(directory)) if (!recent.includes(day)) await rm(join(directory, day), { recursive: true, force: true });
}
