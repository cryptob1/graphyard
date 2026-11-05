import { readdirSync, readFileSync } from 'node:fs';

// Stopping a test's embedded Postgres before its data directory goes (GY-3112). A test file's data
// dir is often a subdirectory of its temporary directory (`join(scratch, 'pg')`), and that directory
// used to be removed before the file's own after hook stopped the cluster: the checkpointer then
// PANICked on its shutdown checkpoint and dumped core, hundreds of times an hour.

/** Every live postmaster on the host with its data directory (`-D`), read from /proc. */
export function livePostmasters(): { pid: number; data: string }[] {
  const found: { pid: number; data: string }[] = [];
  let entries: string[];
  try { entries = readdirSync('/proc'); } catch { return found; }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const args = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0'), at = args.indexOf('-D');
      if (at < 0 || !args[at + 1] || readFileSync(`/proc/${name}/stat`, 'utf8').replace(/^.*\) /s, '').startsWith('Z')) continue;
      found.push({ pid: Number(name), data: args[at + 1] });
    } catch { /* the process exited between listing and reading */ }
  }
  return found;
}

/** The live postmasters whose data directory is `directory` or lies inside it. */
export function liveServersUnder(directory: string, postmasters = livePostmasters()): number[] {
  return postmasters.filter(({ data }) => data === directory || data.startsWith(`${directory}/`)).map(({ pid }) => pid);
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
