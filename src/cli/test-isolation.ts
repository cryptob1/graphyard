import { createServer } from 'node:net';

/**
 * What a clean test run needs from the host, done by the tooling rather than remembered by the
 * session that runs it (GY-174). A worker, producer or master session carries its own Graphyard
 * and Herdr credentials in its environment; the project's own tests must never see them, or the CLI
 * credential tests read the session's token instead of the one they set. And every test file starts
 * its own Postgres on `GRAPHYARD_TEST_PORT` plus a fixed per-file offset, so two runs on one host —
 * two worktrees, or a worker beside a producer — must not share a base.
 *
 * `npm test` (tests/helpers/run-tests.ts), `graphyard verify` and the proof runners all start the
 * suite through `isolatedTestEnvironment` with a port window `reserveTestPorts` holds for the run.
 */

/** Harness controls a caller sets on purpose for the suite; every other GRAPHYARD_* and HERDR_* variable is withheld. */
export const passedTestControls = ['GRAPHYARD_TIMING_RECORD', 'GRAPHYARD_TIMING_BASELINE_RECORDING'] as const;
/** The first base tried when nothing is reserved; the historical fixed base, so a lone run keeps its ports. */
export const defaultTestPortBase = 15438;
/** Every per-file offset a test file adds to the base lies below this (the highest is 177). */
export const testPortSpan = 200;
const highestBase = 60_000;

/**
 * The environment the project's tests run under: the caller's, without NODE_TEST_CONTEXT (which a
 * surrounding test runner sets and which turns a child's TAP stream off) and without any
 * GRAPHYARD_* or HERDR_* variable the runner did not set itself — `set` is what it does set.
 */
export function isolatedTestEnvironment(environment: NodeJS.ProcessEnv = process.env, set: Record<string, string> = {}): Record<string, string> {
  const kept = Object.entries(environment).filter((entry): entry is [string, string] => {
    const [name, value] = entry;
    if (value === undefined || name === 'NODE_TEST_CONTEXT') return false;
    return !/^(GRAPHYARD|HERDR)_/.test(name) || (passedTestControls as readonly string[]).includes(name);
  });
  return { ...Object.fromEntries(kept), ...set };
}

/** The variables a reserved window gives the suite: the base, and the per-file overrides the required check sets (tests/helpers/timing-stability.ts). */
export function testPortEnvironment(base: number): Record<string, string> {
  // tests/events-pagination.test.ts would otherwise share base + 25 with tests/reconciliation-snapshot.test.ts.
  return { GRAPHYARD_TEST_PORT: String(base), GRAPHYARD_EVENTS_TEST_PORT: String(base + 28) };
}

/** Whether nothing on this host listens on `port` at 127.0.0.1. */
export function portFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

/** One free port, chosen by the kernel. */
export function freePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen({ port: 0, host, exclusive: true }, () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); });
  });
}

/** A listening socket this process holds on `port`; the kernel frees it when the process exits, however it exits. */
export function holdPort(port: number, host = '127.0.0.1'): Promise<{ close(): void } | null> {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(null));
    server.listen({ port, host, exclusive: true }, () => { server.unref(); resolve({ close: () => { server.close(); } }); });
  });
}

export interface TestPortReservation { base: number; span: number; sentinel: number; release(): void }
export interface ReserveOptions {
  span?: number; first?: number; last?: number;
  probe?: (port: number) => Promise<boolean>;
  hold?: typeof holdPort;
}

/**
 * Reserve a window of `span` ports for one test run. The window's last port is its sentinel: the
 * run listens on it until `release`, so taking the window is one exclusive bind the kernel decides
 * between concurrent runs — of any user on the host — and a run that exits, even killed, leaves no
 * lock behind to reclaim. No test listens on the sentinel (every per-file offset is below
 * `testPortSpan - 1`). With the sentinel held, every other port of the window must be free now, so
 * a leftover test Postgres from an earlier run moves this run to the next window.
 */
export async function reserveTestPorts(options: ReserveOptions = {}): Promise<TestPortReservation> {
  const span = options.span ?? testPortSpan, first = options.first ?? defaultTestPortBase, last = options.last ?? highestBase;
  const probe = options.probe ?? portFree, hold = options.hold ?? holdPort;
  if (!Number.isInteger(span) || span < 2) throw new Error(`A test port window needs its ports and a sentinel: span ${span} is below 2`);
  for (let base = first; base + span - 1 <= last; base += span) {
    const sentinel = base + span - 1;
    const held = await hold(sentinel);
    if (!held) continue;
    let free = true;
    for (let port = base; port < sentinel && free; port++) free = await probe(port);
    if (!free) { held.close(); continue; }
    return { base, span, sentinel, release: () => held.close() };
  }
  throw new Error(`No free window of ${span} test ports between ${first} and ${last}; stop a leftover test Postgres (ss -ltnp) and retry`);
}

/** Failures a test case or suite reports of its own code; any other `not ok` is a hook, a file or the process failing. */
const caseFailures: Record<string, string[]> = { test: ['testCodeFailure', 'testTimeoutFailure'], suite: ['subtestsFailed'] };

/**
 * Why a node:test run that proof runners judge by case title must not pass, or null. A proof's
 * files run whole, so another case of the same file failing is that case's business and leaves the
 * exit status nonzero on its own. Anything else behind a nonzero exit — a failing before/after
 * hook, an unhandled rejection or a crash after the last case (reported against the file, with
 * the child's exit code), or a signal — means the run did not complete normally, and no case it
 * reported passing is trusted.
 */
export function abnormalTestExit(tap: string, status: number | null, signal: NodeJS.Signals | string | null): string | null {
  if (signal) return `the test process was stopped by ${signal}`;
  if (status === 0) return null;
  const lines = tap.split('\n'), failures: { title: string; type?: string; failureType?: string; exited: boolean }[] = [];
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^(\s*)not ok \d+ - (.*?)(?: # (?:SKIP|TODO)\b.*)?$/);
    if (!match) continue;
    const failure: (typeof failures)[number] = { title: match[2], exited: false };
    // The case's YAML diagnostics follow it, indented two more spaces, between `---` and `...`.
    const indent = `${match[1]}  `;
    if (lines[index + 1] === `${indent}---`) for (let next = index + 2; next < lines.length && lines[next] !== `${indent}...`; next++) {
      const field = lines[next].slice(indent.length).match(/^(type|failureType|exitCode|signal): '?([^']*)'?$/);
      if (!field || lines[next].slice(0, indent.length) !== indent) continue;
      if (field[1] === 'type') failure.type = field[2];
      else if (field[1] === 'failureType') failure.failureType = field[2];
      else failure.exited = true;
    }
    failures.push(failure);
  }
  if (!failures.length) return `the test process exited with ${status} and reported no failing case`;
  const abnormal = failures.find(failure => failure.exited || !failure.type || !caseFailures[failure.type]?.includes(failure.failureType ?? ''));
  return abnormal ? `the test process exited with ${status} after "${abnormal.title}" failed as ${abnormal.failureType ?? 'an unclassified failure'}, not as a test case` : null;
}

/**
 * `npm ci` arguments and environment for an install a build and its tests run against: the full
 * tree always. An inherited NODE_ENV=production or npm_config_omit=dev would otherwise skip the
 * devDependencies (typescript, tsx, playwright) while npm still exits 0, an omit=optional in an
 * .npmrc would skip the platform packages (esbuild's binary for tsx, @embedded-postgres/*) that
 * the lockfile check tolerates as missing, and an inherited
 * npm_config_dry_run (or dry-run in an .npmrc) would install nothing and exit 0.
 */
export const npmCiArgs = ['ci', '--include=dev', '--include=optional', '--no-dry-run', '--no-audit', '--no-fund'];
export function npmCiEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) if (!/^(npm_config_(omit|only|production|also|dev|include|dry_run|dry-run)|NODE_ENV)$/i.test(name)) clean[name] = value;
  return clean;
}
