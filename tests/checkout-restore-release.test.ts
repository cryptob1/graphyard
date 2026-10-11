import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { z } from 'zod';
import { EventEmitter } from 'node:events';
import { type CheckoutRestoreGrant, type CheckoutRestoreGrantPayload, checkoutRestoreGrantKind, checkoutRestoreGrantVariable, checkoutRestoreServeFlag, commitServes, lockedLoop, releasePinnedRestore, releaseServes, servingReleases, signCheckoutRestoreGrant, snapshotRelease, staleServingLoop } from '../src/cli/checkout-restore-release.js';
import { ancestorPids, restoreChildren, serveCheckoutRestoreAct, thawFrozenWritersOnStop } from '../src/cli/checkout-restore-serve.js';
import { continueFrozenWriters, freezeCheckoutWriters, frozenWritersLedgerKind, readFrozenWritersLedger } from '../src/cli/checkout-writers.js';
import { checkoutRestoreCommand, checkoutRestoreFreezeLedgerPath, checkoutRestoreGrantPath, checkoutRestoreRefPrefix, checkoutRestoreRequestPath, fileCheckoutRestoreRequest, loopRestartRequestPath, readCheckoutRestoreRequest, restoreInProcess, serveCheckoutRestore } from '../src/cli/master-checkout-restore.js';
import { atomicPrivateWrite } from '../src/master/config.js';
import { checkoutRestoreDriftRemedy, coordinatorCheckoutGuard } from '../src/daemon/run.js';
import { daemonStatePath, emptyDaemonState } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { readCoordinatorCheckout } from '../src/master/profiles.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Time-bomb allowance (GY-1694): the 2030-01-01 ledger `at` is a stored string nothing dates; the 2026-10-11 grants are judged by the explicit now/clock handed to the act; Date.now() bounds waits and real-clock grants.
// GY-1680 (instance GY-1679): the loop served `master checkout-restore` from the code it had loaded,
// so GY-1672's unreadable-cwd skip, merged and deployed, reached no installation whose loop could
// not restart — the loop the request exists to restart — and a request that found the checkout
// clean but at a HEAD the loop had not loaded ended `clean`, with no settle and no restart, while the
// drift escalation stood. The act now runs from the verified serving release's own CLI in a detached
// shared-clone snapshot of it, under a single-use grant the loop signs with the coordinator
// credential — the authority a worker, a confined master or a hand lacks — which the entry verifies
// against the installation the checkout holds, never against anything the caller chose, and a clean
// drifted checkout is adopted: settled, and restarted onto. The loop's own loaded code never serves:
// when no sanctioned release can, the request fails naming why. The supervisor's watchdog is fed for
// as long as the act runs (review of GY-1680).

/**
 * The fixture's directory under the host's tmpdir, tracked for the file's after hook but carrying no
 * owner marker: a marker names this process's pid, and a worker's session runs in its own PID
 * namespace (bwrap --unshare-pid), where that pid means nothing to the host — whose tmp sweeps (the
 * loop's reclaim pass, another suite's runner) read the marker, find no such live process and remove
 * the directory within a second of its creation, mid-test. Ownerless, a `graphyard-*` directory is
 * reclaimed only once two hours old, so a killed run's leftover still goes.
 */
const fixtureDirectory = (label: string) => temporaryDirectory(`graphyard-${label}`, tmpdir());
const worktree = fileURLToPath(new URL('..', import.meta.url));
const helper = fileURLToPath(new URL('./helpers/checkout-restore-serve-child.ts', import.meta.url));
/** The entry that freezes and never thaws (review of GY-1680), run with tsx resolved from here: the act's cwd is the snapshot, where nothing resolves. */
const hangHelper = fileURLToPath(new URL('./helpers/checkout-restore-freeze-hang.ts', import.meta.url)), tsx = import.meta.resolve('tsx');

/** A fake /proc entry: its stat line, its cwd (a symlink to the directory, or a plain file readlink refuses), its cgroup. */
function processEntry(proc: string, pid: number, options: { ppid?: number; state?: string; cwd?: string | null; cgroup?: string }) {
  const directory = join(proc, String(pid));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'stat'), `${pid} (proc ${pid}) ${options.state ?? 'S'} ${options.ppid ?? 1} ${pid} ${pid} 0 -1 4194560\n`);
  writeFileSync(join(directory, 'cgroup'), `0::${options.cgroup ?? '/user.slice/user-1000.slice/session-1.scope'}\n`);
  if (options.cwd) symlinkSync(options.cwd, join(directory, 'cwd'));
  else writeFileSync(join(directory, 'cwd'), '');
}
function threadEntry(proc: string, pid: number, tid: number, options: { state?: string; cwd?: string | null }) {
  const directory = join(proc, String(pid), 'task', String(tid));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'stat'), `${tid} (proc ${pid}) ${options.state ?? 'S'} 1 ${pid} ${pid} 0 -1 4194560\n`);
  if (options.cwd) symlinkSync(options.cwd, join(directory, 'cwd'));
  else writeFileSync(join(directory, 'cwd'), '');
}

/** The fixture release's CLI entry: starts the serve helper the way bin/graphyard.mjs starts src/cli.ts, naming the snapshot it runs from. */
const releaseEntry = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('../', import.meta.url));
const child = spawn(process.execPath, ['--import', 'tsx', ${JSON.stringify(helper)}, ...process.argv.slice(2)], { cwd: ${JSON.stringify(worktree)}, stdio: 'inherit', env: { ...process.env, GRAPHYARD_TEST_SNAPSHOT: here } });
child.on('exit', code => process.exit(code ?? 1));
`;
/** The serve-capable release's marker: its checkout-restore-release.ts reads the loop's signed grant. */
const serveMarker = `export const checkoutRestoreServeFlag = '--serve';\nexport const checkoutRestoreGrantVariable = ${JSON.stringify(checkoutRestoreGrantVariable)};\nexport const checkoutRestoreGrantKind = ${JSON.stringify(checkoutRestoreGrantKind)};\n`;
/** The checkout's own entry at the commit the loop loaded: were the act run from the checkout's tree, it would say so and fail. */
const loadedEntry = '#!/usr/bin/env node\nconsole.error("the checkout\'s own tree served the act");\nprocess.exit(3);\n';
const credentialValue = 'coordinator-credential-'.padEnd(48, 'c');

/**
 * The installation whose coordinator checkout is `root`: its .graphyard/master.json (private, naming
 * the checkout's own CLI launcher), its coordinator credential beside the cursor at `state`, and the
 * paths the loop and the entry derive from them.
 */
function installation(root: string, state: string) {
  mkdirSync(state, { recursive: true });
  const credentialFile = join(state, 'graphyard-master.token');
  writeFileSync(credentialFile, credentialValue, { mode: 0o600 });
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: join(root, 'bin', 'graphyard.mjs'),
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  mkdirSync(join(root, '.graphyard'), { recursive: true });
  writeFileSync(join(root, '.graphyard', 'master.json'), JSON.stringify(config), { mode: 0o600 });
  return { config, credentialFile, cursor: daemonStatePath(config), file: checkoutRestoreRequestPath(config), grantFile: checkoutRestoreGrantPath(config) };
}

/**
 * A coordinator checkout whose `release` commit holds the serve-capable CLI (what the deployment
 * step verified serving) and whose HEAD, `loaded`, is a later commit — the one the loop loaded —
 * whose own entry refuses, so only the snapshot can have served the act.
 */
async function fixture(name: string) {
  const base = await fixtureDirectory(name);
  const root = join(base, 'coordinator');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  mkdirSync(join(root, 'src', 'cli'), { recursive: true }); mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 1;\n');
  writeFileSync(join(root, 'bin', 'graphyard.mjs'), releaseEntry);
  writeFileSync(join(root, 'src', 'cli', 'checkout-restore-release.ts'), serveMarker);
  writeFileSync(join(root, '.gitignore'), '.graphyard/\nnode_modules/\n');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  git('add', '-A'); git('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'release');
  const release = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'bin', 'graphyard.mjs'), loadedEntry);
  git('add', '-A'); git('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'loaded');
  const loaded = git('rev-parse', 'HEAD');
  git('checkout', '-q', '--detach');
  const proc = join(base, 'proc'), record = join(base, 'serve-record.json');
  const checkout = realpathSync(root), elsewhere = realpathSync(base);
  processEntry(proc, 1, { cwd: '/' });
  processEntry(proc, 100, { cwd: elsewhere });   // the loop
  processEntry(proc, 500, { cwd: checkout });    // a standing writer
  processEntry(proc, 1372, { cwd: checkout });   // sd-pam: this user's, non-dumpable, its cwd read refused EACCES
  // The installation beside its cursor: the request file, the grant the loop signs for one serve, the credential it signs with, and the cursor the loop — this process, the entry's real ancestor — locks.
  const { credentialFile, cursor, file, grantFile } = installation(root, join(base, 'state'));
  writeFileSync(cursor, JSON.stringify({ lock: { id: 'lock', pid: process.pid, host: 'machine-a' } }));
  const grant = { file: grantFile, credentialFile, pid: process.pid };
  const env = { GRAPHYARD_TEST_FAKE_PROC: proc, GRAPHYARD_TEST_SERVE_RECORD: record, GRAPHYARD_TEST_DENY_PATHS: join(proc, '1372', 'cwd') };
  return { base, root, git, release, loaded, proc, record, checkout, file, grant, env };
}
/** Sets the helper's environment for the child the act spawns, returning its restoration. */
function withEnv(env: Record<string, string>) {
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  return () => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
}
const serveRecord = (record: string) => JSON.parse(readFileSync(record, 'utf8')) as { entry: string; args: string[]; snapshot: string; sent: string[]; snapshotHead: string | null; snapshotBranch: string | null; snapshotShared: boolean; snapshotModules: boolean; outcome: unknown;
  grant: { file: string | null; content: CheckoutRestoreGrant | null; consumed: boolean | null }; pid: number; ppid: number; frozenAt: number | null; thawedAt: number | null; headAtThaw: string | null; statusAtThaw: string | null };
/** The payload a grant carries, for re-signing it under a credential. */
const payloadOf = ({ signature: _signature, ...payload }: CheckoutRestoreGrant): CheckoutRestoreGrantPayload => payload;

test('integration:checkout-restore-release-pinned-serve — the loop serves a checkout-restore request from a detached shared-clone snapshot of the verified serving release, under a single-use grant it signs with the coordinator credential, and with an unreadable-cwd same-user daemon present the act completes: the freeze skips it, every dirty path is saved under refs/graphyard/checkout-restore/, the escalation is settled and the restart asked', { timeout: 120_000 }, async () => {
  const { base, root, git, release, loaded, record, file, grant, env } = await fixture('checkout-restore-release-pinned');
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 2; // hotfix\n');
  writeFileSync(join(root, 'scratchpad.mjs'), '// scratch\n');
  const request = await fileCheckoutRestoreRequest(file, 'escalation:dirty-checkout', 'graphyard-doctor');
  const settled: (string | null)[] = []; let restarts = 0;
  const restore = withEnv(env);
  let outcome;
  try {
    outcome = await serveCheckoutRestore(file, root, {
      pid: 100, restart: async () => { restarts++; }, settle: async adopt => { settled.push(adopt); }, loaded: () => loaded,
      restore: releasePinnedRestore({ release: () => ({ deployment: { source: 'endpoint', sha: release }, baseBranch: 'main' }), grant }),
    });
  } finally { restore(); }
  assert.equal(outcome?.state, 'restored', outcome?.detail);
  // The entry took no root or reason from its command line: both came from the grant the loop signed with the
  // coordinator credential and wrote beside its cursor, naming the standing request and the loop's own pid (this
  // process, the grandparent through the release's bin), which the entry verified against the installation the
  // checkout holds and consumed before acting; the loop removed what was left of it.
  const record1 = serveRecord(record);
  assert.deepEqual(record1.args, ['master', 'checkout-restore', checkoutRestoreServeFlag]);
  assert.equal(record1.grant.file, grant.file);
  assert.ok(record1.grant.content, 'the entry read the grant');
  assert.equal(record1.grant.content!.signature, signCheckoutRestoreGrant(payloadOf(record1.grant.content!), credentialValue), 'the grant is signed with the coordinator credential');
  assert.equal(record1.grant.content!.kind, checkoutRestoreGrantKind);
  assert.equal(record1.grant.content!.root, root); assert.equal(record1.grant.content!.reason, 'escalation:dirty-checkout (requested by graphyard-doctor)');
  assert.deepEqual(record1.grant.content!.request, { id: request.id });
  assert.deepEqual(record1.grant.content!.loop, { pid: process.pid }, 'one issuing pid: this process, which the cursor lock names');
  assert.equal(record1.grant.consumed, true, 'the grant was consumed by the entry before it acted');
  assert.ok(!existsSync(grant.file), 'no grant is left behind');
  assert.notEqual(record1.ppid, process.pid, 'the entry ran as a grandchild, through the release\'s own bin');
  // The act ran in a snapshot of the release — detached at the verified commit, sharing the checkout's
  // object store, with its dependencies linked — never in the checkout's tree or the loop's own code.
  const served = serveRecord(record);
  assert.equal(served.snapshotHead, release, 'the snapshot stands at the verified serving release');
  assert.equal(served.snapshotBranch, null, 'detached');
  assert.equal(served.snapshotShared, true, 'a shared clone: the checkout\'s object store, nothing copied');
  assert.ok(served.snapshot && !served.snapshot.startsWith(root) && served.entry.startsWith(worktree), `the act ran from ${served.snapshot}, outside the checkout`);
  assert.ok(!existsSync(served.snapshot), 'the snapshot is disposed once the act ends');
  assert.match(outcome!.detail, new RegExp(`served from the verified serving release ${release.slice(0, 12)}, a detached shared-clone snapshot of it`));
  // GY-1672's skip applied in the release's code: the daemon was neither a refusal nor signalled.
  assert.match(outcome!.detail, /skipped, their cwd unreadable: pid 1372 \(EACCES/);
  assert.deepEqual(served.sent, ['SIGSTOP:500', 'SIGCONT:500'], 'the writer was stopped and continued; the skipped daemon never signalled');
  // Every dirty path is saved under the ref, on top of the HEAD the loop loaded, and the checkout is clean there.
  assert.deepEqual([...outcome!.paths].sort(), ['scratchpad.mjs', 'src/loop.ts']);
  assert.ok(outcome!.ref?.startsWith(checkoutRestoreRefPrefix));
  assert.equal(git('for-each-ref', '--format=%(refname)', checkoutRestoreRefPrefix), outcome!.ref);
  assert.equal(git('rev-parse', `${outcome!.ref}^1`), loaded);
  assert.equal(git('show', `${outcome!.ref}:src/loop.ts`), 'export const loop = 2; // hotfix');
  assert.equal(git('show', `${outcome!.ref}:scratchpad.mjs`), '// scratch');
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '');
  assert.equal(git('rev-parse', 'HEAD'), loaded);
  // The loop's own part: the escalation settled (no HEAD adopted), the restart owed and asked.
  assert.deepEqual(settled, [null]); assert.equal(restarts, 1);
  const stored = await readCheckoutRestoreRequest(file);
  assert.equal(stored?.outcome?.state, 'restored');
  assert.equal(stored?.outcome?.restart?.state, 'requested');
  assert.equal(stored?.outcome?.restart?.pid, 100);
  assert.ok(!readFileSync(join(base, 'serve-record.json'), 'utf8').includes('own tree served'), 'the checkout\'s own entry never ran');
});

test('integration:freeze-fail-closed-preserved — served from the release snapshot, the restore still fails closed before anything is touched: a live thread of a cwd-unreadable process inside the checkout that never shows stopped, or one whose thread cwd cannot be read either, refuses the act, and the dirty paths, the escalation and the loop stand as they were', { timeout: 120_000 }, async () => {
  const { root, git, release, loaded, proc, record, checkout, file, grant, env } = await fixture('checkout-restore-release-fail-closed');
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 2; // hotfix\n');
  writeFileSync(join(root, 'scratchpad.mjs'), '// scratch\n');
  // pid 410: its cwd read refused EACCES, its leader a zombie, its live thread 411 inside the checkout — a writer the freeze must stop.
  processEntry(proc, 410, { cwd: checkout, state: 'Z' }); threadEntry(proc, 410, 410, { state: 'Z', cwd: null }); threadEntry(proc, 410, 411, { cwd: checkout });
  const settled: (string | null)[] = []; let restarts = 0;
  const serve = () => serveCheckoutRestore(file, root, {
    pid: 100, restart: async () => { restarts++; }, settle: async adopt => { settled.push(adopt); }, loaded: () => loaded,
    restore: releasePinnedRestore({ release: () => ({ deployment: { source: 'endpoint', sha: release }, baseBranch: 'main' }), grant }),
  });
  const untouched = (served: ReturnType<typeof serveRecord>) => {
    assert.equal(readFileSync(join(root, 'src', 'loop.ts'), 'utf8'), 'export const loop = 2; // hotfix\n', 'the tracked change stands');
    assert.ok(existsSync(join(root, 'scratchpad.mjs')), 'the untracked file stands');
    assert.equal(git('for-each-ref', checkoutRestoreRefPrefix), '', 'no ref was written');
    assert.equal(served.snapshotHead, release, 'the act ran from the release snapshot');
    assert.equal(served.grant.consumed, true, 'the grant was consumed even though the act refused'); assert.ok(!existsSync(grant.file));
    assert.deepEqual(settled, []); assert.equal(restarts, 0);
  };
  // The thread shows the process inside the checkout: it is frozen, not skipped, and when it never shows stopped the act refuses with what it stopped continued.
  await fileCheckoutRestoreRequest(file, 'escalation:dirty-checkout', 'graphyard-doctor');
  let restore = withEnv({ ...env, GRAPHYARD_TEST_DENY_PATHS: `${join(proc, '1372', 'cwd')},${join(proc, '410', 'cwd')}`, GRAPHYARD_TEST_NEVER_STOPS: '410' });
  let outcome;
  try { outcome = await serve(); } finally { restore(); }
  assert.equal(outcome?.state, 'failed', outcome?.detail);
  assert.match(outcome!.detail, /served from the verified serving release .*writer\(s\) 410 did not stop within \d+ms of SIGSTOP, so nothing was restored/s);
  let served = serveRecord(record);
  assert.deepEqual(served.sent.filter(entry => entry.startsWith('SIGSTOP')).sort(), ['SIGSTOP:410', 'SIGSTOP:500'], 'the thread-identified writer is stopped like any other, and the EACCES daemon still skipped');
  assert.deepEqual(served.sent.filter(entry => entry.startsWith('SIGCONT')).sort(), ['SIGCONT:410', 'SIGCONT:500'], 'everything this attempt stopped is continued again');
  untouched(served);
  assert.equal((await readCheckoutRestoreRequest(file))?.outcome?.state, 'failed');
  // The thread's cwd cannot be read either: the process cannot be judged, so the act refuses before signalling anything.
  await fileCheckoutRestoreRequest(file, 'escalation:dirty-checkout again', 'graphyard-doctor');
  restore = withEnv({ ...env, GRAPHYARD_TEST_DENY_PATHS: `${join(proc, '1372', 'cwd')},${join(proc, '410', 'cwd')},${join(proc, '410', 'task', '411', 'cwd')}` });
  try { outcome = await serve(); } finally { restore(); }
  assert.equal(outcome?.state, 'failed', outcome?.detail);
  assert.match(outcome!.detail, /pid 410 \(EACCES.*live thread 411's cwd cannot be read either.*cannot be read, so whether it writes in the checkout cannot be verified and nothing was restored/s);
  served = serveRecord(record);
  assert.deepEqual(served.sent, [], 'nothing was signalled');
  untouched(served);
  // A live leader whose own cwd read is refused is judged by its live threads too (review of GY-1680): one whose
  // thread shows it inside the checkout is a writer the freeze must stop, and when it never shows stopped the act
  // refuses with what it stopped continued; its leader's refusal alone never skips it.
  execFileSync('rm', ['-rf', join(proc, '410')]);
  processEntry(proc, 1380, { cwd: checkout }); threadEntry(proc, 1380, 1380, { cwd: checkout }); threadEntry(proc, 1380, 1381, { cwd: join(checkout, 'src') });
  await fileCheckoutRestoreRequest(file, 'escalation:dirty-checkout, a live daemon in the checkout', 'graphyard-doctor');
  restore = withEnv({ ...env, GRAPHYARD_TEST_DENY_PATHS: `${join(proc, '1372', 'cwd')},${join(proc, '1380', 'cwd')}`, GRAPHYARD_TEST_NEVER_STOPS: '1380' });
  try { outcome = await serve(); } finally { restore(); }
  assert.equal(outcome?.state, 'failed', outcome?.detail);
  assert.match(outcome!.detail, /served from the verified serving release .*writer\(s\) 1380 did not stop within \d+ms of SIGSTOP, so nothing was restored/s);
  served = serveRecord(record);
  assert.deepEqual(served.sent.filter(entry => entry.startsWith('SIGSTOP')).sort(), ['SIGSTOP:1380', 'SIGSTOP:500'], 'the live thread-identified writer is stopped, not skipped on its leader\'s refusal');
  assert.deepEqual(served.sent.filter(entry => entry.startsWith('SIGCONT')).sort(), ['SIGCONT:1380', 'SIGCONT:500']);
  untouched(served);
});

test('unit:serve-timeout-thaws-frozen-writers — an entry the loop\'s timeout ends after it stopped the checkout\'s writers never reaches its own thaw, so the loop finishes it: the freeze ledger the entry wrote beside the cursor before each SIGSTOP names them, the loop continues every one still stopped, leaves alone the ones gone or already running, removes the ledger and records the failure naming what it continued; nothing was restored', { timeout: 60_000 }, async () => {
  const { root, release, loaded, file, grant } = await fixture('checkout-restore-timeout-thaw');
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 2; // hotfix\n');
  await fileCheckoutRestoreRequest(file, 'escalation:dirty-checkout', 'graphyard-doctor');
  const ledger = checkoutRestoreFreezeLedgerPath({ credentialFile: grant.credentialFile }), record = join(root, '..', 'hang-record.json');
  // The loop's view of the writers once the entry is gone: 4242 still stopped by it, 4343 running again (continued by a hand), 4444 gone.
  const states: Record<number, string | null> = { 4242: 'T', 4343: 'S', 4444: null };
  const continued: string[] = [], settled: (string | null)[] = []; let restarts = 0;
  const restore = withEnv({ GRAPHYARD_TEST_FREEZE_LEDGER: ledger, GRAPHYARD_TEST_SERVE_RECORD: record, GRAPHYARD_TEST_HANG_WRITERS: '4242,4343,4444', GRAPHYARD_TEST_HANG_ROOT: root });
  let outcome;
  try {
    outcome = await serveCheckoutRestore(file, root, {
      pid: 100, restart: async () => { restarts++; }, settle: async adopt => { settled.push(adopt); }, loaded: () => loaded,
      restore: releasePinnedRestore({ release: () => ({ deployment: { source: 'endpoint', sha: release }, baseBranch: 'main' }), grant, timeoutMs: 1_500,
        command: () => ({ command: process.execPath, args: ['--import', tsx, hangHelper] }),
        ledger: { file: ledger, signal: (pid, name) => { continued.push(`${name}:${pid}`); }, state: pid => states[pid] ?? null } }),
    });
  } finally { restore(); }
  assert.equal(outcome?.state, 'failed', outcome?.detail);
  assert.match(outcome!.detail, /served from the verified serving release .* did not finish within 1500ms and was killed.*; the entry ended before its own thaw, so the loop continued the writer\(s\) it had stopped, pid 4242 \(pid 4343, 4444 no longer stopped, left alone\)/s);
  assert.deepEqual(continued, ['SIGCONT:4242'], 'only the writer still stopped is continued');
  assert.ok(!existsSync(ledger), 'the ledger is removed once read');
  assert.ok(!existsSync(grant.file), 'the grant is removed');
  // The entry wrote the ledger before it stopped anything — a SIGKILL between the two leaves nothing unrecorded — naming the checkout, itself and every pid.
  const hang = JSON.parse(readFileSync(record, 'utf8')) as { pid: number; sent: string[]; stopped: number[]; ledger: { kind: string; root: string; pid: number; stopped: number[] } };
  assert.deepEqual(hang.sent, ['SIGSTOP:4242', 'SIGSTOP:4343', 'SIGSTOP:4444'], 'the entry stopped its writers and was ended before any SIGCONT');
  assert.equal(hang.ledger.kind, frozenWritersLedgerKind); assert.equal(hang.ledger.root, root); assert.equal(hang.ledger.pid, hang.pid);
  assert.deepEqual(hang.ledger.stopped, [4242, 4343, 4444]);
  // Nothing was restored, settled or restarted: the dirty path stands for the next request.
  assert.equal(readFileSync(join(root, 'src', 'loop.ts'), 'utf8'), 'export const loop = 2; // hotfix\n');
  assert.deepEqual(settled, []); assert.equal(restarts, 0);
  assert.equal((await readCheckoutRestoreRequest(file))?.outcome?.state, 'failed');
});

test('unit:freeze-ledger-and-stop-thaw — the freeze records each writer in its ledger before the SIGSTOP and removes the ledger with its thaw, a refused freeze included; continueFrozenWriters continues the pids a ledger names that still show stopped, leaves alone the gone and the running, and removes the ledger — none, or one of another kind, is null; the entry\'s own stop (SIGTERM, SIGINT) continues them and exits with the signal\'s status, and listeners are removed once the act ends', async () => {
  const base = await fixtureDirectory('freeze-ledger');
  const ledger = join(base, 'state', 'graphyard-master.checkout-restore-frozen.json');
  // Recorded before signalled: at each SIGSTOP the ledger already names the pid.
  const sent: string[] = [], seenAtStop: number[][] = [];
  const signal = (pid: number, name: NodeJS.Signals) => { if (name === 'SIGSTOP') seenAtStop.push(readFrozenWritersLedger(ledger)?.stopped ?? []); sent.push(`${name}:${pid}`); };
  const frozen = await freezeCheckoutWriters(base, { ledger, scan: () => [11, 12], signal, state: pid => sent.includes(`SIGSTOP:${pid}`) ? 'T' : 'S', settleMs: 50, pollMs: 1 });
  assert.deepEqual(seenAtStop, [[11], [11, 12]]);
  assert.deepEqual(readFrozenWritersLedger(ledger), { kind: frozenWritersLedgerKind, root: base, pid: process.pid, at: readFrozenWritersLedger(ledger)!.at, stopped: [11, 12] });
  frozen.thaw();
  assert.deepEqual(sent, ['SIGSTOP:11', 'SIGSTOP:12', 'SIGCONT:11', 'SIGCONT:12']);
  assert.ok(!existsSync(ledger), 'the thaw removes the ledger');
  // A freeze that refuses continues what it stopped and leaves no ledger.
  sent.length = 0;
  await assert.rejects(freezeCheckoutWriters(base, { ledger, scan: () => [13, 14], signal: (pid, name) => { if (pid === 14 && name === 'SIGSTOP') throw new Error('EPERM'); signal(pid, name); }, state: pid => sent.includes(`SIGSTOP:${pid}`) ? 'T' : 'S', settleMs: 50, pollMs: 1 }), /writer pid 14 could not be stopped/);
  assert.deepEqual(sent, ['SIGSTOP:13', 'SIGCONT:13']); assert.ok(!existsSync(ledger));
  // continueFrozenWriters: what a process that outlived the freezer does with its ledger.
  assert.equal(continueFrozenWriters(ledger), null, 'no ledger');
  mkdirSync(join(base, 'state'), { recursive: true });
  writeFileSync(ledger, JSON.stringify({ kind: 'something-else/1', stopped: [21] }));
  assert.equal(continueFrozenWriters(ledger, { signal: () => { throw new Error('never'); } }), null, 'another kind is not read'); assert.ok(!existsSync(ledger), 'and is removed');
  writeFileSync(ledger, JSON.stringify({ kind: frozenWritersLedgerKind, root: base, pid: 4321, at: '2030-01-01T00:00:00Z', stopped: [21, 22, 23, 21] }));
  const states: Record<number, string | null> = { 21: 'T', 22: 'S', 23: null };
  sent.length = 0;
  assert.deepEqual(continueFrozenWriters(ledger, { signal: (pid, name) => { sent.push(`${name}:${pid}`); }, state: pid => states[pid] ?? null }), { root: base, pid: 4321, continued: [21], left: [22, 23] });
  assert.deepEqual(sent, ['SIGCONT:21']); assert.ok(!existsSync(ledger));
  // The entry's own stop: the loop's SIGTERM at its timeout reaches it before any `finally`.
  writeFileSync(ledger, JSON.stringify({ kind: frozenWritersLedgerKind, root: base, pid: process.pid, at: '2030-01-01T00:00:00Z', stopped: [31, 32] }));
  const host = new EventEmitter(), exits: number[] = [], log: string[] = [];
  sent.length = 0;
  // Review of GY-1680: the restore's live Git children are ended and reaped (`halt`) before any SIGCONT —
  // a writer continued beside a Git child still saving or resetting files would race it — and a second
  // signal while the first is answered changes nothing.
  let haltResolved = false, halts = 0;
  const halt = async () => { halts++; sent.push('halt:asked'); await delay(20); haltResolved = true; sent.push('halt:reaped'); return [777]; };
  const release = thawFrozenWritersOnStop(ledger, { host, halt, exit: code => { exits.push(code); }, log: line => { log.push(line); }, signal: (pid, name) => { assert.ok(haltResolved, `${name} to ${pid} only after the Git children were reaped`); sent.push(`${name}:${pid}`); }, state: pid => pid === 31 ? 'T' : 'R' });
  assert.equal(host.listenerCount('SIGTERM'), 1); assert.equal(host.listenerCount('SIGINT'), 1);
  host.emit('SIGTERM'); host.emit('SIGINT');
  assert.deepEqual(sent, ['halt:asked'], 'nothing is continued until the halt resolves');
  for (const deadline = Date.now() + 2_000; !exits.length && Date.now() < deadline;) await delay(5);
  assert.deepEqual(sent, ['halt:asked', 'halt:reaped', 'SIGCONT:31']); assert.deepEqual(exits, [143]); assert.equal(halts, 1, 'the second signal is not answered again');
  assert.match(log[0], /was ended by SIGTERM before its thaw: ended its Git child\(ren\) pid 777 and waited for them, then continued the writer\(s\) it had stopped, pid 31; nothing more was touched/);
  assert.ok(!existsSync(ledger));
  release();
  assert.equal(host.listenerCount('SIGTERM'), 0); assert.equal(host.listenerCount('SIGINT'), 0);
});

test('unit:serve-stop-halts-git-children — the serve entry runs Git through restoreChildren: each child leads its own process group, `halt` ends the whole group (a grandchild included), SIGKILLs what ignores SIGTERM after the grace, and resolves only once every child has exited, with the child\'s run rejected; a child past its timeout is ended the same way; the entry\'s stop handler halts before it thaws (review of GY-1680)', async () => {
  const base = await fixtureDirectory('serve-stop-halts-children');
  const children = restoreChildren({ graceMs: 200 });
  // A shell whose grandchild (`sleep`) is in the same group: its pid is written for the test to watch.
  const pidFile = join(base, 'grandchild.pid');
  const shell = children.run('sh', ['-c', `sleep 60 & echo $! > ${JSON.stringify(pidFile)}; wait`], { cwd: base }) as Promise<string>;
  shell.catch(() => {});
  for (const deadline = Date.now() + 5_000; !existsSync(pidFile) && Date.now() < deadline;) await delay(10);
  const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(Number.isInteger(grandchild) && grandchild > 0, 'the grandchild started');
  assert.equal(children.live().length, 1, 'one live child');
  const [child] = children.live();
  assert.equal(process.kill(child, 0), true, 'the child is alive before the halt');
  const halted = await children.halt();
  assert.deepEqual(halted, [child], 'the halt names the child it ended');
  assert.deepEqual(children.live(), [], 'nothing is live after the halt resolves');
  await assert.rejects(shell, (error: Error & { signal?: string }) => error.name === 'ChildProcessError' && error.signal === 'SIGTERM', 'the run rejects with the signal that ended it');
  const alive = (pid: number) => { try { process.kill(pid, 0); return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] !== 'Z'; } catch { return false; } };
  for (const deadline = Date.now() + 2_000; alive(grandchild) && Date.now() < deadline;) await delay(10);
  assert.ok(!alive(grandchild), 'the grandchild in the group was ended with it');
  // One that ignores SIGTERM is SIGKILLed after the grace, and the halt still waits for it.
  // The shell ignores SIGTERM and outlives each `sleep` the group signal ends; only the SIGKILL ends it.
  const ready = join(base, 'stubborn.ready');
  const stubborn = children.run('sh', ['-c', `trap "" TERM; : > ${JSON.stringify(ready)}; while :; do sleep 1; done`], { cwd: base }) as Promise<string>;
  stubborn.catch(() => {});
  for (const deadline = Date.now() + 5_000; !existsSync(ready) && Date.now() < deadline;) await delay(5);
  assert.ok(existsSync(ready), 'the stubborn shell installed its trap');
  const started = Date.now();
  const killed = await children.halt();
  assert.equal(killed.length, 1); assert.ok(Date.now() - started >= 150, 'the grace was given before SIGKILL');
  await assert.rejects(stubborn, (error: Error & { signal?: string }) => error.name === 'ChildProcessError' && error.signal === 'SIGKILL');
  assert.deepEqual(children.live(), []);
  // A child past its timeout is ended the same way and its run rejects as timed out.
  const slow = restoreChildren({ graceMs: 100, timeoutMs: 150 });
  await assert.rejects(slow.run('sleep', ['60'], { cwd: base }) as Promise<string>, /sleep 60 did not finish within 150ms and was killed/);
  assert.deepEqual(slow.live(), []);
  // A healthy run resolves with its stdout, as the default runner does.
  assert.equal(await children.run('sh', ['-c', 'printf hello'], { cwd: base }), 'hello');
  await assert.rejects(children.run('sh', ['-c', 'echo bad >&2; exit 3'], { cwd: base }) as Promise<string>, /Command failed: sh -c echo bad >&2; exit 3\nbad/);
});

test('unit:serve-uses-verified-release — the sanctioned releases are the deployment step\'s verified sha when the store holds it, then the fetched base-branch tip at origin; the act is the first that snapshots with the serve entry, its own CLI run with `--serve` and the loop\'s signed grant in its environment, the supervisor\'s keep-alive fed throughout; when neither serves, or the credential cannot sign, the act fails naming why, and the loop\'s own code never runs', async () => {
  const base = await fixtureDirectory('serve-uses-verified-release');
  const root = join(base, 'coordinator'), origin = join(base, 'origin.git');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  mkdirSync(join(root, 'src', 'cli'), { recursive: true }); mkdirSync(join(root, 'bin'), { recursive: true }); mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'bin', 'graphyard.mjs'), '#!/usr/bin/env node\n');
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 1;\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  git('add', '-A'); git('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'before the serve entry');
  const older = git('rev-parse', 'HEAD');
  // A release whose entry took ROOT REASON from the command line (round 1 of GY-1680), or read a grant it could not verify (round 2), is not serve-capable either.
  writeFileSync(join(root, 'src', 'cli', 'checkout-restore-release.ts'), `export const checkoutRestoreServeFlag = '--serve';\nexport const checkoutRestoreGrantVariable = ${JSON.stringify(checkoutRestoreGrantVariable)};\n`);
  git('add', '-A'); git('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'the unsigned serve entry');
  const unsigned = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'src', 'cli', 'checkout-restore-release.ts'), serveMarker);
  git('add', '-A'); git('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'the serve entry');
  const served = git('rev-parse', 'HEAD');
  execFileSync('git', ['clone', '-q', '--bare', root, origin], { stdio: 'ignore' });
  git('remote', 'add', 'origin', origin);
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 2;\n');
  git('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-am', 'the loop loaded this');
  const loaded = git('rev-parse', 'HEAD');
  execFileSync('git', ['-C', origin, 'update-ref', 'refs/heads/main', served], { stdio: 'ignore' });
  const credentialFile = join(base, 'state', 'graphyard-master.token');
  mkdirSync(join(base, 'state'), { recursive: true });
  writeFileSync(credentialFile, credentialValue, { mode: 0o600 });
  const config = { credentialFile };
  const grant = { file: checkoutRestoreGrantPath(config), credentialFile, pid: process.pid };
  const request = { file: checkoutRestoreRequestPath(config), id: 'r-1' };

  // The releases, in order: the verified sha first; unobserved or missing from the store, the base branch's tip at origin, fetched; the same commit once.
  assert.deepEqual(await servingReleases(root, { deployment: { source: 'endpoint', sha: served }, baseBranch: 'main' }), { releases: [{ commit: served, source: 'deployment' }], reasons: [] });
  assert.deepEqual(await servingReleases(root, { deployment: { source: 'unavailable', sha: null }, baseBranch: 'main' }), { releases: [{ commit: served, source: 'origin' }], reasons: ['no verified release is observed serving'] });
  assert.equal(git('rev-parse', 'refs/remotes/origin/main'), served, 'the tip was fetched');
  assert.deepEqual(await servingReleases(root, { deployment: { source: 'endpoint', sha: 'f'.repeat(40) }, baseBranch: 'main' }), { releases: [{ commit: served, source: 'origin' }], reasons: [`the verified release ${'f'.repeat(12)} is missing from the checkout's object store`] });
  assert.deepEqual(await servingReleases(root, { deployment: { source: 'endpoint', sha: older }, baseBranch: 'main' }), { releases: [{ commit: older, source: 'deployment' }, { commit: served, source: 'origin' }], reasons: [] });
  const none = await servingReleases(root, { deployment: null, baseBranch: 'release' });
  assert.deepEqual(none.releases, []);
  assert.match(none.reasons.join('; '), /^no verified release is observed serving; origin\/release could not be fetched .*; refs\/remotes\/origin\/release does not resolve$/);

  // The snapshot: a shared clone detached at the commit, the checkout's node_modules linked.
  const snapshot = await snapshotRelease(root, served);
  try {
    const at = (...args: string[]) => execFileSync('git', ['-C', snapshot.directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    assert.equal(at('rev-parse', 'HEAD'), served);
    assert.throws(() => at('symbolic-ref', '-q', 'HEAD'), 'detached');
    assert.ok(existsSync(join(snapshot.directory, '.git', 'objects', 'info', 'alternates')), 'shared with the checkout\'s object store');
    assert.equal(realpathSync(join(snapshot.directory, 'node_modules')), realpathSync(join(root, 'node_modules')));
    assert.ok(releaseServes(snapshot.directory));
    assert.doesNotThrow(() => at('diff', '--quiet', 'HEAD'), 'every tracked file is the commit\'s');
  } finally { await snapshot.dispose(); }
  assert.ok(!existsSync(snapshot.directory));
  for (const [commit, why] of [[older, 'a release from before the entry would file a request of its own'], [unsigned, 'a release whose entry reads an unsigned grant cannot verify the loop\'s']] as const) {
    const pre = await snapshotRelease(root, commit);
    try { assert.equal(releaseServes(pre.directory), false, why); } finally { await pre.dispose(); }
  }

  // The act: the snapshot's CLI, run with the serve entry and nothing else on its command line; the grant beside the cursor names the rest.
  const runs: { command: string; args: string[]; cwd?: string; head: string; shared: boolean; env: NodeJS.ProcessEnv; grant: CheckoutRestoreGrant | null; pulsesBefore: number }[] = [];
  let pulses = 0;
  const entry = (output: string | Error, holdMs = 0): ChildRun => async (command, args, options) => {
    if (command === 'git') return defaultChildRun(command, args, options);
    const cwd = options?.cwd!;
    const file = options?.env?.[checkoutRestoreGrantVariable];
    runs.push({ command, args, cwd, head: execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), shared: existsSync(join(cwd, '.git', 'objects', 'info', 'alternates')), env: options?.env ?? {}, grant: file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null, pulsesBefore: pulses });
    if (holdMs) await delay(holdMs);
    if (output instanceof Error) throw output;
    return output;
  };
  const inputs = { deployment: { source: 'endpoint', sha: served }, baseBranch: 'main' };
  const at = new Date('2030-01-01T00:00:00Z');
  let clock = Date.parse('2026-10-11T00:00:00Z');
  const command = (directory: string) => ({ command: 'node', args: [join(directory, 'bin', 'graphyard.mjs')] });
  const act = releasePinnedRestore({ release: () => inputs, run: entry(JSON.stringify({ restored: null, head: loaded })), command, grant, env: { PATH: '/usr/bin' }, now: () => clock });
  const outcome = await act(root, 'the loop refuses its checkout (requested by graphyard-doctor)', at, request);
  assert.deepEqual(outcome, { restored: null, head: loaded, served: `served from the verified serving release ${served.slice(0, 12)}, a detached shared-clone snapshot of it`, release: served });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].command, 'node');
  assert.deepEqual(runs[0].args.slice(1), ['master', 'checkout-restore', checkoutRestoreServeFlag], 'no root or reason on the command line');
  assert.equal(runs[0].args[0], join(runs[0].cwd!, 'bin', 'graphyard.mjs'), 'the snapshot\'s own entry');
  assert.equal(runs[0].head, served, 'run in the snapshot at the verified release, not the checkout the loop loaded');
  assert.ok(runs[0].shared);
  assert.ok(!existsSync(runs[0].cwd!), 'the snapshot is disposed after');
  // The grant: written beside the cursor for this one serve, only its path in the child's environment (beneath the
  // environment given); the checkout, the reason, the standing request's id, the loop and a nonce, signed with the
  // coordinator credential the loop reads; removed once the child ends.
  assert.deepEqual(Object.keys(runs[0].env).sort(), ['GRAPHYARD_CHECKOUT_RESTORE_GRANT', 'PATH'], 'the environment carries the grant\'s path and nothing else of the act');
  assert.equal(runs[0].env[checkoutRestoreGrantVariable], grant.file); assert.equal(runs[0].env.PATH, '/usr/bin');
  const issued = runs[0].grant!;
  assert.match(issued.nonce, /^[0-9a-f]{32}$/);
  assert.deepEqual(payloadOf(issued), { kind: checkoutRestoreGrantKind, root, reason: 'the loop refuses its checkout (requested by graphyard-doctor)', request: { id: 'r-1' }, loop: { pid: process.pid }, issuedAt: '2026-10-11T00:00:00.000Z', expiresAt: '2026-10-11T00:15:00.000Z', nonce: issued.nonce });
  assert.equal(issued.signature, signCheckoutRestoreGrant(payloadOf(issued), credentialValue), 'signed with the coordinator credential');
  assert.notEqual(issued.signature, signCheckoutRestoreGrant(payloadOf(issued), 'another-credential'.padEnd(48, 'x')), 'another credential signs differently');
  assert.ok(!existsSync(grant.file), 'the grant does not outlive the serve');
  // The child's refusal is the act's error, its stderr the message; an unreadable outcome is an error naming it; the grant is removed either way.
  const refused = Object.assign(new Error('Command failed: node bin/graphyard.mjs master checkout-restore\nthe working directory of pid 200 (EINVAL) cannot be read, so whether it writes in the checkout cannot be verified and nothing was restored'), { stderr: 'the working directory of pid 200 (EINVAL) cannot be read, so whether it writes in the checkout cannot be verified and nothing was restored' });
  await assert.rejects(releasePinnedRestore({ release: () => inputs, run: entry(refused), command, grant })(root, 'reason', at, request), /served from the verified serving release .*: Command failed: node bin\/graphyard.mjs master checkout-restore\nthe working directory of pid 200/s);
  assert.ok(!existsSync(grant.file));
  await assert.rejects(releasePinnedRestore({ release: () => inputs, run: entry('not json'), command, grant })(root, 'reason', at, request), /served from the verified serving release .*, whose outcome could not be read \(.*\): not json/);
  assert.ok(!existsSync(grant.file));
  const nonces = new Set(runs.map(run => run.grant?.nonce));
  assert.equal(nonces.size, runs.length, 'every grant has its own nonce');
  // The supervisor's keep-alive is fed while the act runs — through the fetch and clone, and for as long as the
  // snapshot's act takes, longer than a watchdog window — and no longer once it ends (review of GY-1680).
  runs.length = 0; pulses = 0;
  const fed = await releasePinnedRestore({ release: () => inputs, run: entry(JSON.stringify({ restored: null, head: loaded }), 150), command, grant, keepAlive: async () => { pulses++; }, keepAliveEveryMs: 10 })(root, 'reason', at, request);
  assert.equal(fed.head, loaded);
  const during = pulses;
  assert.ok(during >= 8, `the keep-alive was fed ${during} times through a 150 ms act at a 10 ms cadence`);
  assert.ok(runs[0].pulsesBefore <= during, 'pulses began before or during the act');
  await delay(50);
  assert.equal(pulses, during, 'nothing is fed once the act has ended');
  runs.length = 0; pulses = 0;
  await assert.rejects(releasePinnedRestore({ release: () => inputs, run: entry(refused, 60), command, grant, keepAlive: async () => { pulses++; throw new Error('systemd-notify: not found'); }, keepAliveEveryMs: 10 })(root, 'reason', at, request), /served from the verified serving release/);
  assert.ok(pulses >= 3, 'a keep-alive that fails is fed again, and never fails the act');
  // The verified release predates the entry: origin's base-branch tip is tried next and serves, saying which.
  runs.length = 0;
  const fromOrigin = await releasePinnedRestore({ release: () => ({ deployment: { source: 'endpoint', sha: older }, baseBranch: 'main' }), run: entry(JSON.stringify({ restored: null, head: loaded })), command, grant })(root, 'reason', at, request);
  assert.equal(fromOrigin.served, `served from the origin base-branch release ${served.slice(0, 12)}, a detached shared-clone snapshot of it`);
  assert.equal(runs.length, 1); assert.equal(runs[0].head, served);
  // Neither sanctioned release serves — none can be materialized, or every one predates the entry: the act fails naming why, and the loop's own code is never run; the checkout is untouched.
  runs.length = 0;
  await assert.rejects(releasePinnedRestore({ release: () => ({ deployment: null, baseBranch: 'release' }), run: entry('never run'), command, grant })(root, 'reason', at, request),
    /^Error: no sanctioned release can serve this request, and the loop's own loaded code is not run \(GY-1680\): no verified release is observed serving; origin\/release could not be fetched .*; refs\/remotes\/origin\/release does not resolve\. Once a release holding the serve entry is observed serving or reaches origin, file master checkout-restore REASON again$/);
  assert.equal(runs.length, 0);
  execFileSync('git', ['-C', origin, 'update-ref', 'refs/heads/main', unsigned], { stdio: 'ignore' });
  await assert.rejects(releasePinnedRestore({ release: () => ({ deployment: { source: 'endpoint', sha: older }, baseBranch: 'main' }), run: entry('never run'), command, grant })(root, 'reason', at, request),
    new RegExp(`^Error: no sanctioned release can serve this request, and the loop's own loaded code is not run \\(GY-1680\\): the verified serving release ${older.slice(0, 12)} predates the serve entry; the origin base-branch release ${unsigned.slice(0, 12)} predates the serve entry\\. Once a release`));
  assert.equal(runs.length, 0);
  assert.ok(!existsSync(grant.file), 'no grant was issued');
  // The credential the loop signs with cannot be read: no grant is issued, no release is tried, and nothing is touched.
  chmodSync(credentialFile, 0o644);
  try {
    await assert.rejects(releasePinnedRestore({ release: () => inputs, run: entry('never run'), command, grant })(root, 'reason', at, request), /^Error: the coordinator credential at .* cannot be read \(.*mode 0600\), so no checkout-restore grant can be signed and nothing was restored$/);
  } finally { chmodSync(credentialFile, 0o600); }
  assert.equal(runs.length, 0);
  assert.ok(!existsSync(grant.file));
  assert.equal(git('status', '--porcelain'), '', 'a clean checkout stays clean through every path');
  assert.equal(git('rev-parse', 'HEAD'), loaded);
});

test('unit:serve-entry-bound-to-loop-grant — the serve entry acts only on a grant the loop signed with the coordinator credential, verified against the installation the checkout holds and nothing the caller chose: the checkout must hold an installation naming it as its coordinator checkout, the grant must lie where that installation\'s loop issues grants, carry that credential\'s signature, be unexpired and issued by an ancestor of the entry\'s process, the installation\'s cursor must be locked by the pid it names, and the installation\'s request file must hold the request unanswered; a forged grant, a tampered one, one in a caller\'s directory and a cursor that cannot be read are all refused before touching the checkout; the grant that verifies is consumed and serves once', async () => {
  const base = await fixtureDirectory('serve-entry-grant');
  const root = join(base, 'coordinator');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  mkdirSync(join(root, 'src'), { recursive: true }); mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 1;\n');
  writeFileSync(join(root, 'bin', 'graphyard.mjs'), '#!/usr/bin/env node\n');
  writeFileSync(join(root, '.gitignore'), '.graphyard/\n');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  git('add', '-A'); git('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'loaded');
  const head = git('rev-parse', 'HEAD');
  const { credentialFile, cursor, file, grantFile } = installation(root, join(base, 'state'));
  writeFileSync(cursor, JSON.stringify({ lock: { id: 'lock', pid: process.pid, host: 'machine-a' } }));
  const request = await fileCheckoutRestoreRequest(file, 'escalation:dirty-checkout', 'graphyard-doctor');
  const now = new Date('2026-10-11T00:05:00Z');
  const payload = (overrides: Partial<CheckoutRestoreGrantPayload> = {}): CheckoutRestoreGrantPayload => ({ kind: checkoutRestoreGrantKind, root, reason: 'escalation:dirty-checkout (requested by graphyard-doctor)', request: { id: request.id }, loop: { pid: process.pid }, issuedAt: '2026-10-11T00:00:00.000Z', expiresAt: '2026-10-11T00:15:00.000Z', nonce: 'a'.repeat(32), ...overrides });
  /** A grant the loop issued: the payload signed with the installation's coordinator credential. */
  const issued = (overrides: Partial<CheckoutRestoreGrantPayload> = {}, credential = credentialValue): CheckoutRestoreGrant => ({ ...payload(overrides), signature: signCheckoutRestoreGrant(payload(overrides), credential) });
  const env = { [checkoutRestoreGrantVariable]: grantFile };
  let quiesced = 0;
  const serve = (grant: object | null, options: { env?: NodeJS.ProcessEnv; args?: string[]; ancestors?: () => number[]; at?: string } = {}) => {
    const at = options.at ?? grantFile;
    if (grant) writeFileSync(at, JSON.stringify(grant));
    return serveCheckoutRestoreAct(options.args ?? [], { env: options.env ?? (options.at ? { [checkoutRestoreGrantVariable]: at } : env), now, ancestors: options.ancestors, quiesce: () => { quiesced++; return { thaw: () => {} }; } });
  };
  const refused = async (grant: object | null, why: RegExp, options: { env?: NodeJS.ProcessEnv; args?: string[]; ancestors?: () => number[]; at?: string } = {}) => {
    await assert.rejects(serve(grant, options), why);
    assert.equal(quiesced, 0, 'nothing was frozen or touched');
  };
  // No grant in the environment, or a root and reason on the command line (round 1's entry): the usage names the request to file instead.
  await refused(null, /is the loop's own act, run in a snapshot of the serving release under a grant the loop signs with the coordinator credential \(GRAPHYARD_CHECKOUT_RESTORE_GRANT\); it is not a command to run by hand: file master checkout-restore REASON/, { env: {} });
  await refused(null, /takes no arguments: the checkout and the reason are in the loop's grant/, { args: [root, 'reason'] });
  await refused(null, /the checkout-restore grant at .* cannot be read \(ENOENT/);
  // Round 2's self-authenticating grant — a caller-chosen token's digest, no signature — is not a grant this entry reads.
  const { signature: _unsigned, ...bare } = issued();
  await refused({ ...bare, token: 'b'.repeat(64) }, /cannot be read \(/);
  await refused(bare, /cannot be read \(/);
  // The checkout it names: not absolute, no installation, or an installation whose coordinator checkout lies elsewhere.
  await refused(issued({ root: 'coordinator' }), /does not serve: the checkout it names, coordinator, is not an absolute path/);
  mkdirSync(join(base, 'bare'));
  await refused(issued({ root: join(base, 'bare') }), /does not serve: the checkout it names, .*bare, holds no installation whose configuration can be read \(.*master\.json does not exist/);
  const other = join(base, 'other');
  mkdirSync(join(other, '.graphyard'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', other]);
  writeFileSync(join(other, '.graphyard', 'master.json'), readFileSync(join(root, '.graphyard', 'master.json')), { mode: 0o600 });
  await refused(issued({ root: other }), new RegExp(`does not serve: the installation at .*other runs its loop from ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, not from that checkout`));
  // The grant lies in a directory the caller chose, not where the installation's loop issues grants — a forger's own directory
  // holding its own request and cursor beside it serves nothing, whatever it holds.
  mkdirSync(join(base, 'forged'));
  writeFileSync(join(base, 'forged', 'graphyard-master.checkout-restore.json'), readFileSync(file));
  writeFileSync(join(base, 'forged', 'graphyard-master.daemon.json'), JSON.stringify({ lock: { id: 'lock', pid: process.pid, host: 'machine-a' } }));
  await refused(issued(), /does not serve: it lies at .*forged\/graphyard-master\.checkout-restore-grant\.json, not where that installation's loop issues grants \(.*state\/graphyard-master\.checkout-restore-grant\.json\)/, { at: join(base, 'forged', 'graphyard-master.checkout-restore-grant.json') });
  // Forged: signed with a credential that is not the installation's — a process without the coordinator credential can
  // name the real checkout, the real request and a lock its own wrapper holds, and still issue nothing; tampered: a
  // signed grant whose payload was changed after signing.
  await refused(issued({}, 'not-the-coordinator-credential'.padEnd(48, 'x')), /does not serve: its signature is not that installation's coordinator credential's, so no loop issued it/);
  await refused({ ...issued(), reason: 'another reason' }, /its signature is not that installation's coordinator credential's/);
  await refused({ ...issued(), root: `${root}/` }, /its signature is not that installation's coordinator credential's/);
  await refused({ ...issued(), signature: 'f'.repeat(64) }, /its signature is not that installation's coordinator credential's/);
  // Expired.
  await refused(issued({ expiresAt: '2026-10-11T00:05:00.000Z' }), /does not serve: it expired at 2026-10-11T00:05:00.000Z/);
  // Issued by a process that is not an ancestor: a same-user process that wrote a grant and ran the entry itself is refused, and so is a grant naming the loop but run elsewhere.
  await refused(issued({ loop: { pid: 999_999 } }), /does not serve: the loop that issued it, pid 999999, is not an ancestor of this process \(\d+( < \d+)*\)/);
  await refused(issued(), /is not an ancestor of this process/, { ancestors: () => [1] });
  // The grant names one issuing pid, checked against the ancestry and the cursor lock alike: round 3's shape, an issuer beside a separate
  // lock pid — with which a credential holder named its own wrapper as the issuer and the real loop as the lock — is not a grant this entry reads.
  await refused({ ...payload(), loop: { pid: process.pid, lock: 4242 }, signature: signCheckoutRestoreGrant(payload(), credentialValue) }, /cannot be read \(/);
  // The installation's cursor: missing, unreadable or unlocked, no loop is known to serve — refused, never taken as unlocked; locked by a pid other
  // than the issuer — the real loop's, while a credential holder among this process's ancestors signed the grant — refused: only the lock holder issues.
  const cursorWas = readFileSync(cursor);
  execFileSync('rm', ['-f', cursor]);
  await refused(issued(), /does not serve: that installation's cursor at .*graphyard-master\.daemon\.json cannot be read \(ENOENT.*\), so no loop is known to serve it/);
  writeFileSync(cursor, 'not json');
  await refused(issued(), /cursor at .* cannot be read \(.*JSON.*\), so no loop is known to serve it/);
  writeFileSync(cursor, JSON.stringify({ lock: null }));
  await refused(issued(), /does not serve: that installation's cursor at .* holds no lock, so no loop is known to serve it/);
  writeFileSync(cursor, JSON.stringify({ lock: { id: 'lock', pid: 5151, host: 'machine-a' } }));
  await refused(issued(), new RegExp(`does not serve: that installation's cursor at .* is locked by pid 5151, not the loop that issued it, pid ${process.pid}`));
  writeFileSync(cursor, cursorWas);
  // The installation's request: another id, another act, or already answered.
  await refused(issued({ request: { id: 'another' } }), /the request it names, another, no longer stands at .*graphyard-master\.checkout-restore\.json/);
  writeFileSync(file, JSON.stringify({ ...request, act: 'restart' }));
  await refused(issued(), /no longer stands/);
  writeFileSync(file, JSON.stringify({ ...request, outcome: { at: now.toISOString(), state: 'failed', detail: 'earlier', ref: null, commit: null, paths: [], restart: null } }));
  await refused(issued(), /the request it names, .*, was already answered failed/);
  writeFileSync(file, JSON.stringify(request));
  // The installation's credential is not private (a mode other than 0600): the installation does not read, so the grant is refused.
  chmodSync(credentialFile, 0o644);
  try { await refused(issued(), /does not serve: the checkout it names, .*, holds no installation whose configuration can be read \(.*graphyard-master\.token must be a regular file with mode 0600\)/); } finally { chmodSync(credentialFile, 0o600); }
  assert.equal(git('status', '--porcelain'), '');
  assert.ok(existsSync(grantFile), 'no refused grant was consumed before the one that verifies');
  // The grant that verifies serves once: the checkout the grant names is quiesced and judged, the grant is gone before the act, and the same grant cannot serve again.
  const output = await serve(issued());
  assert.deepEqual(output, { restored: null, head });
  assert.equal(quiesced, 1);
  assert.ok(!existsSync(grantFile), 'consumed');
  await assert.rejects(serve(null), /cannot be read \(ENOENT/);
  assert.equal(quiesced, 1);
  // This process's real ancestry, as the entry reads it from /proc: its parent is first.
  const chain = ancestorPids();
  assert.ok(chain.length >= 1 && chain[0] === process.ppid, `ancestors ${chain.join(' < ')}`);
  assert.deepEqual(ancestorPids(join(base, 'no-proc')), [], 'an unreadable /proc yields no ancestors, so no issuer is matched');
});

test('unit:clean-drift-settles-and-restarts — a request that finds no dirty path but a HEAD other than the commit the loop loaded is adopted: the outcome names the HEAD, the guard settles the drift escalation onto it and the restart through the unit is asked; a clean checkout at the loaded commit stays `clean` with neither', async () => {
  const base = await fixtureDirectory('clean-drift-settles');
  const root = join(base, 'coordinator');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 1;\n');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  git('add', '-A'); git('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'loaded');
  const loaded = git('rev-parse', 'HEAD');
  git('checkout', '-q', '--detach');
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 2;\n');
  git('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-am', 'moved');
  const moved = git('rev-parse', 'HEAD');
  const file = join(base, 'state', 'graphyard-master.checkout-restore.json');
  mkdirSync(join(base, 'state'), { recursive: true });

  // The guard, as the loop runs it: started at the loaded commit, then reading the moved HEAD.
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(base, 'state', 'graphyard-master.token'), cliPath: join(root, 'bin', 'graphyard.mjs'),
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  const state = emptyDaemonState(config);
  const journal: string[] = [];
  let clock = Date.parse('2030-01-01T00:00:00Z');
  const guard = coordinatorCheckoutGuard({ state: () => state, read: () => readCoordinatorCheckout(root), agents: async () => [], snapshot: async () => ({ work: [], now: new Date(clock).toISOString() }), persist: async () => {}, now: () => clock, log: line => journal.push(line), applies: () => true });
  git('checkout', '-q', '--detach', loaded);
  assert.equal(await guard.start(loaded), null);
  git('checkout', '-q', '--detach', moved);
  const drift = (await guard.betweenCycles()).refusal;
  assert.ok(drift && drift.includes(`its HEAD moved from ${loaded.slice(0, 12)} to ${moved.slice(0, 12)} while the loop was running`), drift ?? 'no refusal');
  assert.ok(drift.endsWith(`which loads it. ${checkoutRestoreDriftRemedy}`), 'the drift refusal names the remedy the installation runs itself');
  assert.equal(state.actions['escalation:dirty-checkout']?.state, 'failed');
  assert.equal(guard.expected(), loaded);

  // The request, served against the clean moved checkout.
  await fileCheckoutRestoreRequest(file, 'escalation:dirty-checkout', 'graphyard-doctor');
  const settled: (string | null)[] = []; let restarts = 0;
  const deps = { pid: 100, restart: async () => { restarts++; }, settle: async (adopt: string | null) => { settled.push(adopt); await guard.settle({ adopt }); } };
  const outcome = await serveCheckoutRestore(file, root, { ...deps, loaded: () => guard.expected() });
  assert.equal(outcome?.state, 'adopted', outcome?.detail);
  assert.equal(outcome!.commit, moved);
  assert.equal(outcome!.ref, null); assert.deepEqual(outcome!.paths, []);
  assert.equal(outcome!.detail, `the coordinator checkout at ${root} held no dirty path, but its HEAD ${moved.slice(0, 12)} is not ${loaded.slice(0, 12)}, the commit the loop runs; the loop adopts it (GY-1531) and restarts through its supervising unit onto it`);
  assert.deepEqual(settled, [moved]); assert.equal(restarts, 1);
  // The guard adopted the HEAD and settled the escalation before the restart.
  assert.equal(guard.expected(), moved);
  assert.equal(state.actions['escalation:dirty-checkout']?.state, 'done');
  assert.match(state.actions['escalation:dirty-checkout']!.detail, new RegExp(`clean again at ${moved.slice(0, 12)}, the commit the loop runs`));
  assert.ok(journal.some(line => line.includes('escalation done:')));
  const stored = await readCheckoutRestoreRequest(file);
  assert.equal(stored?.outcome?.state, 'adopted');
  assert.equal(stored?.outcome?.restart?.state, 'requested');
  assert.equal(stored?.outcome?.restart?.pid, 100);
  assert.equal(git('rev-parse', 'HEAD'), moved, 'the checkout is left at the HEAD the restart loads');
  assert.equal(git('for-each-ref', checkoutRestoreRefPrefix), '', 'nothing was dirty, so nothing was saved');
  assert.equal((await guard.betweenCycles()).refusal, null, 'no drift stands');

  // At the loaded commit, a clean checkout is clean: no settle, no restart, no adoption.
  await fileCheckoutRestoreRequest(file, 'a second request', 'graphyard-doctor');
  settled.length = 0; restarts = 0;
  const clean = await serveCheckoutRestore(file, root, { ...deps, loaded: () => moved });
  assert.equal(clean?.state, 'clean', clean?.detail);
  assert.equal(clean!.detail, `the coordinator checkout at ${root} held no dirty path and its HEAD ${moved.slice(0, 12)} is the commit the loop runs; nothing was restored and the loop was not restarted`);
  assert.deepEqual(settled, []); assert.equal(restarts, 0);
  assert.equal((await readCheckoutRestoreRequest(file))?.outcome?.restart, null);
  // A dirty checkout settles no adoption, and a HEAD the checkout no longer holds adopts nothing: the guard reports what it finds.
  git('checkout', '-q', '--detach', loaded);
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 3;\n');
  assert.match((await guard.settle({ adopt: loaded })) ?? '', /holds uncommitted work/, 'a dirty checkout is refused');
  assert.equal(guard.expected(), moved, 'nothing adopted');
  git('checkout', '-q', '--', 'src/loop.ts');
  assert.match((await guard.settle({ adopt: moved })) ?? '', new RegExp(`its HEAD moved from ${moved.slice(0, 12)} to ${loaded.slice(0, 12)}`), 'a HEAD the checkout no longer holds adopts nothing: the drift stands');
  assert.equal(guard.expected(), moved);
  assert.equal(await guard.settle({ adopt: loaded }), null);
  assert.equal(guard.expected(), loaded, 'the HEAD the checkout holds is adopted');
  assert.equal(state.actions['escalation:dirty-checkout']?.state, 'done');
});

test('unit:adoption-reverts-when-restart-fails — an adopted HEAD whose restart through the unit cannot be asked (no user bus, no unit) is un-adopted: the guard\'s expectation returns to the commit the loop still runs and the drift escalation is raised again, the failed restart saying so; the next pass adopts and asks again, and when the restart lands the escalation is settled onto the adopted HEAD before it', async () => {
  const base = await fixtureDirectory('adoption-reverts');
  const root = join(base, 'coordinator');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 1;\n');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  git('add', '-A'); git('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'loaded');
  const loaded = git('rev-parse', 'HEAD');
  git('checkout', '-q', '--detach');
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 2;\n');
  git('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-am', 'moved');
  const moved = git('rev-parse', 'HEAD');
  const file = join(base, 'state', 'graphyard-master.checkout-restore.json');
  mkdirSync(join(base, 'state'), { recursive: true });
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(base, 'state', 'graphyard-master.token'), cliPath: join(root, 'bin', 'graphyard.mjs'),
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  const state = emptyDaemonState(config);
  const journal: string[] = [];
  let clock = Date.parse('2030-01-01T00:00:00Z');
  const guard = coordinatorCheckoutGuard({ state: () => state, read: () => readCoordinatorCheckout(root), agents: async () => [], snapshot: async () => ({ work: [], now: new Date(clock).toISOString() }), persist: async () => {}, now: () => clock, log: line => journal.push(line), applies: () => true });
  git('checkout', '-q', '--detach', loaded);
  assert.equal(await guard.start(loaded), null);
  git('checkout', '-q', '--detach', moved);
  assert.ok((await guard.betweenCycles()).refusal?.includes(`its HEAD moved from ${loaded.slice(0, 12)} to ${moved.slice(0, 12)}`));
  assert.equal(state.actions['escalation:dirty-checkout']?.state, 'failed');

  await fileCheckoutRestoreRequest(file, 'escalation:dirty-checkout', 'graphyard-doctor');
  const settled: (string | null)[] = [], unadopted: string[] = [], asked: string[] = [];
  let restartFails = true;
  const deps = { pid: 100, loaded: () => guard.expected(),
    restart: async () => { asked.push(guard.expected() ?? ''); if (restartFails) throw new Error('Failed to connect to bus: No medium found'); },
    settle: async (adopt: string | null) => { settled.push(adopt); await guard.settle({ adopt }); },
    unadopt: async (previous: string) => { unadopted.push(previous); await guard.settle({ revert: previous }); } };
  // The restart cannot be asked: the adoption, made just before the ask, is reverted and the drift stands.
  const outcome = await serveCheckoutRestore(file, root, deps);
  assert.equal(outcome?.state, 'adopted', outcome?.detail); assert.equal(outcome!.commit, moved);
  assert.deepEqual(settled, [moved], 'adopted before the ask'); assert.deepEqual(asked, [moved], 'the restart was asked with the HEAD adopted');
  assert.deepEqual(unadopted, [loaded], 'reverted to the commit the loop runs when the ask failed');
  assert.equal(guard.expected(), loaded);
  assert.equal(state.actions['escalation:dirty-checkout']?.state, 'failed', 'the drift escalation stands again');
  assert.match(state.actions['escalation:dirty-checkout']!.detail, new RegExp(`its HEAD moved from ${loaded.slice(0, 12)} to ${moved.slice(0, 12)} while the loop was running`));
  assert.equal(outcome!.restart?.state, 'failed');
  assert.match(outcome!.restart!.detail, /No medium found; the adoption of \w{12} is reverted and the drift escalation stands until a restart lands$/);
  const done = journal.findIndex(line => line.includes('escalation done:')), raised = journal.findIndex((line, index) => index > done && line.includes('escalation failed:'));
  assert.ok(done >= 0 && raised > done, `settled then raised again: ${journal.join('\n')}`);
  assert.ok((await guard.betweenCycles()).refusal, 'the next cycle still reports the drift');
  // The next pass: adopted again, asked again, and this time the restart lands with the escalation settled onto the HEAD before it.
  restartFails = false; settled.length = 0; unadopted.length = 0; asked.length = 0;
  const retried = await serveCheckoutRestore(file, root, deps);
  assert.equal(retried?.state, 'adopted'); assert.equal(retried!.restart?.state, 'requested'); assert.equal(retried!.restart?.pid, 100);
  assert.deepEqual(settled, [moved]); assert.deepEqual(asked, [moved]); assert.deepEqual(unadopted, []);
  assert.equal(guard.expected(), moved);
  assert.equal(state.actions['escalation:dirty-checkout']?.state, 'done');
  assert.equal((await readCheckoutRestoreRequest(file))?.outcome?.restart?.state, 'requested');
  assert.equal((await guard.betweenCycles()).refusal, null);
  // Review of GY-1680: the owed restart's record failing (the state directory unwritable) reverts the
  // adoption before the failure is raised, and no restart is asked — the loop still runs the old commit,
  // and the drift escalation must explain it.
  if (process.getuid?.() === 0) return;
  git('checkout', '-q', '--detach', loaded); await guard.settle({ revert: loaded }); git('checkout', '-q', '--detach', moved);
  assert.ok((await guard.betweenCycles()).refusal, 'the drift stands again for the next request');
  await fileCheckoutRestoreRequest(file, 'escalation:dirty-checkout again', 'graphyard-doctor');
  settled.length = 0; unadopted.length = 0; asked.length = 0;
  chmodSync(join(base, 'state'), 0o500);
  try {
    await assert.rejects(serveCheckoutRestore(file, root, deps), /the restart could not be recorded at .*checkout-restore\.json, so it was not asked: .*EACCES.*; the adoption of \w{12} is reverted and the drift escalation stands until a restart lands/s);
  } finally { chmodSync(join(base, 'state'), 0o700); }
  assert.deepEqual(settled, [moved], 'adopted before the record'); assert.deepEqual(unadopted, [loaded], 'reverted when the record failed'); assert.deepEqual(asked, [], 'no restart was asked');
  assert.equal(guard.expected(), loaded);
  assert.equal(state.actions['escalation:dirty-checkout']?.state, 'failed', 'the drift escalation stands');
  assert.equal((await readCheckoutRestoreRequest(file))?.outcome, null, 'the request stands unanswered for the next pass');
});

/**
 * The loop every release before the serve path runs, as c531a1d7 (this item's base) serves requests:
 * the request files parsed by GY-1658's strict schema — a field it does not know is a request it
 * cannot read, and `readCheckoutRestoreRequest` leaves it standing — the checkout-restore served by
 * its own loaded code, then the loop-restart request, written `requested` against its pid before its
 * unit is asked to restart it. The checkout-restore it would serve is a failure of the test: that is
 * the stale code the handoff exists to keep from the request.
 */
const baseRequestSchema = z.object({
  id: z.string().max(100), act: z.enum(['checkout-restore', 'restart', 'executors']).default('checkout-restore'), reason: z.string().min(1).max(2000), requestedAt: z.string(), requestedBy: z.string().max(200),
  args: z.array(z.string().max(200)).max(20).default([]), outcome: z.unknown().nullable(),
}).strict();
async function baseLoopPass(config: { credentialFile: string }, pid: number, restart: () => Promise<void>, log: string[]) {
  const read = (file: string) => { try { return baseRequestSchema.parse(JSON.parse(readFileSync(file, 'utf8'))); } catch { return null; } };
  const restore = read(checkoutRestoreRequestPath(config));
  if (restore && !restore.outcome) { log.push(`served checkout-restore ${restore.id} from the stale loop's own code`); return; }
  if (existsSync(checkoutRestoreRequestPath(config))) log.push(`checkout-restore request left standing: ${restore ? 'answered' : 'unreadable to this release'}`);
  const owed = read(loopRestartRequestPath(config));
  if (!owed || owed.outcome) return;
  const asked = { at: new Date().toISOString(), state: 'restart', ref: null, commit: null, paths: [], detail: `the loop restarts through its supervising unit, as ${owed.requestedBy} asked: ${owed.reason}`, restart: { state: 'requested', pid, at: new Date().toISOString(), detail: 'the loop asked its supervising unit to restart it' } };
  await atomicPrivateWrite(loopRestartRequestPath(config), { ...owed, outcome: asked });
  log.push(`loop-restart ${owed.id} requested by pid ${pid}`);
  try { await restart(); }
  catch (error) { await atomicPrivateWrite(loopRestartRequestPath(config), { ...owed, outcome: { ...asked, restart: { state: 'failed', pid, at: new Date().toISOString(), detail: `the restart failed and is asked again on the loop's next pass: ${error instanceof Error ? error.message : String(error)}` } } }); log.push('restart failed'); }
}

test('integration:checkout-restore-stale-loop-handoff — a checkout-restore filed while the running loop\'s loaded code predates the serve path is handed off end to end: the command reads the loop\'s loaded commit from its cursor, files the request in a form that loop leaves standing and a loop-restart request beside it, the stale loop serves the restart through its unit without touching the request, and the loop that loads the checkout\'s HEAD serves the standing request from the verified serving release\'s snapshot — the unreadable-cwd daemon skipped, every dirty path saved, the escalation settled, the restart asked; a loop already holding the serve path is not handed off, and a stale loop whose restart fails fails the command with the request left standing', { timeout: 120_000 }, async () => {
  // The checkout: `before` (no serve path; its own bin refuses) then `release`, the verified serving release whose CLI is
  // the fixture entry; HEAD moved to `release` under a loop that loaded `before` — the standing installation's case.
  const base = await fixtureDirectory('checkout-restore-stale-loop-handoff');
  const root = join(base, 'coordinator');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  mkdirSync(join(root, 'src', 'cli'), { recursive: true }); mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 1;\n');
  writeFileSync(join(root, 'bin', 'graphyard.mjs'), loadedEntry);
  writeFileSync(join(root, '.gitignore'), '.graphyard/\nnode_modules/\n');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  git('add', '-A'); git('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'before the serve path');
  const before = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'bin', 'graphyard.mjs'), releaseEntry);
  writeFileSync(join(root, 'src', 'cli', 'checkout-restore-release.ts'), serveMarker);
  git('add', '-A'); git('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'the serving release');
  const release = git('rev-parse', 'HEAD');
  git('checkout', '-q', '--detach');
  const proc = join(base, 'proc'), record = join(base, 'serve-record.json');
  const checkout = realpathSync(root), elsewhere = realpathSync(base);
  processEntry(proc, 1, { cwd: '/' });
  processEntry(proc, 100, { cwd: elsewhere });   // the stale loop
  processEntry(proc, 500, { cwd: checkout });    // a standing writer
  processEntry(proc, 1372, { cwd: checkout });   // sd-pam: non-dumpable, its cwd read refused EACCES
  const { config, credentialFile, cursor, file, grantFile } = installation(root, join(base, 'state'));
  const restartFile = loopRestartRequestPath(config);
  const env = { GRAPHYARD_TEST_FAKE_PROC: proc, GRAPHYARD_TEST_SERVE_RECORD: record, GRAPHYARD_TEST_DENY_PATHS: join(proc, '1372', 'cwd') };
  assert.equal(await commitServes(root, before), false); assert.equal(await commitServes(root, release), true); assert.equal(await commitServes(root, 'f'.repeat(40)), false);

  // The cursor: the stale loop (pid 100) holds the lock and recorded loading `before`. The command judges that loop stale;
  // one that loaded the release, or recorded no lock, is not handed off; one that recorded no loaded commit is.
  // HEAD is at `release` (headServes), so a restart onto HEAD can serve — the standing moved-HEAD case.
  const stale = { lock: { id: 'lock', pid: 100, host: 'machine-a' }, release: { commit: before, dirty: false }, deployment: { source: 'endpoint', sha: release, at: new Date().toISOString(), reason: null, deployed: [], pending: [] } };
  writeFileSync(cursor, JSON.stringify(stale));
  assert.deepEqual(await lockedLoop(cursor), { pid: 100, loaded: before });
  assert.deepEqual(await staleServingLoop(cursor, root), { pid: 100, loaded: before, head: release, headServes: true });
  assert.deepEqual(await staleServingLoop(cursor, null), { pid: 100, loaded: before, head: null, headServes: false }, 'a loop whose loaded code cannot be judged against a checkout is not known to serve from the release');
  writeFileSync(cursor, JSON.stringify({ ...stale, release: { commit: release, dirty: false } }));
  assert.equal(await staleServingLoop(cursor, root), null, 'a loop that loaded the serving release serves from it');
  writeFileSync(cursor, JSON.stringify({ ...stale, release: null }));
  assert.deepEqual(await staleServingLoop(cursor, root), { pid: 100, loaded: null, head: release, headServes: true }, 'a loop that recorded no loaded commit is not known to serve from the release');
  writeFileSync(cursor, JSON.stringify({ lock: null, release: { commit: before, dirty: false } }));
  assert.equal(await staleServingLoop(cursor, root), null, 'no loop holds the lock: nothing to hand off');
  assert.equal(await staleServingLoop(join(base, 'no-cursor.json'), root), null);

  // The dirty checkout under the stale loop; the doctor files the request through the command (the checkout's CLI, this release).
  writeFileSync(cursor, JSON.stringify(stale));
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 2; // hotfix\n');
  writeFileSync(join(root, 'scratchpad.mjs'), '// scratch\n');
  const baseLog: string[] = [], newLog: string[] = [];
  const settled: (string | null)[] = []; let newRestarts = 0, unitRestarts = 0;
  const restoreEnv = withEnv(env);
  let result: Awaited<ReturnType<typeof checkoutRestoreCommand>>;
  try {
    const command = checkoutRestoreCommand(config, ['escalation:dirty-checkout', 'standing'], 'graphyard-doctor', { waitMs: 60_000, pollMs: 20 });
    // The host: the stale loop's pass once both files stand; its unit restarts it onto HEAD — the loop of this release, this process.
    while (!existsSync(restartFile)) await delay(10);
    await baseLoopPass(config, 100, async () => {
      unitRestarts++;
      // The restarted loop: the lock passes to it, and it recorded loading the checkout's HEAD, the serving release.
      writeFileSync(cursor, JSON.stringify({ lock: { id: 'lock-2', pid: process.pid, host: 'machine-a' }, release: { commit: release, dirty: false } }));
      const deps = { pid: process.pid, restart: async () => { newRestarts++; }, settle: async (adopt: string | null) => { settled.push(adopt); }, loaded: () => release,
        report: (outcome: { state: string; detail: string }) => newLog.push(`${outcome.state}: ${outcome.detail}`),
        restore: releasePinnedRestore({ release: () => ({ deployment: { source: 'endpoint', sha: release }, baseBranch: 'main' }), grant: { file: grantFile, credentialFile, pid: process.pid } }) };
      // Its pass, as serveLoopRequests orders it: the checkout-restore request, then the loop-restart request, which it finds owed by another pid.
      const served = await serveCheckoutRestore(file, root, deps);
      await serveCheckoutRestore(restartFile, root, served?.restart?.state === 'requested' ? { ...deps, restart: async () => {} } : deps);
    }, baseLog);
    result = await command;
  } finally { restoreEnv(); }
  // The stale loop never read the request — this release's `handoff` field is unknown to its strict schema — and served the restart.
  assert.deepEqual(baseLog, ['checkout-restore request left standing: unreadable to this release', `loop-restart ${result!.handoff!.restart} requested by pid 100`]);
  assert.equal(unitRestarts, 1);
  // The command's outcome: restored by the restarted loop from the verified serving release's snapshot, the handoff named.
  assert.equal(result!.state, 'restored', result!.detail);
  assert.deepEqual(Object.keys(result!.handoff!).sort(), ['detail', 'loaded', 'pid', 'restart']);
  assert.equal(result!.handoff!.pid, 100); assert.equal(result!.handoff!.loaded, before);
  assert.match(result!.handoff!.detail, new RegExp(`^the loop \\(pid 100\\) runs ${before.slice(0, 12)}, from before the serve path, so loop-restart request ${result!.handoff!.restart} was filed at .*graphyard-master\\.loop-restart\\.json: it restarts through its unit onto the checkout's HEAD, and the loop that loads it serves this request from the serving release$`));
  assert.match(result!.detail!, new RegExp(`2 dirty path\\(s\\) saved under refs/graphyard/checkout-restore/.*; the loop restarts through its supervising unit; skipped, their cwd unreadable: pid 1372 \\(EACCES.*; served from the verified serving release ${release.slice(0, 12)}, a detached shared-clone snapshot of it; handed off by loop-restart request ${result!.handoff!.restart} from the loop that ran ${before.slice(0, 12)}, from before the serve path$`));
  const stored = await readCheckoutRestoreRequest(file);
  assert.deepEqual(stored?.handoff, { loaded: before, restart: result!.handoff!.restart }, 'the request carries the handoff');
  assert.equal(stored?.outcome?.state, 'restored'); assert.equal(stored?.outcome?.restart?.pid, process.pid);
  assert.equal(stored?.requestedBy, 'graphyard-doctor'); assert.equal(stored?.reason, 'escalation:dirty-checkout standing');
  const owed = await readCheckoutRestoreRequest(restartFile);
  assert.equal(owed?.id, result!.handoff!.restart); assert.equal(owed?.act, 'restart'); assert.equal(owed?.requestedBy, 'graphyard-doctor');
  assert.match(owed!.reason, new RegExp(`^GY-1680 handoff for checkout-restore: the loop \\(pid 100\\) runs ${before.slice(0, 12)}, from before the serve path`));
  assert.equal(owed?.outcome?.restart?.state, 'done', 'the restarted loop recorded the stale loop\'s restart done');
  assert.equal(owed?.outcome?.restart?.pid, 100); assert.equal(owed?.outcome?.restart?.detail, `the loop restarted: pid ${process.pid} serves the checkout after pid 100 asked for the restart`);
  assert.equal(newLog.filter(line => line.startsWith('restored:')).length, 1);
  // The act ran in the release snapshot under this loop's grant: GY-1672's skip applied, the writer stopped and continued, the checkout clean at HEAD.
  const served = serveRecord(record);
  assert.equal(served.snapshotHead, release); assert.equal(served.grant.consumed, true); assert.deepEqual(served.grant.content!.loop, { pid: process.pid });
  assert.deepEqual(served.sent, ['SIGSTOP:500', 'SIGCONT:500']);
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), ''); assert.equal(git('rev-parse', 'HEAD'), release);
  assert.equal(git('show', `${stored!.outcome!.ref}:src/loop.ts`), 'export const loop = 2; // hotfix');
  assert.deepEqual(settled, [null]); assert.equal(newRestarts, 1);
  assert.ok(!readFileSync(record, 'utf8').includes('own tree served'), 'the checkout\'s own entry never ran');

  // A loop already holding the serve path is not handed off: the request is filed as it stands, no restart request beside it.
  execFileSync('rm', ['-f', restartFile]);
  const current = await checkoutRestoreCommand(config, ['a second request'], 'graphyard-doctor', { waitMs: 60, pollMs: 10 });
  assert.equal(current.state, 'requested'); assert.equal('handoff' in current, false);
  assert.ok(!existsSync(restartFile), 'no restart request was filed');
  const plain = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal('handoff' in plain, false, 'a request without a handoff carries no such field, so every release since GY-1658 reads it');
  assert.equal(plain.id, current.request);
  // A stale loop that cannot restart through a unit: the command fails naming it, exits non-zero, and the request stands for the loop that next starts.
  writeFileSync(cursor, JSON.stringify(stale));
  const failing = checkoutRestoreCommand(config, ['a third request'], 'graphyard-doctor', { waitMs: 60_000, pollMs: 20 });
  while (!existsSync(restartFile)) await delay(10);
  const failLog: string[] = [];
  await baseLoopPass(config, 100, async () => { throw new Error('this loop runs under no graphyard-master supervisor unit, so it cannot restart itself through one'); }, failLog);
  const failed = await failing;
  assert.equal(failed.state, 'failed');
  assert.match(failed.detail!, /^the handoff failed: the restart failed and is asked again on the loop's next pass: this loop runs under no graphyard-master supervisor unit, so it cannot restart itself through one; the request stands at .*graphyard-master\.checkout-restore\.json for the loop that next starts, which serves it from the serving release$/);
  assert.equal(process.exitCode, 1); process.exitCode = 0;
  assert.deepEqual(failLog, ['checkout-restore request left standing: unreadable to this release', `loop-restart ${failed.handoff!.restart} requested by pid 100`, 'restart failed']);
  const standing = await readCheckoutRestoreRequest(file);
  assert.equal(standing?.id, failed.request); assert.equal(standing?.outcome, null, 'the request stands unanswered');
  assert.deepEqual(standing?.handoff, { loaded: before, restart: failed.handoff!.restart });
});

test('integration:checkout-restore-stale-loop-old-head-handoff — a dirty checkout whose HEAD still predates the serve entry is handed off end to end: the command serves from the verified serving release\'s snapshot under a handoff grant (the stale loop still holds the cursor) whose entry advances the checkout onto that release while a live writer still stands frozen (review of GY-1680: the writer is continued only once HEAD is the release and the checkout clean), and files a loop-restart the stale loop serves so the unit loads it — a restart onto the old HEAD alone would leave the request unread', { timeout: 120_000 }, async () => {
  const base = await fixtureDirectory('checkout-restore-stale-loop-old-head');
  const root = join(base, 'coordinator');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  mkdirSync(join(root, 'src', 'cli'), { recursive: true }); mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 1;\n');
  writeFileSync(join(root, 'bin', 'graphyard.mjs'), loadedEntry);
  writeFileSync(join(root, '.gitignore'), '.graphyard/\nnode_modules/\n');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  git('add', '-A'); git('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'before the serve path');
  const before = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'bin', 'graphyard.mjs'), releaseEntry);
  writeFileSync(join(root, 'src', 'cli', 'checkout-restore-release.ts'), serveMarker);
  git('add', '-A'); git('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'the serving release');
  const release = git('rev-parse', 'HEAD');
  // HEAD stays at `before`: the dirty old-HEAD installation the review names.
  git('checkout', '-q', '--detach', before);
  const proc = join(base, 'proc'), record = join(base, 'serve-record.json');
  const checkout = realpathSync(root), elsewhere = realpathSync(base);
  processEntry(proc, 1, { cwd: '/' });
  processEntry(proc, 100, { cwd: elsewhere });
  processEntry(proc, 500, { cwd: checkout });
  processEntry(proc, 1372, { cwd: checkout });
  const { config, credentialFile, cursor, file, grantFile } = installation(root, join(base, 'state'));
  const restartFile = loopRestartRequestPath(config);
  const env = { GRAPHYARD_TEST_FAKE_PROC: proc, GRAPHYARD_TEST_SERVE_RECORD: record, GRAPHYARD_TEST_DENY_PATHS: join(proc, '1372', 'cwd') };
  assert.equal(await commitServes(root, before), false); assert.equal(await commitServes(root, release), true);
  const stale = { lock: { id: 'lock', pid: 100, host: 'machine-a' }, release: { commit: before, dirty: false }, deployment: { source: 'endpoint', sha: release } };
  writeFileSync(cursor, JSON.stringify(stale));
  assert.deepEqual(await staleServingLoop(cursor, root), { pid: 100, loaded: before, head: before, headServes: false });
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 2; // hotfix\n');
  writeFileSync(join(root, 'scratchpad.mjs'), '// scratch\n');
  const baseLog: string[] = []; let unitRestarts = 0;
  const restoreEnv = withEnv(env);
  let result: Awaited<ReturnType<typeof checkoutRestoreCommand>>;
  try {
    const command = checkoutRestoreCommand(config, ['escalation:dirty-checkout', 'old-HEAD'], 'graphyard-doctor', {
      waitMs: 60_000, pollMs: 20,
      release: () => ({ deployment: { source: 'endpoint', sha: release }, baseBranch: 'main' }),
    });
    while (!existsSync(restartFile)) await delay(10);
    // The command has already restored and advanced HEAD onto the release; the stale loop only serves the restart.
    assert.equal(git('rev-parse', 'HEAD'), release, 'the command advanced the checkout onto the serving release before filing the restart');
    assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'the checkout is clean at the serving release');
    await baseLoopPass(config, 100, async () => {
      unitRestarts++;
      writeFileSync(cursor, JSON.stringify({ lock: { id: 'lock-2', pid: process.pid, host: 'machine-a' }, release: { commit: release, dirty: false } }));
    }, baseLog);
    result = await command;
  } finally { restoreEnv(); }
  assert.deepEqual(baseLog, ['checkout-restore request left standing: unreadable to this release', `loop-restart ${result!.handoff!.restart} requested by pid 100`]);
  assert.equal(unitRestarts, 1);
  assert.equal(result!.state, 'restored', result!.detail);
  assert.equal(result!.handoff!.pid, 100); assert.equal(result!.handoff!.loaded, before);
  assert.match(result!.handoff!.detail, new RegExp(`HEAD ${before.slice(0, 12)} predates the serve entry`));
  assert.match(result!.detail!, new RegExp(`2 dirty path\\(s\\) saved under refs/graphyard/checkout-restore/.*onto the verified serving release.*served from the verified serving release ${release.slice(0, 12)}.*HEAD ${before.slice(0, 12)} predating the serve entry`));
  const stored = await readCheckoutRestoreRequest(file);
  assert.equal(stored?.outcome?.state, 'restored');
  assert.deepEqual(stored?.handoff, { loaded: before, restart: result!.handoff!.restart });
  const served = serveRecord(record);
  assert.equal(served.snapshotHead, release); assert.equal(served.grant.consumed, true);
  assert.deepEqual(served.grant.content!.handoff, { head: before, advance: release }, 'the grant names the old HEAD and the release the entry advances onto');
  assert.deepEqual(served.grant.content!.loop, { pid: process.pid }, 'the command issued the grant, not the stale loop');
  // The live writer (pid 500, its cwd the checkout) was stopped before the restore and continued only after the
  // HEAD advance: at the thaw — before its SIGCONT — the checkout already stood clean at the release (review of GY-1680).
  assert.deepEqual(served.sent, ['SIGSTOP:500', 'SIGCONT:500']);
  assert.equal(served.headAtThaw, release, 'HEAD was advanced onto the release while the writer still stood frozen');
  assert.equal(served.statusAtThaw, '', 'the checkout was clean at the release before the writer was continued');
  assert.ok(served.frozenAt! <= served.thawedAt!, 'the freeze preceded the thaw');
  assert.equal(git('rev-parse', 'HEAD'), release);
  assert.equal(git('show', `${stored!.outcome!.ref}:src/loop.ts`), 'export const loop = 2; // hotfix');
  assert.ok(!readFileSync(record, 'utf8').includes('own tree served'), 'the checkout\'s own entry never ran');
  // A forged handoff grant is refused once HEAD already holds the serve entry (or no longer matches the named head).
  const forged = checkoutRestoreGrantPath(config);
  const payload = { kind: checkoutRestoreGrantKind, root, reason: 'forge', request: { id: 'x' }, loop: { pid: process.pid }, handoff: { head: before, advance: release }, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), nonce: 'a'.repeat(32) } as const;
  await atomicPrivateWrite(forged, { ...payload, signature: signCheckoutRestoreGrant(payload, credentialValue) });
  await assert.rejects(serveCheckoutRestoreAct([], { env: { [checkoutRestoreGrantVariable]: forged }, ancestors: () => [process.pid] }), /already holds the serve entry|old-HEAD handoff does not apply|HEAD is/);
});

test('unit:old-head-handoff-timeout-thaws-frozen-writers — the command\'s old-HEAD handoff serves with the installation\'s freeze ledger as the loop-served path does (review of GY-1680): an entry the act\'s timeout ends after it stopped the checkout\'s writers never reaches its own thaw, so the command continues every writer the ledger still names stopped, leaves alone the ones gone or running, removes the ledger, records the failure naming what it continued and files no restart; the checkout stands dirty at the old HEAD', { timeout: 60_000 }, async () => {
  const base = await fixtureDirectory('checkout-restore-old-head-timeout-thaw');
  const root = join(base, 'coordinator');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  mkdirSync(join(root, 'src', 'cli'), { recursive: true }); mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 1;\n');
  writeFileSync(join(root, 'bin', 'graphyard.mjs'), loadedEntry);
  writeFileSync(join(root, '.gitignore'), '.graphyard/\nnode_modules/\n');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  git('add', '-A'); git('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'before the serve path');
  const before = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'src', 'cli', 'checkout-restore-release.ts'), serveMarker);
  git('add', '-A'); git('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'the serving release');
  const release = git('rev-parse', 'HEAD');
  git('checkout', '-q', '--detach', before);
  const { config, credentialFile, cursor, file, grantFile } = installation(root, join(base, 'state'));
  const restartFile = loopRestartRequestPath(config), ledger = checkoutRestoreFreezeLedgerPath({ credentialFile }), record = join(base, 'hang-record.json');
  writeFileSync(cursor, JSON.stringify({ lock: { id: 'lock', pid: 100, host: 'machine-a' }, release: { commit: before, dirty: false }, deployment: { source: 'endpoint', sha: release } }));
  assert.deepEqual(await staleServingLoop(cursor, root), { pid: 100, loaded: before, head: before, headServes: false });
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 2; // hotfix\n');
  // The command's view of the writers once the entry is gone: 4242 still stopped by it, 4343 running again, 4444 gone.
  const states: Record<number, string | null> = { 4242: 'T', 4343: 'S', 4444: null };
  const continued: string[] = [];
  const restoreEnv = withEnv({ GRAPHYARD_TEST_FREEZE_LEDGER: ledger, GRAPHYARD_TEST_SERVE_RECORD: record, GRAPHYARD_TEST_HANG_WRITERS: '4242,4343,4444', GRAPHYARD_TEST_HANG_ROOT: root });
  let result: Awaited<ReturnType<typeof checkoutRestoreCommand>>;
  try {
    result = await checkoutRestoreCommand(config, ['escalation:dirty-checkout', 'old-HEAD timeout'], 'graphyard-doctor', {
      waitMs: 10_000, pollMs: 20,
      release: () => ({ deployment: { source: 'endpoint', sha: release }, baseBranch: 'main' }),
      serve: { timeoutMs: 1_500, command: () => ({ command: process.execPath, args: ['--import', tsx, hangHelper] }), ledger: { signal: (pid, name) => { continued.push(`${name}:${pid}`); }, state: pid => states[pid] ?? null } },
    });
  } finally { restoreEnv(); }
  assert.equal(process.exitCode, 1); process.exitCode = 0;
  assert.equal(result!.state, 'failed', result!.detail);
  assert.match(result!.detail!, /served from the verified serving release .* did not finish within 1500ms and was killed.*; the entry ended before its own thaw, so the loop continued the writer\(s\) it had stopped, pid 4242 \(pid 4343, 4444 no longer stopped, left alone\)/s);
  assert.deepEqual(continued, ['SIGCONT:4242'], 'only the writer still stopped is continued');
  assert.ok(!existsSync(ledger), 'the ledger is removed once read');
  assert.ok(!existsSync(grantFile), 'the handoff grant is removed');
  assert.ok(!existsSync(restartFile), 'no restart is filed for a serve that failed');
  // The entry wrote the installation's ledger — the path the loop-served entry writes — before it stopped anything.
  const hang = JSON.parse(readFileSync(record, 'utf8')) as { pid: number; sent: string[]; ledger: { kind: string; root: string; pid: number; stopped: number[] } };
  assert.deepEqual(hang.sent, ['SIGSTOP:4242', 'SIGSTOP:4343', 'SIGSTOP:4444'], 'the entry stopped its writers and was ended before any SIGCONT');
  assert.equal(hang.ledger.kind, frozenWritersLedgerKind); assert.equal(hang.ledger.root, root); assert.equal(hang.ledger.pid, hang.pid);
  assert.deepEqual(hang.ledger.stopped, [4242, 4343, 4444]);
  // Nothing was restored or advanced: the dirty path stands at the old HEAD for the next request, the failure recorded with the handoff.
  assert.equal(git('rev-parse', 'HEAD'), before, 'HEAD was not advanced');
  assert.equal(readFileSync(join(root, 'src', 'loop.ts'), 'utf8'), 'export const loop = 2; // hotfix\n');
  const stored = await readCheckoutRestoreRequest(file);
  assert.equal(stored?.outcome?.state, 'failed'); assert.equal(stored?.outcome?.restart, null);
  assert.deepEqual(stored?.handoff, { loaded: before, restart: result!.handoff!.restart });
  assert.equal(result!.handoff!.pid, 100);
  // A handoff grant whose release to advance onto does not hold the serve entry is refused before anything is
  // touched (review of GY-1680): a restart onto it could not serve, so the entry never freezes or moves HEAD for it.
  const standing = await fileCheckoutRestoreRequest(file, 'escalation:dirty-checkout again', 'graphyard-doctor');
  const payload = { kind: checkoutRestoreGrantKind, root, reason: 'advance onto a pre-serve commit', request: { id: standing.id }, loop: { pid: process.pid }, handoff: { head: before, advance: before }, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), nonce: 'b'.repeat(32) } as const;
  await atomicPrivateWrite(grantFile, { ...payload, signature: signCheckoutRestoreGrant(payload, credentialValue) });
  let quiesced = 0;
  await assert.rejects(serveCheckoutRestoreAct([], { env: { [checkoutRestoreGrantVariable]: grantFile }, ancestors: () => [process.pid], quiesce: () => { quiesced++; return { thaw: () => {} }; } }), new RegExp(`the release ${before.slice(0, 12)} the old-HEAD handoff advances onto does not hold the serve entry in the checkout's object store, so a restart onto it could not serve; nothing was restored`));
  assert.equal(quiesced, 0, 'nothing was frozen for a refused grant');
  assert.equal(git('rev-parse', 'HEAD'), before); assert.equal(readFileSync(join(root, 'src', 'loop.ts'), 'utf8'), 'export const loop = 2; // hotfix\n');
});

test('unit:old-head-handoff-advances-under-freeze — the restore act moves the checkout onto the handoff\'s release while the writers it froze still stand frozen (review of GY-1680): the thaw finds HEAD already at the release, dirty or clean; an advance that cannot land after a restore throws naming the ref the paths were saved under, with HEAD unmoved and the writers continued', { timeout: 60_000 }, async () => {
  const base = await fixtureDirectory('checkout-restore-advance-under-freeze');
  const root = join(base, 'coordinator');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 1;\n');
  writeFileSync(join(root, '.gitignore'), '.graphyard/\nnode_modules/\n');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  git('add', '-A'); git('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'before the serve path');
  const before = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'src', 'serve.ts'), 'export const serve = 1;\n');
  git('add', '-A'); git('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'the serving release');
  const release = git('rev-parse', 'HEAD');
  git('checkout', '-q', '--detach', before);
  // The freeze as the act sees it: what the checkout looked like at the moment the writers were about to be continued.
  const thaws: { head: string; status: string }[] = []; let frozen = 0;
  const quiesce = () => { frozen++; return { thaw: () => { thaws.push({ head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain', '--untracked-files=all') }); }, skipped: [] }; };
  const request = { file: join(base, 'request.json'), id: 'r1' };
  // Dirty at the old HEAD: saved, returned to HEAD, then advanced — all before the thaw.
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 2; // hotfix\n');
  const dirty = await restoreInProcess(defaultChildRun, quiesce, release)(root, 'advance test', new Date(), request);
  assert.equal(frozen, 1); assert.deepEqual(thaws, [{ head: release, status: '' }], 'the thaw found the checkout clean at the release');
  assert.equal(dirty.head, release); assert.equal(dirty.restored?.paths.join(), 'src/loop.ts');
  assert.equal(git('show', `${dirty.restored!.ref}:src/loop.ts`), 'export const loop = 2; // hotfix');
  assert.equal(readFileSync(join(root, 'src', 'serve.ts'), 'utf8'), 'export const serve = 1;\n', 'the release\'s tree is checked out');
  // Clean at the old HEAD: nothing restored, still advanced under the freeze.
  git('checkout', '-q', '--detach', before); thaws.length = 0;
  const clean = await restoreInProcess(defaultChildRun, quiesce, release)(root, 'advance test', new Date(), request);
  assert.equal(frozen, 2); assert.deepEqual(thaws, [{ head: release, status: '' }]);
  assert.equal(clean.restored, null); assert.equal(clean.head, release);
  // Without an advance (every loop-served request), HEAD is left where it stood.
  git('checkout', '-q', '--detach', before); thaws.length = 0;
  const plain = await restoreInProcess(defaultChildRun, quiesce)(root, 'no advance', new Date(), request);
  assert.deepEqual(thaws, [{ head: before, status: '' }]); assert.equal(plain.head, before);
  // An advance that cannot land after a restore: the ref is named, HEAD stands, the writers are continued.
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 3; // hotfix\n'); thaws.length = 0;
  await assert.rejects(restoreInProcess(defaultChildRun, quiesce, 'f'.repeat(40))(root, 'advance test', new Date(), request), new RegExp(`1 dirty path\\(s\\) were saved under ${checkoutRestoreRefPrefix}\\S+ \\([0-9a-f]{12}\\) and returned to HEAD, but the coordinator checkout at .* could not be advanced onto ${'f'.repeat(12)} while its writers stood frozen \\(`));
  assert.equal(thaws.length, 1, 'the writers were continued'); assert.equal(thaws[0].head, before); assert.equal(thaws[0].status, '', 'the restore itself landed');
  assert.equal(git('rev-parse', 'HEAD'), before);
});
