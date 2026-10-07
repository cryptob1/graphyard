// Concern: the loop re-executing itself onto the coordinator checkout when no supervisor unit runs it (GY-1399).
import { closeSync, existsSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { liveProcess } from './state.js';
import { loopUnitDirectory, loopUnitName } from '../supervisor.js';

/**
 * The environment variable naming the loop a successor replaces. The successor waits for that pid
 * to exit — and so to release the loop lock and write its cursor — before it reads the cursor.
 */
export const loopPredecessorVariable = 'GRAPHYARD_LOOP_PREDECESSOR';
/** The file a successor writes once its setup passed, so its predecessor stops only for a successor that will run. */
export const loopSuccessorReadyVariable = 'GRAPHYARD_LOOP_SUCCESSOR_READY';
/** How long the running loop waits for its successor's setup (credential, protocol) before it gives up and keeps running. */
export const successorReadyMs = 120_000;
/** How long a successor leaves an installed unit to take the lock first: the unit restarts every 10 s (RestartSec). */
export const unitHandoverMs = 30_000;

/** The successor as the re-execution sees it: the subset of a ChildProcess it needs. */
export interface SuccessorProcess {
  pid?: number;
  exitCode: number | null;
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  unref(): void;
}

export interface UnsupervisedReexecution {
  /** The coordinator checkout the successor runs `master run` from. */
  root: string;
  cliPath: string;
  /** The directory the successor's output is appended to, as master-run.log, and its readiness file is written in. */
  logDirectory: string;
  execPath?: string;
  pid?: number;
  env?: NodeJS.ProcessEnv;
  spawn?: (command: string, args: string[], options: { cwd: string; detached: true; stdio: ['ignore', number, number]; env: NodeJS.ProcessEnv }) => SuccessorProcess;
  /** Signals a process: this loop's own SIGTERM ends it between cycles and releases the lock; a successor that never became ready is stopped. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  open?: (path: string) => number;
  close?: (fd: number) => void;
  readyMs?: number;
  pollMs?: number;
}

/**
 * A loop no supervisor unit runs re-executes itself without one (GY-1399). Before this, the
 * self-upgrade and the moved-HEAD recovery both needed `systemctl --user restart`, so a loop started
 * by hand, or on a host whose user manager it cannot reach, ran the code it first loaded forever
 * while every merged fix sat in the checkout unloaded. Now it starts its successor itself —
 * `master run` from the checkout, detached, logging beside the config — and waits until the
 * successor reports that its setup passed. Only then does it stop the way a supervisor stops it: by
 * its own SIGTERM, which ends the loop between cycles and releases the lock the successor waits for.
 * A successor that cannot be launched, exits, or does not report ready leaves this loop running,
 * since nothing else would restart it. Under a unit the unit's restart stays the path.
 */
export async function reexecuteUnsupervised(input: UnsupervisedReexecution) {
  const pid = input.pid ?? process.pid;
  const kill = input.kill ?? process.kill;
  const ready = join(input.logDirectory, `loop-successor-${pid}.ready`);
  rmSync(ready, { force: true });
  const output = (input.open ?? (path => openSync(path, 'a', 0o600)))(join(input.logDirectory, 'master-run.log'));
  // Loaded where it is used, as `master restart` loads it (src/master/autonomy.ts): the loop's modules hold no import of it.
  const spawn = input.spawn ?? (await import('node:child_process')).spawn;
  let child: SuccessorProcess;
  // A launch failure (a missing node binary, EMFILE) arrives as an 'error' event after spawn returns:
  // its listener is attached before anything else can yield, so it fails this re-execution, not the loop.
  let failure = null as string | null;
  try {
    child = spawn(input.execPath ?? process.execPath, [input.cliPath, 'master', 'run'], { cwd: input.root, detached: true, stdio: ['ignore', output, output],
      env: { ...(input.env ?? process.env), [loopPredecessorVariable]: String(pid), [loopSuccessorReadyVariable]: ready } });
    child.once('error', error => { failure ??= `could not be launched: ${error.message}`; });
    child.once('exit', (code, signal) => { failure ??= `exited before it was ready (${signal ?? `code ${code}`})`; });
  } finally {
    // The child holds its own copy of the log descriptor; this loop's copy closes whatever happened.
    (input.close ?? closeSync)(output);
  }
  const deadline = Date.now() + (input.readyMs ?? successorReadyMs);
  const fail = (reason: string) => {
    rmSync(ready, { force: true });
    return new Error(`no supervisor unit runs this loop, and its successor (${input.cliPath} master run) ${reason}, so this loop keeps running; it retries on the next cycle`);
  };
  while (!existsSync(ready)) {
    if (failure) throw fail(failure);
    if (Date.now() > deadline) {
      if (child.pid) { try { kill(child.pid, 'SIGTERM'); } catch {} }
      throw fail(`did not report ready within ${Math.round((input.readyMs ?? successorReadyMs) / 1000)} seconds and was stopped`);
    }
    await delay(input.pollMs ?? 200);
  }
  rmSync(ready, { force: true });
  child.unref();
  kill(pid, 'SIGTERM');
  return { successor: child.pid ?? null };
}

/**
 * A successor started by `reexecuteUnsupervised` reports here that its setup passed, then waits for
 * the loop it replaces to exit before it reads the cursor or takes the lock. That loop was sent
 * SIGTERM and its shutdown is bounded by the work in flight, so the wait has no deadline: a successor
 * that gave up first would leave no loop at all once the predecessor exits. Where a unit is installed
 * (a loop started beside it, for instance from a session that cannot reach the user manager), the
 * successor then leaves the unit time to restart and take the lock, so the loop ends up supervised.
 * A process started any other way returns at once.
 */
export async function awaitLoopPredecessor(env: NodeJS.ProcessEnv = process.env, options: { alive?: (pid: number) => boolean; pollMs?: number; self?: number; unitInstalled?: () => boolean; handoverMs?: number } = {}) {
  const pid = Number(env[loopPredecessorVariable]);
  if (!Number.isInteger(pid) || pid <= 0 || pid === (options.self ?? process.pid)) return { waited: false, predecessor: null as number | null, handover: false };
  const ready = env[loopSuccessorReadyVariable];
  if (ready) writeFileSync(ready, `${options.self ?? process.pid}\n`, { mode: 0o600 });
  const alive = options.alive ?? liveProcess;
  while (alive(pid)) await delay(options.pollMs ?? 500);
  const handover = (options.unitInstalled ?? (() => existsSync(join(loopUnitDirectory(), loopUnitName))))();
  if (handover) await delay(options.handoverMs ?? unitHandoverMs);
  return { waited: true, predecessor: pid, handover };
}
