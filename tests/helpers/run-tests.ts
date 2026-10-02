import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseShard, readDurations, shardFiles } from '../../scripts/ci-tests.mjs';
import { isolatedTestEnvironment, reserveTestPorts, testPortEnvironment, type ReserveOptions } from '../../src/cli/test-isolation.js';
import { describeTmpReclaim, reclaimTmpDirectories } from '../../src/tmp-reclaim.js';

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
//
// Before and after the suite it runs, the runner sweeps the `<tmpdir>/graphyard-*` directories
// earlier runs left behind (GY-421): one whose owning process is gone is removed whatever its age,
// an old ownerless one once nothing live holds it open, and one a live run still owns is never
// touched. A run that was killed mid-test therefore stops leaking its embedded-Postgres data dirs
// into the tmpfs — and each run's own backstop removes whatever this one's children leaked.

/** The most leftovers one sweep of this runner removes, so a backlog cannot stall the suite's start. */
export const runnerTmpSweepLimit = 40;
/**
 * How old a `pg-password-*` file must be before the runner takes it (GY-1074). embedded-postgres
 * writes the file to the tmpdir for initdb and unlinks it in a finally, so only a process killed
 * mid-init leaves one; initdb reads it within seconds, so ten minutes never takes a live run's.
 */
export const runnerPasswordFileAgeMs = 10 * 60_000;

/** One runner sweep over `tmpRoot` (the host's tmpdir by default): its `graphyard-*` leftovers and stale `pg-password-*` files. */
export async function sweepLeftoverTempDirectories(when: string, tmpRoot?: string) {
  const removed: string[] = [];
  for (const options of [{ prefixes: ['graphyard-'] }, { prefixes: ['pg-password-'], maxAgeMs: runnerPasswordFileAgeMs }]) {
    try {
      const sweep = await reclaimTmpDirectories({ ...options, limit: runnerTmpSweepLimit, ...(tmpRoot ? { tmpRoot } : {}) });
      removed.push(...sweep.removed.map(entry => entry.path));
      const freed = describeTmpReclaim(sweep.removed.length, sweep.bytes);
      if (freed) console.error(`[run-tests] ${when}: ${freed}, ${sweep.kept} kept (a live run's or not yet due)`);
      for (const error of sweep.errors) console.error(`[run-tests] ${when}: could not remove ${error}`);
    } catch { /* a sweep that cannot run must never stop the suite */ }
  }
  return removed;
}

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

/** How far above its parent's base a run started inside a test run begins: past every per-file port offset (the highest is 642). */
export const nestedPortGap = 1000;

/**
 * A run started from inside a test run — tests/test-isolation.test.ts runs this runner on fixture
 * projects — starts its window above the parent's. The parent holds only its sentinel, so a window
 * taken inside it hands the nested run ports a sibling test file's Postgres is about to bind: on a
 * shard, 15458 + 7 took tests/escalation-context.test.ts's 15438 + 27 (GY-499).
 */
export function nestedFirst(environment: NodeJS.ProcessEnv = process.env): { first?: number } {
  const parent = Number(environment.GRAPHYARD_TEST_PORT);
  return Number.isInteger(parent) && parent > 0 ? { first: parent + nestedPortGap } : {};
}

export async function runTests(options: RunOptions = {}): Promise<RunResult> {
  await sweepLeftoverTempDirectories('before the suite');
  const cwd = resolve(options.cwd ?? process.cwd()), args = options.args ?? [];
  const selection = options.browser ? null : nodeTestArgs(cwd, args);
  // An empty selection (a shard with nothing assigned, a change that affects no test) runs nothing:
  // `node --test` with no files would run every file it discovers instead.
  if (selection?.empty) {
    if (options.stdio !== 'pipe') console.log('No test files selected for this run.');
    return { code: 0, base: 0, environment: {}, stdout: '', stderr: '' };
  }
  // The browser window is the dev server's port and the sentinel above it that holds the window.
  const reservation = await reserveTestPorts(options.browser ? { first: defaultBrowserPort, span: 2, last: 65_000, ...options.ports } : { ...nestedFirst(), ...options.ports });
  try {
    // The suite's managed checkouts live inside the tree it runs from (ignored by .graphyard/): a worker's
    // sandbox can write nowhere else, and the default ~/.local/share/graphyard failed every checkout there (GY-498).
    const dataHome = resolve(cwd, '.graphyard/test-data');
    mkdirSync(dataHome, { recursive: true });
    const set = { ...(options.browser ? { GRAPHYARD_BROWSER_PORT: String(reservation.base) } : testPortEnvironment(reservation.base)), GRAPHYARD_DATA_HOME: dataHome };
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
    // Whatever this run's children leaked — a failure before an after hook, a killed file — its
    // processes are gone now, so the sweep takes their directories back at once.
    await sweepLeftoverTempDirectories('after the suite');
    return { code, base: reservation.base, environment, stdout, stderr };
  } finally { reservation.release(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const browser = process.argv[2] === '--browser';
  const { code } = await runTests({ browser, args: process.argv.slice(browser ? 3 : 2) });
  process.exitCode = code;
}
