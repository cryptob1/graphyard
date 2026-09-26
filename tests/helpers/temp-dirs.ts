import { after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempOwnerMarker, writeTempOwner } from '../../src/tmp-reclaim.js';

// The one shared helper for a test that needs a temporary directory (GY-421): an embedded-Postgres
// data dir, a worktree, a store. Every directory is created under `<tmpdir>/graphyard-<label>-*`,
// marked — as a sibling `<directory>.owner` file, so the directory itself stays empty for initdb —
// with the process that made it, and removed by the file's single after hook, which node's runner
// executes after the file's tests whatever their outcome, so a failure never leaks the directory
// the way a bare `mkdtemp` without a hook does. Directories a killed run leaves behind carry the
// owner marker, so the runner's sweep (tests/helpers/run-tests.ts) and the loop's reclaim pass
// (src/tmp-reclaim.ts) remove them once that process is gone.

const created = new Set<string>();

/** Create a marked temporary directory, scheduled for removal in this file's after hook. */
export async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `graphyard-${label}-`));
  await writeTempOwner(directory);
  created.add(directory);
  return directory;
}

/** Remove every directory still tracked, its marker with it; returns what went. */
export async function disposeTemporaryDirectories(): Promise<string[]> {
  const directories = [...created];
  created.clear();
  const removed: string[] = [];
  for (const directory of directories) {
    try { await rm(directory, { recursive: true, force: true }); await rm(tempOwnerMarker(directory), { force: true }); removed.push(directory); }
    catch { /* a directory another pass already took is no leak */ }
  }
  return removed;
}

// One hook per process, installed when the helper is first imported and run after the file's last
// test, pass or fail: a test that created a directory never leaves it behind for the next run.
after(async () => { await disposeTemporaryDirectories(); });
