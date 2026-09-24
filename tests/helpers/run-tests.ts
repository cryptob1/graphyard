import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedTestEnvironment, reserveTestPorts, testPortEnvironment, type ReserveOptions } from '../../src/cli/test-isolation.js';

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
    return { code, base: reservation.base, environment, stdout, stderr };
  } finally { reservation.release(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const browser = process.argv[2] === '--browser';
  const { code } = await runTests({ browser, args: process.argv.slice(browser ? 3 : 2) });
  process.exitCode = code;
}
