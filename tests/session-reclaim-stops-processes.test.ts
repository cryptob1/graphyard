import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { removeSessionCheckout, sessionCheckout } from '../src/install/worktree-root.js';
import { removeAttemptWorktree, worktreesDirectory } from '../src/master/worktrees.js';
import { stopOrphansOfRemovedWorktrees, stopProcessesUnder } from '../src/session-processes.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const running = (pid: number) => { try { return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } };
const eventually = async (check: () => boolean) => { for (let tries = 0; tries < 100 && !check(); tries++) await delay(50); return check(); };
const noRun = async () => '';
const started: number[] = [];
const track = (pid: number) => { started.push(pid); return pid; };
test.after(() => { for (const pid of started) try { process.kill(pid, 'SIGKILL'); } catch { /* stopped, as it should be */ } });

/** A process of a fresh session of its own, in `cwd`, whose arguments are `args`. */
function detached(cwd: string, script: string, ...args: string[]) {
  const child = spawn('sh', ['-c', script, ...args], { cwd, detached: true, stdio: 'ignore' });
  child.unref();
  return track(child.pid!);
}

/** A sleep whose parent shell already exited: reparented away from whoever started it. */
async function reparented(cwd: string, scratch: string) {
  const file = join(scratch, `pid-${started.length}`);
  detached(cwd, `sleep 300 </dev/null >/dev/null 2>&1 & echo $! > ${file}`);
  assert.ok(await eventually(() => existsSync(file) && !!readFileSync(file, 'utf8').trim()));
  return track(Number(await readFile(file, 'utf8')));
}

test('unit:tests/session-reclaim-stops-processes.test.ts — a session checkout takes a reparented process and a browser stand-in with it', async () => {
  const scratch = await temporaryDirectory('reclaim-session'), base = join(scratch, 'root');
  const { directory, worktree } = sessionCheckout(base, 'review', 'GY-1', 'a'.repeat(40), 'b'.repeat(32));
  await mkdir(worktree, { recursive: true });
  const sleeper = await reparented(worktree, scratch);
  // cwd elsewhere: only the command line names the checkout, and its child names nothing.
  const browser = detached(scratch, 'sleep 300 & wait', 'chrome', `--user-data-dir=${join(directory, 'profile')}`);
  await removeSessionCheckout(scratch, base, directory, noRun);
  assert.equal(running(sleeper), false, 'the reparented process stopped');
  assert.equal(running(browser), false, 'the browser stand-in stopped');
  assert.equal(existsSync(directory), false);
});

test('unit:tests/session-reclaim-stops-processes.test.ts — an attempt worktree takes its processes, and a sandbox\'s children, even one ignoring SIGTERM', async () => {
  const root = await temporaryDirectory('reclaim-attempt'), target = join(worktreesDirectory(root), 'GY-1-1'), sibling = join(worktreesDirectory(root), 'GY-1-10');
  await mkdir(target, { recursive: true }); await mkdir(sibling, { recursive: true });
  const sleeper = await reparented(target, root), neighbour = await reparented(sibling, root);
  assert.equal(await removeAttemptWorktree(root, target, noRun), true);
  assert.equal(running(sleeper), false);
  assert.equal(running(neighbour), true, 'a worktree whose name merely begins the same keeps running');

  const file = join(root, 'child');
  const sandbox = detached(sibling, `trap '' TERM; sleep 300 & echo $! > ${file}; wait`, 'bwrap');
  assert.ok(await eventually(() => existsSync(file) && !!readFileSync(file, 'utf8').trim()));
  const child = track(Number(await readFile(file, 'utf8')));
  const stopped = await stopProcessesUnder(sibling, { graceMs: 200 });
  assert.equal(running(sandbox), false, 'SIGKILL follows the grace');
  assert.equal(running(child), false, 'the sandbox\'s child goes with it');
  assert.equal(running(neighbour), false);
  assert.ok(stopped.some(entry => entry.endsWith(`(${sandbox})`)), stopped.join());
});

test('unit:tests/session-reclaim-stops-processes.test.ts — a sandbox named only by its bind mount is stopped', async () => {
  const scratch = await temporaryDirectory('reclaim-mount'), worktree = join(scratch, 'checkout'), procRoot = join(scratch, 'proc');
  const pid = detached(scratch, 'sleep 300');
  await mkdir(join(procRoot, String(pid)), { recursive: true });
  await writeFile(join(procRoot, String(pid), 'stat'), readFileSync(`/proc/${pid}/stat`, 'utf8'));
  await writeFile(join(procRoot, String(pid), 'mountinfo'), `36 35 8:2 / / rw - ext4 /dev/root rw\n99 36 8:2 /x ${worktree} rw - ext4 /dev/root rw\n`);
  assert.equal((await stopProcessesUnder(worktree, { procRoot, graceMs: 100 })).length, 1);
  assert.ok(await eventually(() => !running(pid)));
});

test('unit:tests/session-reclaim-stops-processes.test.ts — the sweep stops what names a removed worktree and keeps a live one, a terminal, a newcomer and a prompt', async () => {
  const root = await temporaryDirectory('reclaim-sweep'), worktrees = worktreesDirectory(root);
  const removed = join(worktrees, 'GY-1-1'), live = join(worktrees, 'GY-2-1');
  await mkdir(removed, { recursive: true }); await mkdir(live, { recursive: true });
  const orphan = await reparented(removed, root), kept = await reparented(live, root);
  const prompt = detached(root, 'sleep 300', 'claude', `Read ${removed} and continue from its diff.`);
  await rm(removed, { recursive: true });

  assert.deepEqual(await stopOrphansOfRemovedWorktrees([worktrees]), [], 'younger than the default age: it may be creating that path');
  assert.equal(running(orphan), true);

  const procRoot = join(root, 'proc');
  await mkdir(join(procRoot, String(orphan)), { recursive: true });
  await writeFile(join(procRoot, 'uptime'), '99999999.00 0.00\n');
  const stat = readFileSync(`/proc/${orphan}/stat`, 'utf8'), close = stat.lastIndexOf(') ') + 2, fields = stat.slice(close).split(' ');
  fields[4] = '34816';
  await writeFile(join(procRoot, String(orphan), 'stat'), stat.slice(0, close) + fields.join(' '));
  await writeFile(join(procRoot, String(orphan), 'mountinfo'), `99 36 8:2 /x ${removed} rw - ext4 /dev/root rw\n`);
  assert.deepEqual(await stopOrphansOfRemovedWorktrees([worktrees], { procRoot }), [], 'a process on a terminal is its pane\'s');
  assert.equal(running(orphan), true);

  const stopped = await stopOrphansOfRemovedWorktrees([worktrees], { minAgeMs: 0, graceMs: 500 });
  assert.equal(stopped.length, 1, stopped.join());
  assert.equal(running(orphan), false, 'already orphaned: stopped by the sweep');
  assert.equal(running(kept), true, 'its worktree still exists');
  assert.equal(running(prompt), true, 'a prompt mentioning the worktree does not name it');
});
