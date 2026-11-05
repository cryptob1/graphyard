import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Stopping a test's embedded Postgres before its data directory goes (GY-3112). Removing the data
// under a running cluster made its checkpointer PANIC on the shutdown checkpoint and dump core.

/** The live postmaster an embedded Postgres runs in `directory` under: its lock file's process, unless gone or a zombie. */
export function liveServerIn(directory: string): number | null {
  let pid: number;
  try { pid = Number(readFileSync(join(directory, 'postmaster.pid'), 'utf8').split('\n')[0]); } catch { return null; }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') return null; }
  try { if (readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '').startsWith('Z')) return null; } catch { /* no /proc: the signal decides */ }
  return pid;
}

/**
 * Stop the Postgres still running in `directory`, if any, and wait for it — synchronously, so an
 * exit handler can use it: SIGINT is a fast shutdown, which checkpoints into the data directory
 * and removes its lock file last. A server that has not stopped within `timeoutMs` is left running.
 */
export function stopServerIn(directory: string, timeoutMs = 60_000): boolean {
  const pid = liveServerIn(directory);
  if (pid === null) return true;
  try { process.kill(pid, 'SIGINT'); } catch { /* gone already, or not ours to stop */ }
  const sleeper = new Int32Array(new SharedArrayBuffer(4)), deadline = Date.now() + timeoutMs;
  while (liveServerIn(directory) !== null) {
    if (Date.now() > deadline) return false;
    Atomics.wait(sleeper, 0, 0, 25);
  }
  return true;
}
