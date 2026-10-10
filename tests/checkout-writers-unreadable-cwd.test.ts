import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs, { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import * as writers from '../src/cli/checkout-writers.js';
import { checkoutWriterProcesses, checkoutWriterScan, freezeCheckoutWriters, processStateOf } from '../src/cli/checkout-writers.js';
import { checkoutRestoreRefPrefix, fileCheckoutRestoreRequest, readCheckoutRestoreRequest, restoreCoordinatorCheckout, serveCheckoutRestore } from '../src/cli/master-checkout-restore.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1663: writer discovery read an unreadable /proc/PID/cwd as "not in the checkout", so a live
// process of this user it could not verify (a non-dumpable one) was skipped and checkout-restore
// snapshotted and reset paths while it might still write. Such a process is now unverifiable, and
// the restore refuses before any snapshot or reset, naming the pid and the read error.
// GY-1672: a read refused EACCES (a non-dumpable process denying this user its /proc links — sd-pam,
// a password manager) is recorded as skipped instead, since such processes stand permanently and
// refusing on them left checkout-restore no way to complete.

/** A fake /proc entry: its stat line, its cwd (a symlink to the directory, or a plain file readlink refuses), its cgroup. */
function processEntry(proc: string, pid: number, options: { ppid?: number; state?: string; flags?: number; cwd?: string | null; cgroup?: string }) {
  const directory = join(proc, String(pid));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'stat'), `${pid} (proc ${pid}) ${options.state ?? 'S'} ${options.ppid ?? 1} ${pid} ${pid} 0 -1 ${options.flags ?? 0x400100}\n`);
  writeFileSync(join(directory, 'cgroup'), `0::${options.cgroup ?? '/user.slice/user-1000.slice/session-1.scope'}\n`);
  if (options.cwd) symlinkSync(options.cwd, join(directory, 'cwd'));
  else writeFileSync(join(directory, 'cwd'), '');
}
/** A thread of a fake /proc entry, under /proc/PID/task/TID. */
function threadEntry(proc: string, pid: number, tid: number, options: { state?: string; cwd?: string | null }) {
  const directory = join(proc, String(pid), 'task', String(tid));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'stat'), `${tid} (proc ${pid}) ${options.state ?? 'S'} 1 ${pid} ${pid} 0 -1 4194560\n`);
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
  // A zombie leader whose main thread called pthread_exit: a live sibling thread still writes.
  processEntry(proc, 410, { cwd: null, state: 'Z' }); threadEntry(proc, 410, 410, { state: 'Z', cwd: null }); threadEntry(proc, 410, 411, { cwd: checkout });
  processEntry(proc, 420, { cwd: null, state: 'Z' }); threadEntry(proc, 420, 421, { cwd: null });           // its live thread's cwd is unreadable too: unverifiable
  processEntry(proc, 430, { cwd: null, state: 'Z' }); threadEntry(proc, 430, 430, { state: 'Z', cwd: null }); threadEntry(proc, 430, 431, { state: 'Z', cwd: null }); // no live thread: gone
  processEntry(proc, 500, { cwd: checkout });                                 // a standing writer
  processEntry(proc, 600, { cwd: join(checkout, '.graphyard') });              // the managed area: no writer
  processEntry(proc, 700, { cwd: null, state: 'I', ppid: 2, flags: 0x04208040 }); // a kernel thread (PF_KTHREAD), as root sees it: no writer
  processEntry(proc, 800, { cwd: null });                                     // exits between its stat and its cwd read: a zombie by the recheck

  // pid 800 is live when its stat is first read and has become a zombie when its cwd read fails.
  const readlink = fs.readlinkSync;
  fs.readlinkSync = ((path: string, ...rest: unknown[]) => {
    if (String(path) === join(proc, '800', 'cwd')) writeFileSync(join(proc, '800', 'stat'), '800 (proc 800) Z 1 800 800 0 -1 4194316\n');
    return (readlink as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readlinkSync;
  syncBuiltinESMExports();

  const scan = writers.checkoutProcessScan(root, 100, proc, uid);
  assert.deepEqual(scan.writers, [410, 500], 'a zombie leader with a live thread in the checkout is a writer');
  assert.deepEqual(scan.unverifiable.map(entry => entry.pid), [200, 420], 'only the unreadable live processes of this user, outside the loop, its managed sessions and the kernel, are unverifiable');
  assert.match(scan.unverifiable[0].error, /EINVAL/);
  assert.match(scan.unverifiable[1].error, /live thread 421's cwd cannot be read either/);
  fs.readlinkSync = readlink; syncBuiltinESMExports();

  // The freeze stops that zombie leader's live sibling rather than reading the leader as gone: SIGSTOP
  // to the leader's pid stops the whole group, and the group shows stopped only once that thread does.
  assert.equal(processStateOf(410, proc), 'S', 'a zombie leader with a live thread is judged by that thread');
  assert.equal(processStateOf(430, proc), 'Z', 'a zombie leader with no live thread is gone');
  const groupSent: string[] = [];
  const stopGroup = (pid: number, name: NodeJS.Signals) => {
    groupSent.push(`${name}:${pid}`);
    if (pid === 410) writeFileSync(join(proc, '410', 'task', '411', 'stat'), `411 (proc 410) ${name === 'SIGSTOP' ? 'T' : 'S'} 1 410 410 0 -1 4194560\n`);
  };
  const frozen = await freezeCheckoutWriters(root, { scan: () => [410], signal: stopGroup, state: pid => processStateOf(pid, proc), pollMs: 1 });
  assert.deepEqual(frozen.pids, [410]); assert.equal(processStateOf(410, proc), 'T', 'the live sibling is stopped for the restore');
  frozen.thaw();
  assert.deepEqual(groupSent, ['SIGSTOP:410', 'SIGCONT:410']);
  // A sibling that never shows stopped refuses the freeze, with what it stopped continued again.
  groupSent.length = 0;
  await assert.rejects(freezeCheckoutWriters(root, { scan: () => [410], signal: (pid, name) => { groupSent.push(`${name}:${pid}`); }, state: pid => processStateOf(pid, proc), settleMs: 20, pollMs: 1 }), /writer\(s\) 410 did not stop.*nothing was restored/);
  assert.deepEqual(groupSent, ['SIGSTOP:410', 'SIGCONT:410']);

  for (const pid of ['800', '410', '420', '430']) rmSync(join(proc, pid), { recursive: true, force: true });
  assert.throws(() => checkoutWriterProcesses(root, 100, proc, uid), /pid 200 \(EINVAL[^)]*\) cannot be read.*nothing was restored/);
  // Another user's process is not this user's to judge.
  assert.deepEqual(writers.checkoutProcessScan(root, 100, proc, uid + 1).unverifiable, []);

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

/** A git checkout in a temporary directory with one committed file. */
async function coordinator(name: string) {
  const base = await temporaryDirectory(name);
  const root = join(base, 'coordinator');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 1;\n');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  git('add', '-A'); git('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'base');
  return { base, root, git, checkout: realpathSync(root), elsewhere: realpathSync(base) };
}
/** Make readlinkSync refuse the cwd of `pids` under `proc` with EACCES, as the kernel does for a non-dumpable process; returns the restore. */
function denyCwd(proc: string, pids: number[]) {
  const readlink = fs.readlinkSync, denied = new Set(pids.map(pid => join(proc, String(pid), 'cwd')));
  fs.readlinkSync = ((path: string, ...rest: unknown[]) => {
    if (denied.has(String(path))) throw Object.assign(new Error(`EACCES: permission denied, readlink '${String(path)}'`), { code: 'EACCES', errno: -13, syscall: 'readlink', path: String(path) });
    return (readlink as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readlinkSync;
  syncBuiltinESMExports();
  return () => { fs.readlinkSync = readlink; syncBuiltinESMExports(); };
}

test('unit:checkout-writers-eacces-writer-skipped — a process of this user whose cwd read is refused EACCES is recorded as skipped and the scan returns the remaining writers without error', async () => {
  const { root, checkout, elsewhere } = await coordinator('checkout-writers-eacces');
  const proc = join(root, '..', 'proc'), uid = process.getuid!();
  processEntry(proc, 1, { cwd: '/' });
  processEntry(proc, 100, { cwd: elsewhere });                 // the loop itself
  processEntry(proc, 500, { cwd: checkout });                  // a standing writer
  processEntry(proc, 510, { ppid: 500, cwd: join(checkout, 'src') }); // its child, also a writer
  processEntry(proc, 1372, { cwd: checkout });                 // sd-pam: non-dumpable, cwd read refused EACCES
  processEntry(proc, 4093087, { cwd: checkout });              // another non-dumpable daemon of this user
  const restore = denyCwd(proc, [1372, 4093087]);
  try {
    const scan = writers.checkoutProcessScan(root, 100, proc, uid);
    assert.deepEqual(scan.writers, [500, 510]);
    assert.deepEqual(scan.unverifiable, [], 'an EACCES read is no abort cause');
    assert.deepEqual(scan.skipped.map(entry => entry.pid), [1372, 4093087], 'the EACCES processes are recorded');
    assert.match(scan.skipped[0].error, /EACCES/);
    assert.deepEqual(checkoutWriterProcesses(root, 100, proc, uid), [500, 510], 'the scan returns the remaining writers without error');
    assert.deepEqual(checkoutWriterScan(root, 100, proc, uid).skipped.map(entry => entry.pid), [1372, 4093087]);
    // The freeze stops the writers only, and reports what it skipped.
    const sent: string[] = [];
    const frozen = await freezeCheckoutWriters(root, { scan: at => checkoutWriterScan(at, 100, proc, uid), signal: (pid, name) => { sent.push(`${name}:${pid}`); }, state: pid => sent.includes(`SIGSTOP:${pid}`) ? 'T' : 'S' });
    assert.deepEqual(frozen.pids, [500, 510]);
    assert.deepEqual(frozen.skipped.map(entry => entry.pid), [1372, 4093087]);
    frozen.thaw();
    assert.deepEqual(sent, ['SIGSTOP:500', 'SIGSTOP:510', 'SIGCONT:500', 'SIGCONT:510']);
    // Any other read failure still aborts: an EINVAL beside the EACCES ones is unverifiable.
    processEntry(proc, 200, { cwd: null });
    assert.throws(() => checkoutWriterProcesses(root, 100, proc, uid), /pid 200 \(EINVAL[^)]*\) cannot be read.*nothing was restored/);
  } finally { restore(); }
});

test('integration:checkout-restore-completes-unreadable-writer — checkout-restore completes while a scanned process\'s cwd is unreadable: every dirty path saved, the checkout clean at HEAD, the restart requested', async () => {
  const { base, root, git, checkout, elsewhere } = await coordinator('checkout-restore-eacces');
  const proc = join(base, 'proc'), uid = process.getuid!();
  processEntry(proc, 1, { cwd: '/' });
  processEntry(proc, 100, { cwd: elsewhere });
  processEntry(proc, 500, { cwd: checkout });
  processEntry(proc, 1372, { cwd: checkout });
  const head = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 2; // hotfix\n');
  writeFileSync(join(root, 'scratchpad.mjs'), '// scratch\n');
  mkdirSync(join(root, 'notes', 'deep'), { recursive: true });
  writeFileSync(join(root, 'notes', 'deep', 'plan.md'), '# plan\n');
  const file = join(base, 'state', 'graphyard-master.checkout-restore.json');
  mkdirSync(join(base, 'state'), { recursive: true });
  await fileCheckoutRestoreRequest(file, 'escalation:dirty-checkout', 'graphyard-doctor');
  const sent: string[] = [];
  let restarts = 0, settled = 0;
  const restore = denyCwd(proc, [1372]);
  let outcome;
  try {
    outcome = await serveCheckoutRestore(file, root, {
      pid: 100, restart: async () => { restarts++; }, settle: async () => { settled++; },
      quiesce: directory => freezeCheckoutWriters(directory, { scan: at => checkoutWriterScan(at, 100, proc, uid), signal: (pid, name) => { sent.push(`${name}:${pid}`); }, state: pid => sent.includes(`SIGSTOP:${pid}`) && !sent.includes(`SIGCONT:${pid}`) ? 'T' : 'S' }),
    });
  } finally { restore(); }
  assert.equal(outcome?.state, 'restored', outcome?.detail);
  assert.deepEqual([...outcome!.paths].sort(), ['notes/deep/plan.md', 'scratchpad.mjs', 'src/loop.ts']);
  assert.match(outcome!.detail, /skipped, their cwd unreadable: pid 1372 \(EACCES/);
  assert.ok(outcome!.ref?.startsWith(checkoutRestoreRefPrefix));
  assert.equal(git('for-each-ref', '--format=%(refname)', checkoutRestoreRefPrefix), outcome!.ref);
  // Nothing is discarded: the ref's tree holds every dirty byte on top of HEAD.
  assert.equal(git('rev-parse', `${outcome!.ref}^1`), head);
  assert.equal(git('show', `${outcome!.ref}:src/loop.ts`), 'export const loop = 2; // hotfix');
  assert.equal(git('show', `${outcome!.ref}:scratchpad.mjs`), '// scratch');
  assert.equal(git('show', `${outcome!.ref}:notes/deep/plan.md`), '# plan');
  // The checkout is clean at HEAD.
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '');
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(join(root, 'src', 'loop.ts'), 'utf8'), 'export const loop = 1;\n');
  // The writer was stopped and continued; the skipped process was never signalled.
  assert.deepEqual(sent, ['SIGSTOP:500', 'SIGCONT:500']);
  // The restart the loop serves is written and asked for.
  assert.equal(settled, 1); assert.equal(restarts, 1);
  const stored = await readCheckoutRestoreRequest(file);
  assert.equal(stored?.outcome?.state, 'restored');
  assert.equal(stored?.outcome?.restart?.state, 'requested');
  assert.equal(stored?.outcome?.restart?.pid, 100);
});
