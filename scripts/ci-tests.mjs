// Which test files the merge writer's trial executes (GY-499). The trial runs only the test files
// the change can affect; the install, the runner or configuration, and any change this module
// cannot map run every file, while a change limited to documentation runs none.
//
//   node scripts/ci-tests.mjs affected FILE...            the selection for changed FILEs: `mode: reason`, then
//                                                         the files it runs, one per line (every one when full)
//
// The dependency map is built from the source itself: every relative import, and every path a file
// names in text (`'../docs/x.md'`, `join(root, 'src')`, `${root}/src/cli.ts`), is an edge; a
// directory named is an edge to everything under it. Test files reach src modules transitively
// through those edges.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const defaultShardCount = 4;
export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every test file of the Node suite, as `npm test` runs it by default. */
export function listTestFiles(root = repositoryRoot) {
  return readdirSync(join(root, 'tests')).filter(name => name.endsWith('.test.ts')).sort().map(name => `tests/${name}`);
}

// ---- Shards ------------------------------------------------------------------------------------

/**
 * Splits `files` into `count` shards of as near as possible the same size: the files sorted, dealt
 * round-robin. Deterministic, so every shard job computes the same split independently.
 */
export function shardFiles(files, count = defaultShardCount) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`Shard count must be a positive integer: ${count}`);
  const shards = Array.from({ length: count }, () => []);
  [...new Set(files)].sort().forEach((file, at) => shards[at % count].push(file));
  return shards;
}

/** `"I/N"` as `{ index, count }`, 1-based. */
export function parseShard(text) {
  const match = String(text).match(/^(\d+)\/(\d+)$/);
  const index = Number(match?.[1]), count = Number(match?.[2]);
  if (!match || index < 1 || count < 1 || index > count) throw new Error(`--shard takes I/N with 1 <= I <= N: ${text}`);
  return { index, count };
}

// ---- Affected tests ----------------------------------------------------------------------------

const codeExtension = /\.(?:[cm]?[jt]sx?)$/;
// Changes that can alter any test's outcome without being imported by it: the install, the runner
// and its helpers, compiler and bundler configuration, CI itself, and this selection.
const fullSuitePaths = [
  /^package(?:-lock)?\.json$/, /^\.npmrc$/, /^tests\/helpers\//, /^tsconfig[\w.-]*\.json$/, /(?:^|\/)[\w-]+\.config\.[cm]?[jt]s$/,
  /^\.github\//, /^scripts\/ci-tests\.mjs$/, /^graphyard\.json$/,
];
// Documentation no test executes: prose a change cannot break, whether or not a test names its path.
const isDocumentation = file => file.startsWith('docs/') || file.endsWith('.md');

function trackedFiles(root) {
  try { return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean); }
  catch { return walk(root, '').filter(file => !file.startsWith('node_modules/') && !file.startsWith('.git/')); }
}
function walk(root, directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.name === 'node_modules' || entry.name === '.git') return [];
    return entry.isDirectory() ? walk(root, path) : [path];
  });
}

/**
 * Every edge out of one file: what its relative imports resolve to, and every tracked path or
 * directory its text names. `files` is the set of tracked files; `directories` maps a directory to
 * the files under it.
 */
export function fileEdges(file, text, files, directories) {
  const edges = new Set(), directory = posix.dirname(file);
  // A directory is a dependency only of a file that lists directories; elsewhere a named directory
  // is data (a fixture, a scope pattern), as is any path an application module names.
  const scans = /\breaddir(?:Sync)?\b|\bglob\b/.test(text), application = /^(?:src|web)\//.test(file);
  const add = (path, named = false) => {
    const normal = posix.normalize(path).replace(/\/$/, '');
    if (normal.startsWith('..') || !normal || normal === '.') return false;
    for (const candidate of [normal, normal.replace(/\.js$/, '.ts'), normal.replace(/\.js$/, '.tsx'), normal.replace(/\.mjs$/, '.mts'), `${normal}.ts`, `${normal}.tsx`, `${normal}.js`, `${normal}.mjs`, `${normal}/index.ts`, `${normal}/index.js`]) {
      if (files.has(candidate)) { edges.add(candidate); return true; }
    }
    if (directories.has(normal) && (!named || scans)) { for (const entry of directories.get(normal)) edges.add(entry); return true; }
    return false;
  };
  // Relative module specifiers: static and dynamic imports, re-exports, require, import.meta.resolve
  // and new URL(). A type-only import is erased before a test runs (the typecheck job checks types
  // over the whole tree), so it is no runtime dependency; neither is a `declare module` augmentation.
  const runtime = text.replace(/^\s*(?:import|export)\s+type\s[^;]*?\bfrom\s*(['"])[^'"\n]*\1;?/gm, '');
  for (const match of runtime.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bresolve\s*\(\s*|\bURL\s*\(\s*)(['"`])(\.{1,2}\/[^'"`\n]*)\1/g)) add(posix.join(directory, match[2]));
  if (application) return edges;
  // Paths named in text, relative to the file or to the repository root.
  const roots = [...new Set([...files].map(path => path.split('/')[0]))].filter(name => name !== '.' && name.length > 1).map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pathPattern = new RegExp(`(?<![\\w@.-])((?:\\.{1,2}/)*)((?:${roots.join('|')})(?:/[\\w.@-]+)*/?)(?![\\w@-])`, 'g');
  for (const match of runtime.matchAll(pathPattern)) {
    const [, up, path] = match;
    if (up && add(posix.join(directory, up + path), true)) continue;
    add(path, true);
  }
  return edges;
}

/**
 * The dependency map: every tracked file some test file reaches, transitively, mapped to the test
 * files that reach it. A test file maps to itself.
 */
export function dependencyMap(root = repositoryRoot, tests = listTestFiles(root)) {
  const tracked = trackedFiles(root).filter(file => existsSync(join(root, file)));
  const files = new Set(tracked), directories = new Map();
  for (const file of tracked) {
    const parts = file.split('/');
    for (let at = 1; at < parts.length; at++) { const directory = parts.slice(0, at).join('/'); directories.set(directory, [...(directories.get(directory) ?? []), file]); }
  }
  const edgeCache = new Map();
  const edgesOf = file => {
    if (!edgeCache.has(file)) edgeCache.set(file, codeExtension.test(file) && files.has(file) ? fileEdges(file, readFileSync(join(root, file), 'utf8'), files, directories) : new Set());
    return edgeCache.get(file);
  };
  const map = new Map();
  for (const test of tests) {
    const seen = new Set([test]), queue = [test];
    while (queue.length) for (const next of edgesOf(queue.pop())) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    for (const file of seen) map.set(file, [...(map.get(file) ?? []), test]);
  }
  return map;
}

/**
 * The test files a change affects, the full suite and why, or nothing. The full suite runs when
 * a changed file is outside the map (nothing reaches it, so nothing can say what it affects),
 * when it is the install, the runner or configuration, or when the changed files are unknown.
 * A change limited to documentation selects nothing: no test executes it.
 */
export function selectAffected(changed, map, tests) {
  if (!changed) return { mode: 'full', reason: 'the changed files are unknown', files: tests };
  const effective = changed.filter(file => !isDocumentation(file));
  if (!effective.length) return { mode: 'affected', reason: `${changed.length} changed file(s) are documentation only`, files: [] };
  for (const file of effective) {
    if (fullSuitePaths.some(pattern => pattern.test(file))) return { mode: 'full', reason: `${file} changes the install, the test runner or configuration`, files: tests };
    if (!map.has(file)) return { mode: 'full', reason: `${file} is not in the dependency map`, files: tests };
  }
  const selected = new Set(effective.flatMap(file => map.get(file)));
  return { mode: 'affected', reason: `${selected.size} of ${tests.length} test files are affected by ${effective.length} changed file(s)`, files: tests.filter(test => selected.has(test)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'affected') {
    const selection = selectAffected(args, dependencyMap(), listTestFiles());
    // The files follow in both modes, so the merge writer's trial runs exactly this selection; an empty one runs nothing.
    console.log(`${selection.mode}: ${selection.reason}`); if (selection.files.length) console.log(selection.files.join('\n'));
  } else {
    throw new Error('Usage: ci-tests affected FILE...');
  }
}
