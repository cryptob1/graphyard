// The serve entry as a release snapshot's CLI runs it (GY-1680), for the integration proofs in
// tests/checkout-restore-release.test.ts and the soaks in tests/soak-checkout-restore.test.ts: the
// fixture release's bin/graphyard.mjs starts this file with the loop's arguments (`master
// checkout-restore --serve`) and environment (the path of the loop's signed grant). It runs the real
// serve entry — the grant verified against the installation the checkout holds and this process's
// real ancestry — against a fake /proc the test
// wrote (GRAPHYARD_TEST_FAKE_PROC), refusing the cwd reads the test names EACCES
// (GRAPHYARD_TEST_DENY_PATHS, as the kernel does for a non-dumpable process), recording the signals
// it would send instead of sending them, holding the freeze for GRAPHYARD_TEST_SERVE_DELAY_MS when
// the test names one (a restore outlasting the supervisor's watchdog window), and writes what it saw
// — the snapshot it ran from, that snapshot's HEAD and object store, the grant it was handed, the
// signals, when the freeze began and ended, and where the checkout's HEAD stood and whether it was
// clean at the moment of the thaw (before any SIGCONT: an old-HEAD handoff's advance must already
// have landed, review of GY-1680) — to GRAPHYARD_TEST_SERVE_RECORD for the test to assert on.
import { execFileSync } from 'node:child_process';
import fs, { existsSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { daemonStatePath } from '../../src/daemon/state.js';
import { checkoutRestoreGrantVariable, lockedLoop } from '../../src/cli/checkout-restore-release.js';
import { ancestorPids, serveCheckoutRestoreAct } from '../../src/cli/checkout-restore-serve.js';
import { checkoutWriterScan, freezeCheckoutWriters } from '../../src/cli/checkout-writers.js';

const proc = process.env.GRAPHYARD_TEST_FAKE_PROC!, record = process.env.GRAPHYARD_TEST_SERVE_RECORD!, snapshot = process.env.GRAPHYARD_TEST_SNAPSHOT ?? null;
const denied = new Set((process.env.GRAPHYARD_TEST_DENY_PATHS ?? '').split(',').filter(Boolean));
/** Writers that never show stopped (GRAPHYARD_TEST_NEVER_STOPS): the freeze must refuse on them. */
const neverStops = new Set((process.env.GRAPHYARD_TEST_NEVER_STOPS ?? '').split(',').filter(Boolean).map(Number));
/** How long the freeze is held before the restore (GRAPHYARD_TEST_SERVE_DELAY_MS): a long act the loop must keep its supervisor fed through. */
const holdMs = Number(process.env.GRAPHYARD_TEST_SERVE_DELAY_MS ?? 0) || 0;
/** The soak's simulated loop pid (GRAPHYARD_TEST_LOOP_PID): the real loop run under a fake identity by the test process, counted as an issuer beside this process's real ancestry; absent, the real ancestry alone decides. */
const loopPid = Number(process.env.GRAPHYARD_TEST_LOOP_PID ?? '') || null;
let frozenAt: number | null = null, thawedAt: number | null = null, headAtThaw: string | null = null, statusAtThaw: string | null = null;
const readlink = fs.readlinkSync;
fs.readlinkSync = ((path: string, ...rest: unknown[]) => {
  if (denied.has(String(path))) throw Object.assign(new Error(`EACCES: permission denied, readlink '${String(path)}'`), { code: 'EACCES', errno: -13, syscall: 'readlink', path: String(path) });
  return (readlink as (...args: unknown[]) => unknown)(path, ...rest);
}) as typeof fs.readlinkSync;
syncBuiltinESMExports();

const sent: string[] = [];
const git = (...args: string[]) => gitIn(snapshot!, ...args);
const gitIn = (directory: string, ...args: string[]) => { try { return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const grantFile = process.env[checkoutRestoreGrantVariable] ?? null;
const grant = (() => { try { return grantFile ? JSON.parse(fs.readFileSync(grantFile, 'utf8')) : null; } catch { return null; } })();
const write = (outcome: unknown) => writeFileSync(record, JSON.stringify({
  entry: process.argv[1], args: process.argv.slice(2), snapshot, sent, outcome,
  // The serve child's own boot, as the release's CLI entry saw it (GY-2437): the loader imports it was handed and the entry it ran.
  launcher: process.env.GRAPHYARD_TEST_LAUNCHER ? JSON.parse(process.env.GRAPHYARD_TEST_LAUNCHER) as { execArgv: string[]; argv: string[] } : null,
  grant: { file: grantFile, content: grant, consumed: grantFile ? !existsSync(grantFile) : null },
  pid: process.pid, ppid: process.ppid, frozenAt, thawedAt, headAtThaw, statusAtThaw, holdMs,
  snapshotHead: snapshot ? git('rev-parse', 'HEAD') : null, snapshotBranch: snapshot ? git('symbolic-ref', '-q', 'HEAD') : null,
  snapshotShared: snapshot ? existsSync(join(snapshot, '.git', 'objects', 'info', 'alternates')) : null,
  snapshotModules: snapshot ? existsSync(join(snapshot, 'node_modules')) : null,
}));
const args = process.argv.slice(2);
if (args[0] !== 'master' || args[1] !== 'checkout-restore' || args[2] !== '--serve') { write({ error: `unexpected arguments ${args.join(' ')}` }); console.error(`unexpected arguments: ${args.join(' ')}`); process.exit(2); }
try {
  const uid = process.getuid!();
  const output = await serveCheckoutRestoreAct(args.slice(3), {
    // GY-1745: the release a diverged HEAD moves onto is the fixture snapshot's HEAD, not this worktree's, which the fixture's object store lacks.
    ...(snapshot ? { diverge: async (config: { baseBranch: string }, _root: string, _run: unknown) => ({ base: `refs/remotes/origin/${config.baseBranch}`, loaded: (await lockedLoop(daemonStatePath(config as never)))?.loaded ?? null, serving: git('rev-parse', 'HEAD')! }) } : {}),
    ...(loopPid ? { ancestors: () => [process.pid, ...ancestorPids(), loopPid] } : {}),
    quiesce: async directory => {
      frozenAt = Date.now();
      const frozen = await freezeCheckoutWriters(directory, { scan: at => checkoutWriterScan(at, 100, proc, uid), signal: (pid, name) => { sent.push(`${name}:${pid}`); }, state: pid => !neverStops.has(pid) && sent.includes(`SIGSTOP:${pid}`) && !sent.includes(`SIGCONT:${pid}`) ? 'T' : 'S', settleMs: 50, pollMs: 1 });
      if (holdMs) await delay(holdMs);
      // The checkout as it stands when the writers are about to be continued: HEAD and its cleanliness, read before any SIGCONT.
      return { ...frozen, thaw: () => { thawedAt = Date.now(); headAtThaw = gitIn(directory, 'rev-parse', 'HEAD'); statusAtThaw = gitIn(directory, 'status', '--porcelain', '--untracked-files=all'); frozen.thaw(); } };
    },
  });
  write(output);
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  write({ error: error instanceof Error ? error.message : String(error) });
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
