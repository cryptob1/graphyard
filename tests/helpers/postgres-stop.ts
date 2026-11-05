import { readdirSync, readFileSync } from 'node:fs';

// Stopping a test's embedded Postgres before its data directory goes (GY-3112). A test file's data
// dir is often a subdirectory of its temporary directory (`join(scratch, 'pg')`), and that directory
// used to be removed before the file's own after hook stopped the cluster: the checkpointer then
// PANICked on its shutdown checkpoint and dumped core, hundreds of times an hour.

/** The live postmasters whose data directory (`-D`) is `directory` or lies inside it, read from /proc. */
export function liveServersUnder(directory: string): number[] {
  const pids: number[] = [];
  let entries: string[];
  try { entries = readdirSync('/proc'); } catch { return pids; }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const args = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0'), data = args[args.indexOf('-D') + 1];
      if (!args.includes('-D') || !data || (data !== directory && !data.startsWith(`${directory}/`))) continue;
      if (readFileSync(`/proc/${name}/stat`, 'utf8').replace(/^.*\) /s, '').startsWith('Z')) continue;
      pids.push(Number(name));
    } catch { /* the process exited between listing and reading */ }
  }
  return pids;
}

/**
 * Stop every Postgres still running under `directory` and wait for it — synchronously, so an exit
 * handler can use it. SIGINT is a fast shutdown: it checkpoints into the data directory, which must
 * therefore still exist. Returns whether none is left running after `timeoutMs`.
 */
export function stopServersUnder(directory: string, timeoutMs = 60_000): boolean {
  let pids = liveServersUnder(directory);
  for (const pid of pids) try { process.kill(pid, 'SIGINT'); } catch { /* gone already */ }
  const sleeper = new Int32Array(new SharedArrayBuffer(4)), deadline = Date.now() + timeoutMs;
  while (pids.length && Date.now() < deadline) { Atomics.wait(sleeper, 0, 0, 25); pids = liveServersUnder(directory); }
  return !pids.length;
}
