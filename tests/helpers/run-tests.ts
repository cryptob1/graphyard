import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedTestEnvironment, reserveTestPorts, testPortEnvironment, type ReserveOptions } from '../../src/cli/test-isolation.js';
import { describeTmpReclaim, reclaimTmpDirectories } from '../../src/tmp-reclaim.js';

// The suite's own runner (GY-174): `npm test` and `npm run test:browser` start here, so a clean run
// needs nothing the session has to know about the host.
//
//   node --import tsx tests/helpers/run-tests.ts [FILE...]            the Node suite (default tests/*.test.ts)
//   node --import tsx tests/helpers/run-tests.ts --browser [ARGS...]  the Playwright suite
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

async function sweepLeftoverTempDirectories(when: string) {
  try {
    const sweep = await reclaimTmpDirectories({ prefixes: ['graphyard-'], limit: runnerTmpSweepLimit });
    const freed = describeTmpReclaim(sweep.removed.length, sweep.bytes);
    if (freed) console.error(`[run-tests] ${when}: ${freed}, ${sweep.kept} kept (a live run's or not yet due)`);
    for (const error of sweep.errors) console.error(`[run-tests] ${when}: could not remove ${error}`);
  } catch { /* a sweep that cannot run must never stop the suite */ }
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

export async function runTests(options: RunOptions = {}): Promise<RunResult> {
  await sweepLeftoverTempDirectories('before the suite');
  const cwd = resolve(options.cwd ?? process.cwd()), args = options.args ?? [];
  // The browser window is the dev server's port and the sentinel above it that holds the window.
  const reservation = await reserveTestPorts(options.browser ? { first: defaultBrowserPort, span: 2, last: 65_000, ...options.ports } : options.ports);
  try {
    const set = options.browser ? { GRAPHYARD_BROWSER_PORT: String(reservation.base) } : testPortEnvironment(reservation.base);
    const environment = isolatedTestEnvironment(options.environment ?? process.env, set);
    const files = args.some(arg => !arg.startsWith('-')) ? [] : readdirSync(resolve(cwd, 'tests')).filter(name => name.endsWith('.test.ts')).sort().map(name => `tests/${name}`);
    const [command, commandArgs] = options.browser
      ? [process.execPath, [fileURLToPath(import.meta.resolve('@playwright/test/cli')), 'test', ...args]]
      : [process.execPath, ['--import', import.meta.resolve('tsx'), '--test', ...args, ...files]];
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
