import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

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

/**
 * Where reservations are recorded: one directory every session of this user on this host shares.
 * A session's own TMPDIR is private to it, so the per-user directory under /tmp comes first.
 */
export function defaultLockDirectory() {
  let user = String(process.getuid?.() ?? '');
  if (!user) try { user = userInfo().username; } catch { user = 'user'; }
  return [join('/tmp', `graphyard-test-ports-${user}`), join(tmpdir(), `graphyard-test-ports-${user}`)];
}

const alive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === 'EPERM'; }
};

/** Take the lock for one base, reclaiming a lock whose holder is gone. False while a live run holds it. */
function lock(directory: string, base: number, pid: number): string | false {
  const file = join(directory, `${base}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const fd = openSync(file, 'wx', 0o600); writeSync(fd, `${pid}\n`); closeSync(fd); return file; }
    catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      let holder = NaN;
      try { holder = Number(readFileSync(file, 'utf8').trim()); } catch { /* removed meanwhile */ }
      if (alive(holder)) return false;
      rmSync(file, { force: true });
    }
  }
  return false;
}

export interface TestPortReservation { base: number; span: number; lock: string | null; release(): void }
export interface ReserveOptions {
  span?: number; first?: number; last?: number;
  /** Directories tried in order for the shared lock files; with none writable the window is probed only. */
  lockDirectories?: string[];
  /** The process the reservation belongs to; a lock whose process has exited is reclaimed. */
  pid?: number;
  probe?: (port: number) => Promise<boolean>;
}

/**
 * Reserve a window of `span` ports for one test run: no other live run holds it (a lock file per
 * base, named by the holder's pid, in a directory every session of this user shares), and nothing
 * listens on any port of it now. The window stays reserved until `release`, or until the holder
 * exits, so a concurrent run starting while this one's databases are still coming up picks another.
 */
export async function reserveTestPorts(options: ReserveOptions = {}): Promise<TestPortReservation> {
  const span = options.span ?? testPortSpan, first = options.first ?? defaultTestPortBase, last = options.last ?? highestBase;
  const pid = options.pid ?? process.pid, probe = options.probe ?? portFree;
  let directory: string | null = null;
  for (const candidate of options.lockDirectories ?? defaultLockDirectory()) {
    try { mkdirSync(candidate, { recursive: true, mode: 0o700 }); directory = candidate; break; } catch { /* next candidate */ }
  }
  for (let base = first; base + span - 1 <= last; base += span) {
    let file: string | false | null = null;
    if (directory) {
      try { file = lock(directory, base, pid); } catch { directory = null; file = null; }
      if (file === false) continue;
    }
    let free = true;
    for (let port = base; port < base + span && free; port++) free = await probe(port);
    if (!free) { if (file) rmSync(file, { force: true }); continue; }
    const held = file || null;
    return { base, span, lock: held, release: () => { if (held) rmSync(held, { force: true }); } };
  }
  throw new Error(`No free window of ${span} test ports between ${first} and ${last}; stop a leftover test Postgres (ss -ltnp) and retry`);
}
