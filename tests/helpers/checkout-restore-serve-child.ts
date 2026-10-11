// The serve entry as a release snapshot's CLI runs it (GY-1680), for the integration proofs in
// tests/checkout-restore-release.test.ts: the fixture release's bin/graphyard.mjs starts this file
// with the loop's arguments (`master checkout-restore --serve ROOT REASON`). It runs the real serve
// entry against a fake /proc the test wrote (GRAPHYARD_TEST_FAKE_PROC), refusing the cwd reads the
// test names EACCES (GRAPHYARD_TEST_DENY_PATHS, as the kernel does for a non-dumpable process),
// recording the signals it would send instead of sending them, and writes what it saw — the
// snapshot it ran from, that snapshot's HEAD and object store, the signals — to
// GRAPHYARD_TEST_SERVE_RECORD for the test to assert on.
import { execFileSync } from 'node:child_process';
import fs, { existsSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { serveCheckoutRestoreAct } from '../../src/cli/checkout-restore-release.js';
import { checkoutWriterScan, freezeCheckoutWriters } from '../../src/cli/checkout-writers.js';

const proc = process.env.GRAPHYARD_TEST_FAKE_PROC!, record = process.env.GRAPHYARD_TEST_SERVE_RECORD!, snapshot = process.env.GRAPHYARD_TEST_SNAPSHOT ?? null;
const denied = new Set((process.env.GRAPHYARD_TEST_DENY_PATHS ?? '').split(',').filter(Boolean));
/** Writers that never show stopped (GRAPHYARD_TEST_NEVER_STOPS): the freeze must refuse on them. */
const neverStops = new Set((process.env.GRAPHYARD_TEST_NEVER_STOPS ?? '').split(',').filter(Boolean).map(Number));
const readlink = fs.readlinkSync;
fs.readlinkSync = ((path: string, ...rest: unknown[]) => {
  if (denied.has(String(path))) throw Object.assign(new Error(`EACCES: permission denied, readlink '${String(path)}'`), { code: 'EACCES', errno: -13, syscall: 'readlink', path: String(path) });
  return (readlink as (...args: unknown[]) => unknown)(path, ...rest);
}) as typeof fs.readlinkSync;
syncBuiltinESMExports();

const sent: string[] = [];
const git = (...args: string[]) => { try { return execFileSync('git', ['-C', snapshot!, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const write = (outcome: unknown) => writeFileSync(record, JSON.stringify({
  entry: process.argv[1], args: process.argv.slice(2), snapshot, sent, outcome,
  snapshotHead: snapshot ? git('rev-parse', 'HEAD') : null, snapshotBranch: snapshot ? git('symbolic-ref', '-q', 'HEAD') : null,
  snapshotShared: snapshot ? existsSync(join(snapshot, '.git', 'objects', 'info', 'alternates')) : null,
  snapshotModules: snapshot ? existsSync(join(snapshot, 'node_modules')) : null,
}));
const args = process.argv.slice(2);
if (args[0] !== 'master' || args[1] !== 'checkout-restore' || args[2] !== '--serve') { write({ error: `unexpected arguments ${args.join(' ')}` }); console.error(`unexpected arguments: ${args.join(' ')}`); process.exit(2); }
try {
  const uid = process.getuid!();
  const output = await serveCheckoutRestoreAct(args.slice(3), {
    quiesce: directory => freezeCheckoutWriters(directory, { scan: at => checkoutWriterScan(at, 100, proc, uid), signal: (pid, name) => { sent.push(`${name}:${pid}`); }, state: pid => !neverStops.has(pid) && sent.includes(`SIGSTOP:${pid}`) && !sent.includes(`SIGCONT:${pid}`) ? 'T' : 'S', settleMs: 50, pollMs: 1 }),
  });
  write(output);
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  write({ error: error instanceof Error ? error.message : String(error) });
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
