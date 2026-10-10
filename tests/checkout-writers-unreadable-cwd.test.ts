import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkoutProcessScan, checkoutWriterProcesses, freezeCheckoutWriters } from '../src/cli/checkout-writers.js';
import { checkoutRestoreRefPrefix, restoreCoordinatorCheckout } from '../src/cli/master-checkout-restore.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1663: writer discovery read an unreadable /proc/PID/cwd as "not in the checkout", so a live
// process of this user it could not verify (a non-dumpable one) was skipped and checkout-restore
// snapshotted and reset paths while it might still write. Such a process is now unverifiable, and
// the restore refuses before any snapshot or reset, naming the pid and the read error.

/** A fake /proc entry: its stat line, its cwd (a symlink to the directory, or a plain file readlink refuses), its cgroup. */
function processEntry(proc: string, pid: number, options: { ppid?: number; state?: string; cwd?: string | null; cgroup?: string }) {
  const directory = join(proc, String(pid));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'stat'), `${pid} (proc ${pid}) ${options.state ?? 'S'} ${options.ppid ?? 1} ${pid} ${pid} 0 -1\n`);
  writeFileSync(join(directory, 'cgroup'), `0::${options.cgroup ?? '/user.slice/user-1000.slice/session-1.scope'}\n`);
  if (options.cwd) symlinkSync(options.cwd, join(directory, 'cwd'));
  else writeFileSync(join(directory, 'cwd'), '');
}

test('unit:checkout-writers-unreadable-cwd — a process of this user whose cwd cannot be read is unverifiable and checkout-restore refuses before any snapshot or reset', async () => {
  const base = await temporaryDirectory('checkout-writers-unreadable-cwd');
  const root = join(base, 'coordinator');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 1;\n');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  git('add', '-A'); git('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'base');
  const checkout = realpathSync(root), elsewhere = realpathSync(base);
  const proc = join(base, 'proc'), uid = process.getuid!();
  processEntry(proc, 1, { cwd: '/' });
  processEntry(proc, 90, { cwd: null });                                      // the loop's ancestor: spared
  processEntry(proc, 100, { ppid: 90, cwd: elsewhere });                      // the loop itself
  processEntry(proc, 200, { cwd: null });                                     // unreadable, this user's: unverifiable
  processEntry(proc, 300, { cwd: null, cgroup: '/user.slice/user-1000.slice/user@1000.service/app.slice/graphyard-watch-42-abc.scope' }); // a managed session: spared
  processEntry(proc, 400, { cwd: null, state: 'Z' });                         // a zombie writes nothing
  processEntry(proc, 500, { cwd: checkout });                                 // a standing writer
  processEntry(proc, 600, { cwd: join(checkout, '.graphyard') });              // the managed area: no writer

  const scan = checkoutProcessScan(root, 100, proc, uid);
  assert.deepEqual(scan.writers, [500]);
  assert.deepEqual(scan.unverifiable.map(entry => entry.pid), [200], 'only the unreadable process of this user, outside the loop and its managed sessions, is unverifiable');
  assert.match(scan.unverifiable[0].error, /EINVAL/);
  assert.throws(() => checkoutWriterProcesses(root, 100, proc, uid), /pid 200 \(EINVAL[^)]*\) cannot be read.*nothing was restored/);
  // Another user's process is not this user's to judge.
  assert.deepEqual(checkoutProcessScan(root, 100, proc, uid + 1).unverifiable, []);

  // The freeze refuses before signalling anything, and the restore before any snapshot or reset.
  const sent: string[] = [];
  const freeze = (directory: string) => freezeCheckoutWriters(directory, { scan: at => checkoutWriterProcesses(at, 100, proc, uid), signal: (pid, name) => { sent.push(`${name}:${pid}`); }, state: pid => sent.includes(`SIGSTOP:${pid}`) && !sent.includes(`SIGCONT:${pid}`) ? 'T' : 'S' });
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 2; // hotfix\n');
  writeFileSync(join(root, 'scratchpad.mjs'), '// scratch\n');
  await assert.rejects(restoreCoordinatorCheckout(root, 'restore', undefined, new Date(), freeze), /pid 200 \(EINVAL[^)]*\).*nothing was restored/);
  assert.deepEqual(sent, [], 'nothing was signalled');
  assert.equal(readFileSync(join(root, 'src', 'loop.ts'), 'utf8'), 'export const loop = 2; // hotfix\n', 'the tracked change stands');
  assert.ok(existsSync(join(root, 'scratchpad.mjs')), 'the untracked file stands');
  assert.equal(git('for-each-ref', checkoutRestoreRefPrefix), '', 'no ref was written');

  // Once the unverifiable process is gone, the restore proceeds: the writer is stopped and continued.
  rmSync(join(proc, '200'), { recursive: true, force: true });
  const restored = await restoreCoordinatorCheckout(root, 'restore', undefined, new Date(), freeze);
  assert.deepEqual(restored?.paths.sort(), ['scratchpad.mjs', 'src/loop.ts']);
  assert.deepEqual(sent, ['SIGSTOP:500', 'SIGCONT:500']);
});
