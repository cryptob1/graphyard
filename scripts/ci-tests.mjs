// Which test files a CI run executes, and on which shard (GY-499). The required `test` check is an
// aggregating job over a matrix of shard jobs (.github/workflows/ci.yml); each shard runs the files
// this module assigns it, balanced by the per-file durations recorded in
// tests/helpers/timing-baseline.json. On a pull request's own CI only the test files the change can
// affect run; pushes to main, merge-queue tips and any change this module cannot map run everything.
//
//   node scripts/ci-tests.mjs select --out FILE           the files this CI run executes, one per line
//   node scripts/ci-tests.mjs shards [N]                  the balanced shards of the full suite
//   node scripts/ci-tests.mjs affected FILE...            the selection for changed FILEs
//   node scripts/ci-tests.mjs durations RECORD.jsonl...   write measured per-file durations into the baseline
//
// The dependency map is built from the source itself: every relative import, and every path a file
// names in text (`'../docs/x.md'`, `join(root, 'src')`, `${root}/src/cli.ts`), is an edge; a
// directory named is an edge to everything under it. Test files reach src modules transitively
// through those edges. It is a speed-up for the pull request's own run only: the full suite runs
// again on the merge-queue tip, so a dependency the map misses is caught before anything lands.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const defaultShardCount = 4;
export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const baselinePath = 'tests/helpers/timing-baseline.json';
/** The subject Graphyard gives the commit of a speculative merge-queue tip (src/github.ts). */
export const speculativeTipSubject = /^Graphyard speculative tip for /;

/** Every test file of the Node suite, as `npm test` runs it by default. */
export function listTestFiles(root = repositoryRoot) {
  return readdirSync(join(root, 'tests')).filter(name => name.endsWith('.test.ts')).sort().map(name => `tests/${name}`);
}

// ---- Shards ------------------------------------------------------------------------------------

/** The recorded wall time of each test file in milliseconds, from the timing baseline. */
export function readDurations(root = repositoryRoot) {
  const file = join(root, baselinePath);
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8')).files ?? {};
}

const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 1000; };

/**
 * Splits `files` into `count` shards whose recorded durations are as even as the files allow:
 * longest first, each onto the shard with the least time so far. A file with no recorded duration
 * (one added since the baseline was recorded) counts as the median file. Deterministic, so every
 * shard job computes the same split independently.
 */
export function shardFiles(files, durations, count = defaultShardCount) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`Shard count must be a positive integer: ${count}`);
  const fallback = median(Object.values(durations).filter(value => Number.isFinite(value)));
  const weight = file => Number.isFinite(durations[file]) ? durations[file] : fallback;
  const shards = Array.from({ length: count }, () => ({ files: [], durationMs: 0 }));
  for (const file of [...new Set(files)].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const lightest = shards.reduce((best, shard) => shard.durationMs < best.durationMs ? shard : best);
    lightest.files.push(file); lightest.durationMs += weight(file);
  }
  for (const shard of shards) shard.files.sort();
  return shards;
}

/** `"I/N"` as `{ index, count }`, 1-based. */
export function parseShard(text) {
  const match = String(text).match(/^(\d+)\/(\d+)$/);
  const index = Number(match?.[1]), count = Number(match?.[2]);
  if (!match || index < 1 || count < 1 || index > count) throw new Error(`--shard takes I/N with 1 <= I <= N: ${text}`);
  return { index, count };
}

/** How far apart the shards finish, as a fraction of the longest: (longest - shortest) / longest. */
export const shardImbalance = shards => { const times = shards.map(shard => shard.durationMs), max = Math.max(...times); return max ? (max - Math.min(...times)) / max : 0; };

/** Merges node:test file-duration records (tests/helpers/file-durations.mjs) into the baseline's `files`. */
export function mergeDurations(baseline, records, testFiles) {
  const measured = {};
  for (const line of records.join('\n').split('\n')) {
    if (!line.trim()) continue;
    const { file, durationMs } = JSON.parse(line);
    if (typeof file === 'string' && Number.isFinite(durationMs)) measured[file] = Math.max(measured[file] ?? 0, Math.round(durationMs));
  }
  const files = {};
  for (const file of testFiles) { const value = measured[file] ?? baseline.files?.[file]; if (value !== undefined) files[file] = value; }
  return { ...baseline, files };
}

// ---- Affected tests ----------------------------------------------------------------------------

const codeExtension = /\.(?:[cm]?[jt]sx?)$/;
// Changes that can alter any test's outcome without being imported by it: the install, the runner
// and its helpers, compiler and bundler configuration, CI itself, and this selection.
const fullSuitePaths = [
  /^package(?:-lock)?\.json$/, /^\.npmrc$/, /^tests\/helpers\//, /^tsconfig[\w.-]*\.json$/, /(?:^|\/)[\w-]+\.config\.[cm]?[jt]s$/,
  /^\.github\//, /^scripts\/ci-tests\.mjs$/, /^graphyard\.json$/,
];

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
  // is data (a planned-files fixture, a scope pattern), as is any path an application module names.
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
 * The test files a change affects, or the full suite and why. The full suite runs when a changed
 * file is outside the map (nothing reaches it, so nothing can say what it affects), when it is the
 * install, the runner or configuration, or when the changed files are unknown.
 */
export function selectAffected(changed, map, tests) {
  if (!changed) return { mode: 'full', reason: 'the changed files are unknown', files: tests };
  for (const file of changed) {
    if (fullSuitePaths.some(pattern => pattern.test(file))) return { mode: 'full', reason: `${file} changes the install, the test runner or configuration`, files: tests };
    if (!map.has(file)) return { mode: 'full', reason: `${file} is not in the dependency map`, files: tests };
  }
  const selected = new Set(changed.flatMap(file => map.get(file)));
  return { mode: 'affected', reason: `${selected.size} of ${tests.length} test files are affected by ${changed.length} changed file(s)`, files: tests.filter(test => selected.has(test)) };
}

/**
 * The selection for one CI run. Only a pull_request event may narrow the suite, and never for a
 * merge-queue tip: Graphyard pushes a speculative tip to the pull request's own branch, so a head
 * whose commit is a speculative tip, or that a published queue ref points at, runs everything —
 * as does every push to main and every other event.
 */
export function selectForRun({ event, headSubject, queued, changed, map, tests }) {
  if (event !== 'pull_request') return { mode: 'full', reason: `a ${event || 'local'} run always runs the full suite`, files: tests };
  if (headSubject !== undefined && speculativeTipSubject.test(headSubject)) return { mode: 'full', reason: 'the head is a merge-queue speculative tip', files: tests };
  if (queued === null) return { mode: 'full', reason: 'the merge-queue refs could not be read, so the head may be a queue tip', files: tests };
  if (queued) return { mode: 'full', reason: 'the head is published as a merge-queue tip', files: tests };
  return selectAffected(changed, map, tests);
}

// ---- CI ------------------------------------------------------------------------------------------

const git = (args, root) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };

/**
 * Reads this run from the Actions environment. A pull_request checkout is GitHub's merge of the
 * head onto the base, so its first parent is the base and its second the pull request's head.
 */
export function runContext(root = repositoryRoot, environment = process.env) {
  const event = environment.GITHUB_EVENT_NAME ?? '';
  if (event !== 'pull_request') return { event };
  const payload = environment.GITHUB_EVENT_PATH && existsSync(environment.GITHUB_EVENT_PATH) ? JSON.parse(readFileSync(environment.GITHUB_EVENT_PATH, 'utf8')) : {};
  const head = payload.pull_request?.head?.sha ?? git(['rev-parse', 'HEAD^2'], root);
  const diff = git(['diff', '--name-only', 'HEAD^1', 'HEAD'], root);
  const refs = git(['ls-remote', 'origin', 'refs/graphyard/queue/*'], root);
  return {
    event,
    headSubject: (head && git(['log', '-1', '--format=%s', head], root)) ?? undefined,
    queued: refs === null || !head ? null : refs.split('\n').some(line => line.split('\t')[0] === head),
    changed: diff === null ? null : diff.split('\n').filter(Boolean),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const option = name => { const at = args.indexOf(name); return at < 0 ? null : args[at + 1]; };
  const tests = listTestFiles();
  if (command === 'select') {
    const context = runContext();
    const needsMap = context.event === 'pull_request' && context.changed && context.queued === false && !speculativeTipSubject.test(context.headSubject ?? '');
    const selection = selectForRun({ ...context, map: needsMap ? dependencyMap() : new Map(), tests });
    const out = option('--out');
    if (out) writeFileSync(out, selection.files.map(file => `${file}\n`).join('')); else console.log(selection.files.join('\n'));
    const summary = `### Test selection\n\n${selection.mode === 'full' ? 'Full suite' : 'Affected tests only'}: ${selection.reason}.\n\n${selection.files.length} test file(s) selected.\n`;
    console.error(summary);
    if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' });
  } else if (command === 'shards') {
    const shards = shardFiles(tests, readDurations(), Number(args[0] ?? defaultShardCount));
    shards.forEach((shard, at) => console.log(`shard ${at + 1}: ${shard.files.length} files, ${Math.round(shard.durationMs / 1000)}s recorded`));
    console.log(`imbalance ${(shardImbalance(shards) * 100).toFixed(1)}%`);
  } else if (command === 'affected') {
    const selection = selectAffected(args, dependencyMap(), tests);
    console.log(`${selection.mode}: ${selection.reason}`); if (selection.mode === 'affected') console.log(selection.files.join('\n'));
  } else if (command === 'durations') {
    if (!args.length) throw new Error('Usage: ci-tests durations RECORD.jsonl...');
    const file = join(repositoryRoot, baselinePath);
    const merged = mergeDurations(JSON.parse(readFileSync(file, 'utf8')), args.map(path => readFileSync(path, 'utf8')), tests);
    writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
    console.log(`Recorded durations for ${Object.keys(merged.files).length} of ${tests.length} test files in ${relative(process.cwd(), file)}`);
  } else {
    throw new Error('Usage: ci-tests select [--out FILE] | shards [N] | affected FILE... | durations RECORD.jsonl...');
  }
}
