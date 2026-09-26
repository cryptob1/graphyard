import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedTestEnvironment, reserveTestPorts, testPortEnvironment, type ReserveOptions } from '../../src/cli/test-isolation.js';
import { heldVariable, sessionVerificationSlot } from '../../src/master/verification-slots.js';

// The suite's own runner (GY-174): `npm test` and `npm run test:browser` start here, so a clean run
// needs nothing the session has to know about the host.
//
//   node --import tsx tests/helpers/run-tests.ts [FILE...]            the Node suite (default tests/*.test.ts)
//   node --import tsx tests/helpers/run-tests.ts --browser [ARGS...]  the Playwright suite
//   node --import tsx tests/helpers/run-tests.ts --typecheck          tsc --noEmit (npm run typecheck)
//
// Started from a Graphyard session, each of the three first takes a host verification slot
// (src/master/verification-slots.ts, GY-612), waiting while every slot on the host is held.
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

/** `tsc --noEmit` under the caller's environment, marked as holding the slot this process took. */
export async function typecheck(cwd = process.cwd(), args: string[] = []) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.resolve('typescript/bin/tsc')), '--noEmit', ...args], { cwd, stdio: 'inherit', env: { ...process.env, [heldVariable]: '1' } });
  return await new Promise<number>(done => child.on('close', (status, signal) => done(status ?? (signal ? 1 : 0))));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] === '--browser' ? 'browser' : process.argv[2] === '--typecheck' ? 'typecheck' : 'test';
  const args = process.argv.slice(mode === 'test' ? 2 : 3);
  const held = await sessionVerificationSlot(mode === 'typecheck' ? 'npm run typecheck' : mode === 'browser' ? 'npm run test:browser' : `npm test${args.length ? ` ${args.join(' ')}` : ''}`);
  try { process.exitCode = mode === 'typecheck' ? await typecheck(process.cwd(), args) : (await runTests({ browser: mode === 'browser', args })).code; }
  finally { held?.release(); }
}
