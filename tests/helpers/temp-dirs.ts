import { after } from 'node:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempOwnerMarker, writeTempOwner } from '../../src/tmp-reclaim.js';

// The one shared helper for a test that needs a temporary directory (GY-421): an embedded-Postgres
// data dir, a worktree, a store, a home. Every test in the suite creates its directories here and
// never with a bare `mkdtemp`, so none is left behind whether its tests pass or fail.
//
// A directory under the host's tmpdir is created as `<tmpdir>/graphyard-<label>-*` and marked — as
// a sibling `<directory>.owner` file, so the directory itself stays empty for initdb — with the
// process that made it. A directory under another parent (`temporaryDirectory('home', scratch)`)
// is `<parent>/<label>-*` and carries no marker: it goes with its parent. Every directory is
// removed by the file's single after hook, which node's runner executes after the file's tests
// whatever their outcome. Directories a killed run leaves behind carry the owner marker, so the
// runner's sweep (tests/helpers/run-tests.ts) and the loop's reclaim pass (src/tmp-reclaim.ts)
// remove them once that process is gone.
//
// Node runs a file's top-level after hooks in the order they were registered, and this one is
// registered on import, before the file's own: a directory an embedded Postgres still runs in —
// its `postmaster.pid` names a live process — is therefore left to that file's own after hook to
// stop, and removed when the process exits, after every hook has run.

const created = new Set<string>();

/**
 * Create a temporary directory, scheduled for removal in this file's after hook: under the host's
 * tmpdir as `graphyard-<label>-*`, marked with its owner; under `parent` as `<label>-*`.
 */
export async function temporaryDirectory(label: string, parent?: string): Promise<string> {
  const directory = parent ? await mkdtemp(join(parent, `${label}-`)) : await mkdtemp(join(tmpdir(), `graphyard-${label}-`));
  if (!parent) await writeTempOwner(directory);
  created.add(directory);
  return directory;
}

/** Whether an embedded Postgres still runs in `directory`: its lock file names a live process. */
function liveServerIn(directory: string) {
  const lock = join(directory, 'postmaster.pid');
  if (!existsSync(lock)) return false;
  const pid = Number(readFileSync(lock, 'utf8').split('\n')[0]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Remove every directory still tracked, its marker with it, and return what went. A directory a
 * live server still runs in is kept for the exit pass unless `force` is set.
 */
export async function disposeTemporaryDirectories(options: { force?: boolean } = {}): Promise<string[]> {
  const removed: string[] = [];
  for (const directory of [...created]) {
    if (!options.force && liveServerIn(directory)) continue;
    created.delete(directory);
    try { await rm(directory, { recursive: true, force: true }); await rm(tempOwnerMarker(directory), { force: true }); removed.push(directory); }
    catch { /* a directory another pass already took is no leak */ }
  }
  return removed;
}

// One hook per process, installed when the helper is first imported and run after the file's
// tests, pass or fail: a test that created a directory never leaves it behind for the next run.
after(async () => { await disposeTemporaryDirectories(); });
// What the hook left to a server's own teardown goes once every hook has run.
process.on('exit', () => {
  for (const directory of created) {
    try { rmSync(directory, { recursive: true, force: true }); rmSync(tempOwnerMarker(directory), { force: true }); } catch { /* the runner's sweep takes it */ }
  }
});
