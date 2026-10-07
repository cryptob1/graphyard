// Concern: the loop re-executing itself onto the coordinator checkout when no supervisor unit runs it (GY-1399).
import { spawn as spawnChild } from 'node:child_process';
import { openSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { liveProcess } from './state.js';

/**
 * The environment variable naming the loop a successor replaces. The successor waits for that pid
 * to exit — and so to release the loop lock and write its cursor — before it reads the cursor.
 */
export const loopPredecessorVariable = 'GRAPHYARD_LOOP_PREDECESSOR';
/** How long a successor waits for its predecessor's shutdown: launches in flight and a doctor run end first. */
export const predecessorWaitMs = 10 * 60_000;

export interface UnsupervisedReexecution {
  /** The coordinator checkout the successor runs `master run` from. */
  root: string;
  cliPath: string;
  /** The directory the successor's output is appended to, as master-run.log. */
  logDirectory: string;
  execPath?: string;
  pid?: number;
  env?: NodeJS.ProcessEnv;
  spawn?: (command: string, args: string[], options: { cwd: string; detached: true; stdio: ['ignore', number, number]; env: NodeJS.ProcessEnv }) => { pid?: number; unref: () => void };
  /** Signals this process; the loop's own SIGTERM handler then ends it between cycles, releasing the lock. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  open?: (path: string) => number;
}

/**
 * A loop no supervisor unit runs re-executes itself without one (GY-1399). Before this, the
 * self-upgrade and the moved-HEAD recovery both needed `systemctl --user restart`, so a loop started
 * by hand, or on a host whose user manager it cannot reach, ran the code it first loaded forever
 * while every merged fix sat in the checkout unloaded. Now it starts its successor itself —
 * `master run` from the checkout, detached, logging beside the config — and then stops the way a
 * supervisor stops it: by its own SIGTERM, which ends the loop between cycles and releases the lock
 * the successor waits for. Under a unit the unit's restart stays the path; this is the fallback.
 */
export function reexecuteUnsupervised(input: UnsupervisedReexecution) {
  const pid = input.pid ?? process.pid;
  const open = input.open ?? (path => openSync(path, 'a', 0o600));
  const output = open(join(input.logDirectory, 'master-run.log'));
  const spawn = input.spawn ?? spawnChild;
  const child = spawn(input.execPath ?? process.execPath, [input.cliPath, 'master', 'run'], { cwd: input.root, detached: true, stdio: ['ignore', output, output], env: { ...(input.env ?? process.env), [loopPredecessorVariable]: String(pid) } });
  if (!child.pid) throw new Error(`the successor loop (${input.cliPath} master run) did not start, so this loop keeps running`);
  child.unref();
  (input.kill ?? process.kill)(pid, 'SIGTERM');
  return { successor: child.pid };
}

/**
 * A successor started by `reexecuteUnsupervised` waits here for the loop it replaces to exit before
 * it reads the cursor or takes the lock. A process started any other way returns at once.
 */
export async function awaitLoopPredecessor(env: NodeJS.ProcessEnv = process.env, options: { alive?: (pid: number) => boolean; timeoutMs?: number; pollMs?: number; self?: number } = {}) {
  const pid = Number(env[loopPredecessorVariable]);
  if (!Number.isInteger(pid) || pid <= 0 || pid === (options.self ?? process.pid)) return { waited: false, predecessor: null as number | null };
  const alive = options.alive ?? liveProcess, deadline = Date.now() + (options.timeoutMs ?? predecessorWaitMs);
  while (alive(pid)) {
    if (Date.now() > deadline) throw new Error(`The loop this one replaces (pid ${pid}) did not stop within ${Math.round((options.timeoutMs ?? predecessorWaitMs) / 1000)} seconds; this successor exits rather than run beside it`);
    await delay(options.pollMs ?? 500);
  }
  return { waited: true, predecessor: pid };
}
