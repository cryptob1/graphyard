import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

/**
 * The one way the loop, the dispatcher and the merge broker run Herdr, gh, git and systemctl.
 *
 * The coordinator is one process doing several things at once: the cycle reads the control plane,
 * the dispatcher beside it launches sessions, the merge broker chains provider calls. Until GY-125
 * every child of it was run with `execFileSync`, which stops the event loop for as long as the
 * child takes — a `herdr agent start … --timeout 30000` blocked it for up to thirty seconds, the
 * cycle's in-flight snapshot fetch could not be serviced, and its abort timer fired the instant
 * the loop came back. Every child now goes through here: spawned, bounded by a timeout, its output
 * captured, and awaited on the event loop, so a slow launch delays only the launcher.
 *
 * What a caller relies on, in order: the resolved value is the child's stdout; a non-zero exit, a
 * signal or a timeout rejects with a `ChildProcessError` carrying the same fields `execFileSync`'s
 * error did (`stdout`, `stderr`, `status`, `signal`, and `Command failed: …` as the message) so a
 * caller that reads Herdr's JSON refusal from the output, or git's exit status, reads it exactly
 * as before; a slow child delays only its caller.
 */

export interface ChildRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the child after this long; the default is `defaultChildTimeoutMs`. */
  timeoutMs?: number;
  /** Kill the child when, `startupTimeoutMs` in, this still returns false: a child that has not shown startup by then is not going to, and the caller refuses it instead of waiting out the full timeout (GY-2437). */
  started?: () => boolean;
  /** How long the child has to satisfy `started`; the default is `defaultChildStartupTimeoutMs`. */
  startupTimeoutMs?: number;
  /** Reject once the captured stdout or stderr outgrows this; the default is `defaultChildMaxBuffer`. */
  maxBuffer?: number;
  /** Where each stream goes. `inherit` passes it to this process's own; the default captures both. */
  stdout?: 'capture' | 'inherit';
  stderr?: 'capture' | 'inherit';
  /** Start the child in its own process group and signal the whole group at the timeout, so a grandchild holding the output open cannot outlive the bound (GY-2974). */
  group?: boolean;
}
/**
 * The dependency every runtime-calling helper takes. A test hands in a synchronous stub that
 * answers from a table; the process hands in a bound `childRunner`. Callers always `await` it.
 */
export type ChildRun = (command: string, args: string[], options?: ChildRunOptions) => Promise<string> | string;
export type BoundChildRun = (command: string, args: string[], options?: ChildRunOptions) => Promise<string>;

export const defaultChildTimeoutMs = 90_000, defaultChildMaxBuffer = 16 * 1024 * 1024;
/** How long a child with a `started` predicate has to show startup before it is killed. */
export const defaultChildStartupTimeoutMs = 30_000;
/** How long a child that ignored SIGTERM at its timeout is given before SIGKILL. */
export const childKillGraceMs = 5_000;

export class ChildProcessError extends Error {
  readonly command: string; readonly args: string[];
  readonly stdout: string; readonly stderr: string;
  /** The exit status, as `execFileSync` reported it; null when the child ended on a signal. */
  readonly status: number | null; readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  constructor(command: string, args: string[], detail: { stdout: string; stderr: string; status: number | null; signal: NodeJS.Signals | null; timedOut: boolean; timeoutMs?: number; startupTimeoutMs?: number; cause?: unknown }) {
    const invocation = [command, ...args].join(' ');
    super(detail.startupTimeoutMs !== undefined ? `${invocation} did not start within ${detail.startupTimeoutMs}ms and was killed${detail.stderr ? `\n${detail.stderr}` : ''}`
      : detail.timedOut ? `${invocation} did not finish within ${detail.timeoutMs}ms and was killed${detail.stderr ? `\n${detail.stderr}` : ''}`
        : detail.cause ? `${invocation} could not be started: ${detail.cause instanceof Error ? detail.cause.message : String(detail.cause)}`
          : `Command failed: ${invocation}${detail.stderr ? `\n${detail.stderr}` : ''}`);
    this.name = 'ChildProcessError';
    this.command = command; this.args = args;
    this.stdout = detail.stdout; this.stderr = detail.stderr;
    this.status = detail.status; this.signal = detail.signal; this.timedOut = detail.timedOut;
    if (detail.cause !== undefined) (this as { cause?: unknown }).cause = detail.cause;
  }
}

/**
 * Run one child and resolve with its stdout. The child is bounded: at `timeoutMs` it is sent
 * SIGTERM and, `childKillGraceMs` later, SIGKILL; the rejection says the command timed out. Nothing
 * here blocks the event loop, so other reads and writes of this process are serviced while the
 * child runs.
 */
export function runChild(command: string, args: string[], options: ChildRunOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? defaultChildTimeoutMs, maxBuffer = options.maxBuffer ?? defaultChildMaxBuffer;
  const startupTimeoutMs = options.startupTimeoutMs ?? defaultChildStartupTimeoutMs;
  return new Promise<string>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: !!options.group, stdio: ['ignore', options.stdout === 'inherit' ? 'inherit' : 'pipe', options.stderr === 'inherit' ? 'inherit' : 'pipe'] }); }
    catch (error) { reject(new ChildProcessError(command, args, { stdout: '', stderr: '', status: null, signal: null, timedOut: false, cause: error })); return; }
    const out: Buffer[] = [], err: Buffer[] = [];
    let outBytes = 0, errBytes = 0, timedOut = false, startupTimedOut = false, settled = false, spawnFailure: unknown;
    let killTimer: NodeJS.Timeout | undefined;
    const overflow = (stream: string) => { spawnFailure ??= new Error(`${stream} exceeded ${maxBuffer} bytes`); child.kill('SIGKILL'); };
    child.stdout?.on('data', (chunk: Buffer) => { outBytes += chunk.length; if (outBytes > maxBuffer) overflow('stdout'); else out.push(chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { errBytes += chunk.length; if (errBytes > maxBuffer) overflow('stderr'); else err.push(chunk); });
    const signal = (name: NodeJS.Signals) => { try { if (options.group && child.pid) process.kill(-child.pid, name); else child.kill(name); } catch { /* already gone */ } };
    const kill = () => { signal('SIGTERM'); killTimer = setTimeout(() => signal('SIGKILL'), childKillGraceMs); killTimer.unref?.(); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    // GY-2437: a caller that can tell the child has begun its work (`started`) refuses one that has
    // not at the startup bound, instead of holding its own window open for the full timeout.
    const startupTimer = options.started ? setTimeout(() => { if (options.started!()) return; startupTimedOut = true; kill(); }, startupTimeoutMs) : undefined;
    startupTimer?.unref?.();
    const finish = (status: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); if (startupTimer) clearTimeout(startupTimer); if (killTimer) clearTimeout(killTimer);
      const stdout = Buffer.concat(out).toString('utf8'), stderr = Buffer.concat(err).toString('utf8');
      if (spawnFailure !== undefined) reject(new ChildProcessError(command, args, { stdout, stderr, status, signal, timedOut, timeoutMs, cause: spawnFailure }));
      else if (startupTimedOut) reject(new ChildProcessError(command, args, { stdout, stderr, status, signal, timedOut: true, startupTimeoutMs }));
      else if (timedOut) reject(new ChildProcessError(command, args, { stdout, stderr, status, signal, timedOut: true, timeoutMs }));
      else if (status === 0) resolve(stdout);
      else reject(new ChildProcessError(command, args, { stdout, stderr, status, signal, timedOut: false }));
    };
    child.on('error', error => { spawnFailure ??= error; finish(null, null); });
    child.on('close', (status, signal) => finish(status, signal));
  });
}

/** A runner bound to defaults. */
export function childRunner(defaults: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}): BoundChildRun {
  return (command, args, options = {}) => runChild(command, args, { timeoutMs: defaults.timeoutMs, cwd: defaults.cwd, env: defaults.env, ...options });
}

/** The process's default runner: bounded, captured, unmetered. */
export const defaultChildRun: BoundChildRun = childRunner();
