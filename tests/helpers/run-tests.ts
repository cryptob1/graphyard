import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseShard, readDurations, shardFiles } from '../../scripts/ci-tests.mjs';
import { isolatedTestEnvironment, reserveTestPorts, testPortEnvironment, type ReserveOptions } from '../../src/cli/test-isolation.js';

// The suite's own runner (GY-174): `npm test` and `npm run test:browser` start here, so a clean run
// needs nothing the session has to know about the host.
//
//   node --import tsx tests/helpers/run-tests.ts [FILE...]            the Node suite (default tests/*.test.ts)
//   node --import tsx tests/helpers/run-tests.ts --browser [ARGS...]  the Playwright suite
//
// Three runner options select and measure the Node suite's files (GY-499), as CI's shard jobs do:
//   --files-from LIST   run the files LIST names, one per line (an empty list runs nothing)
//   --shard I/N         run only shard I of N, balanced by tests/helpers/timing-baseline.json,
//                       longest file first (tests/helpers/ordered-tests.mjs)
//   --durations FILE    also write each file's wall time to FILE (tests/helpers/file-durations.mjs)
//
// Every GRAPHYARD_* and HERDR_* variable the caller carries is withheld from the tests except the
// harness controls in src/cli/test-isolation.ts; GRAPHYARD_TEST_PORT is a window of free ports this
// run holds until it exits, and GRAPHYARD_BROWSER_PORT the dev server's port. Two runs on one host —
// two worktrees, or a worker beside a producer — therefore never share a database or a server.

/** The browser suite's historical port, tried first. */
export const defaultBrowserPort = 4319;

export interface RunOptions {
  cwd?: string;
  /** Test files or extra `node --test` arguments; the default is every tests/*.test.ts under `cwd`. */
  args?: string[];
  browser?: boolean;
  environment?: NodeJS.ProcessEnv;
  ports?: ReserveOptions;
  stdio?: 'inherit' | 'pipe';
}
export interface RunResult { code: number; base: number; environment: Record<string, string>; stdout: string; stderr: string }

/** The runner's own options, taken out of the arguments `node --test` receives. */
function runnerOptions(args: string[]) {
  const rest: string[] = [], options: { filesFrom?: string; shard?: string; durations?: string } = {};
  const flags = { '--files-from': 'filesFrom', '--shard': 'shard', '--durations': 'durations' } as const;
  for (let at = 0; at < args.length; at++) {
    const [flag, inline] = args[at].split(/=(.*)/s, 2) as [string, string | undefined];
    const key = flags[flag as keyof typeof flags];
    if (!key) { rest.push(args[at]); continue; }
    const value = inline ?? args[++at];
    if (!value) throw new Error(`${flag} needs a value`);
    options[key] = value;
  }
  return { rest, ...options };
}

/**
 * The `node --test` arguments for these runner arguments: the files named, else every
 * tests/*.test.ts, narrowed to one shard. Without --files-from or --shard every argument passes
 * through in its order, as before those options existed.
 */
export function nodeTestArgs(cwd: string, args: string[]) {
  const { rest, filesFrom, shard, durations } = runnerOptions(args);
  const reporters = durations ? ['--test-reporter=spec', '--test-reporter-destination=stdout', `--test-reporter=${fileURLToPath(new URL('./file-durations.mjs', import.meta.url))}`, `--test-reporter-destination=${resolve(cwd, durations)}`] : [];
  const all = () => readdirSync(resolve(cwd, 'tests')).filter(name => name.endsWith('.test.ts')).sort().map(name => `tests/${name}`);
  if (!filesFrom && !shard) return { args: [...reporters, ...rest, ...(rest.some(arg => !arg.startsWith('-')) ? [] : all())], empty: false, ordered: false };
  const listed = filesFrom ? readFileSync(resolve(cwd, filesFrom), 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean) : [];
  const named = [...rest.filter(arg => !arg.startsWith('-')), ...listed];
  let files = named.length || filesFrom ? named : all();
  const flags = rest.filter(arg => arg.startsWith('-'));
  if (shard) {
    const { index, count } = parseShard(shard); files = shardFiles(files, readDurations(cwd), count)[index - 1].files;
    // `node --test` sorts its files by path; a shard runs through ordered-tests.mjs so its longest
    // files start first, unless the caller passes `node --test` flags of its own.
    if (!flags.length) return { args: [...(durations ? ['--durations', resolve(cwd, durations)] : []), ...files], empty: !files.length, ordered: true };
  }
  return { args: [...reporters, ...flags, ...files], empty: !files.length, ordered: false };
}

export async function runTests(options: RunOptions = {}): Promise<RunResult> {
  const cwd = resolve(options.cwd ?? process.cwd()), args = options.args ?? [];
  const selection = options.browser ? null : nodeTestArgs(cwd, args);
  // An empty selection (a shard with nothing assigned, a change that affects no test) runs nothing:
  // `node --test` with no files would run every file it discovers instead.
  if (selection?.empty) {
    if (options.stdio !== 'pipe') console.log('No test files selected for this run.');
    return { code: 0, base: 0, environment: {}, stdout: '', stderr: '' };
  }
  // The browser window is the dev server's port and the sentinel above it that holds the window.
  const reservation = await reserveTestPorts(options.browser ? { first: defaultBrowserPort, span: 2, last: 65_000, ...options.ports } : options.ports);
  try {
    const set = options.browser ? { GRAPHYARD_BROWSER_PORT: String(reservation.base) } : testPortEnvironment(reservation.base);
    const environment = isolatedTestEnvironment(options.environment ?? process.env, set);
    const [command, commandArgs] = options.browser || !selection
      ? [process.execPath, [fileURLToPath(import.meta.resolve('@playwright/test/cli')), 'test', ...args]]
      : [process.execPath, ['--import', import.meta.resolve('tsx'), ...(selection.ordered ? [fileURLToPath(new URL('./ordered-tests.mjs', import.meta.url))] : ['--test']), ...selection.args]];
    const child = spawn(command, commandArgs, { cwd, env: environment, stdio: options.stdio === 'pipe' ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let stdout = '', stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.on('SIGINT', forward); process.on('SIGTERM', forward);
    const code = await new Promise<number>(done => child.on('close', (status, signal) => done(status ?? (signal ? 1 : 0))));
    process.off('SIGINT', forward); process.off('SIGTERM', forward);
    return { code, base: reservation.base, environment, stdout, stderr };
  } finally { reservation.release(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const browser = process.argv[2] === '--browser';
  const { code } = await runTests({ browser, args: process.argv.slice(browser ? 3 : 2) });
  process.exitCode = code;
}
