import { test } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { checkoutRestoreGrantKind, checkoutRestoreGrantVariable, signCheckoutRestoreGrant, type CheckoutRestoreGrant } from '../src/cli/checkout-restore-release.js';
import { emptyDaemonState, runDaemon, writeDaemonState, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { dirtyCheckoutPaths, readCoordinatorCheckout } from '../src/master/profiles.js';
import { checkoutRestoreGrantPath, checkoutRestoreRefPrefix, checkoutRestoreRequestPath, loopRestartRequestPath, readCheckoutRestoreRequest } from '../src/cli/master-checkout-restore.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Time-bomb allowance (GY-1694): the 2030-01-01 simulated clock is the loop's injected now and every request/journal instant derives from it; Date.now() only stamps watchdog notifications compared with each other for gaps.
/**
 * GY-1658 under the real loop for two simulated days. The loop serves the host acts a confined
 * master identity requests — `master checkout-restore`, and the confined master's `master restart`
 * — on every pass, the refused startup's and every cycle's alike. Each request must be carried out
 * once, its escalation settled, every dirty path preserved (untracked scratch too), its restart asked
 * until one lands (the first ask here fails), and
 * the restarted loops must stay settled: no request re-served, no restart asked again, no further
 * failed dirty-checkout attempt, for the rest of the days. Since GY-1680 the loop serves each
 * checkout-restore from a snapshot of the serving release — here origin's base-branch tip, whose CLI
 * is the fixture release entry starting tests/helpers/checkout-restore-serve-child.ts — under a
 * single-use grant signed with the coordinator credential, never from its own loaded code, feeding
 * its supervisor's watchdog for as long as the act runs, and a clean moved HEAD is adopted.
 */

/**
 * The fixture's directory under the host's tmpdir, tracked for the file's after hook but carrying no
 * owner marker: a marker names this process's pid, and a worker's session runs in its own PID
 * namespace (bwrap --unshare-pid), where that pid means nothing to the host — whose tmp sweeps (the
 * loop's reclaim pass, another suite's runner) read the marker, find no such live process and remove
 * the directory within a second of its creation, mid-test. Ownerless, a `graphyard-*` directory is
 * reclaimed only once two hours old, so a killed run's leftover still goes.
 */
const fixtureDirectory = (label: string) => temporaryDirectory(`graphyard-${label}`, tmpdir());
const minute = 60_000, hour = 60 * minute, day = 24 * hour;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const worktree = fileURLToPath(new URL('..', import.meta.url));
const helper = fileURLToPath(new URL('./helpers/checkout-restore-serve-child.ts', import.meta.url));
/** The fixture release's CLI entry: starts the serve helper the way bin/graphyard.mjs starts src/cli.ts, naming the snapshot it runs from. */
const releaseEntry = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('../', import.meta.url));
const child = spawn(process.execPath, ['--import', 'tsx', ${JSON.stringify(helper)}, ...process.argv.slice(2)], { cwd: ${JSON.stringify(worktree)}, stdio: 'inherit', env: { ...process.env, GRAPHYARD_TEST_SNAPSHOT: here } });
child.on('exit', code => process.exit(code ?? 1));
`;

/**
 * A coordinator checkout whose base commit is the release origin's main serves (its CLI the fixture
 * entry, its checkout-restore-release.ts reading the loop's grant), with no deployment observed, so
 * the loop serves from origin's base-branch tip. The serve helper scans a fake /proc holding only
 * pid 1 (no writer to stop) and records each serve to `record`.
 */
async function installation() {
  const root = await fixtureDirectory('soak-checkout-restore');
  const credentials = join(root, 'credentials');
  await mkdir(credentials, { recursive: true, mode: 0o700 });
  const credentialFile = join(credentials, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const main = join(root, 'repo'), origin = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '-b', 'main', main], { stdio: 'ignore' });
  git(main, 'config', 'user.email', 't@example.com'); git(main, 'config', 'user.name', 'T');
  await mkdir(join(main, 'src', 'cli'), { recursive: true }); await mkdir(join(main, 'bin'), { recursive: true });
  await writeFile(join(main, 'bin', 'graphyard.mjs'), releaseEntry);
  await writeFile(join(main, 'src', 'cli', 'checkout-restore-release.ts'), `export const checkoutRestoreServeFlag = '--serve';\nexport const checkoutRestoreGrantVariable = ${JSON.stringify(checkoutRestoreGrantVariable)};\nexport const checkoutRestoreGrantKind = ${JSON.stringify(checkoutRestoreGrantKind)};\n`);
  await writeFile(join(main, 'src', 'loop.ts'), 'export const loop = 1;\n');
  await writeFile(join(main, '.gitignore'), '.graphyard/\n');
  git(main, 'add', '.'); git(main, 'commit', '-q', '-m', 'base');
  const release = git(main, 'rev-parse', 'HEAD');
  execFileSync('git', ['clone', '-q', '--bare', main, origin], { stdio: 'ignore' });
  git(main, 'remote', 'add', 'origin', origin);
  const proc = join(root, 'proc'), record = join(root, 'serve-record.json');
  mkdirSync(join(proc, '1'), { recursive: true });
  writeFileSync(join(proc, '1', 'stat'), '1 (init) S 0 1 1 0 -1 4194560\n'); writeFileSync(join(proc, '1', 'cgroup'), '0::/init.scope\n'); symlinkSync('/', join(proc, '1', 'cwd'));
  // GRAPHYARD_TEST_LOOP_PID: the simulated loop's pid of the iteration (each loop below is this test process under its own identity), which the serve helper counts beside this process's real ancestry.
  const env = { GRAPHYARD_TEST_FAKE_PROC: proc, GRAPHYARD_TEST_SERVE_RECORD: record, GRAPHYARD_TEST_LOOP_PID: '' };
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: join(main, 'bin', 'graphyard.mjs'),
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  // The installation as the serve entry reads it from the checkout: its private .graphyard/master.json, ignored by git.
  await mkdir(join(main, '.graphyard'), { recursive: true });
  await writeFile(join(main, '.graphyard', 'master.json'), JSON.stringify(config), { mode: 0o600 });
  return { main, config, release, record, env, credential: 'coordinator-token-'.padEnd(40, 'x') };
}
/** Sets the serve helper's environment for the children the loop spawns, returning its restoration. */
function withEnv(env: Record<string, string>) {
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  return () => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
}
const serveRecord = (record: string) => JSON.parse(readFileSync(record, 'utf8')) as { args: string[]; snapshotHead: string | null; snapshotBranch: string | null; snapshotShared: boolean; grant: { file: string | null; consumed: boolean | null; content: CheckoutRestoreGrant | null }; ppid: number; frozenAt: number | null; thawedAt: number | null; holdMs: number };

/**
 * `persist` writes the loop's cursor as the real loop does — the serve entry reads the lock it holds —
 * and `notify` records each supervisor notification with the wall clock it was sent at: the watchdog
 * it feeds runs on the wall clock, not the simulated one.
 */
function effects(now: () => number, persist: (state: DaemonState) => Promise<void>, notifications?: { at: number; state: string }[], loadedRelease?: string): DaemonEffects {
  const iso = () => new Date(now()).toISOString();
  return {
    ...(loadedRelease ? { loadedRelease: { commit: loadedRelease, dirty: false } } : {}),
    ...(notifications ? { notify: (state: 'ready' | 'alive') => { notifications.push({ at: Date.now(), state }); } } : {}),
    agents: () => [] as never[],
    credentials: async (profiles: { name: string }[]) => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    workerCredentials: async () => ({}), producerCredentials: async () => ({}),
    mutate: async () => ({}), dispatchWorker: async () => ({}), launchReview: async () => ({}), launchProducer: async () => ({}), merge: async () => ({}),
    snapshot: async () => ({ work: [] as Work[], now: iso() }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: iso(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist,
  } as unknown as DaemonEffects;
}

test('unit:soak-checkout-restore-served-once — over two simulated days of the real loop under a supervisor watchdog, each checkout-restore and confined master-restart request is served once, each restore — held past the watchdog window — keeps the supervisor fed, a failed restart is asked again until it lands, the escalation settles and stays settled, and no restarted loop serves anything again', { timeout: 600_000 }, async () => {
  const { main, config, release, record, env, credential } = await installation();
  // The supervisor: a 2 s watchdog window (the shipped unit's is 180 s), so the loop feeds it every 500 ms; each
  // restore's freeze is held 3 s — longer than the window — the way a large restore or a slow fetch outlasts it.
  const watchdogMs = 2_000, holdMs = 3_000;
  const environment = { NOTIFY_SOCKET: '/run/graphyard-soak/notify', WATCHDOG_USEC: String(watchdogMs * 1000) };
  const notifications: { at: number; state: string }[] = [];
  const start = Date.parse('2030-01-01T00:00:00Z');
  let clock = start;
  const now = () => clock;
  const state = emptyDaemonState(config);
  const persist = (current: DaemonState) => writeDaemonState(config, current);
  const journal: { at: number; pid: number; line: string }[] = [];
  const restarts: { at: number; pid: number; landed: boolean }[] = [];
  const serves: ReturnType<typeof serveRecord>[] = [];
  const reads: { at: number; pid: number; escalation: string | null; attempts: number | null }[] = [];
  // The day's plan, keyed by simulated time: hotfixes written into the checkout and the requests the
  // doctor and the master file (as `master checkout-restore` and the confined `master restart` write them).
  const request = (file: string, act: string, reason: string, requestedBy: string, args: string[] = []) => () => writeFileSync(file, JSON.stringify({ id: `r-${clock}`, act, reason, requestedAt: new Date(clock).toISOString(), requestedBy, args, outcome: null }));
  const plan = [
    { at: 0, act: () => writeFileSync(join(main, 'src', 'loop.ts'), 'export const loop = 2; // hotfix\n') },
    { at: 2 * hour, act: request(checkoutRestoreRequestPath(config), 'checkout-restore', 'the loop refuses its dirty checkout', 'graphyard-operator-agent') },
    { at: 20 * hour, act: () => { writeFileSync(join(main, 'src', 'fresh.ts'), 'export const fresh = 1;\n'); git(main, 'add', 'src/fresh.ts'); writeFileSync(join(main, 'src', 'fresh.ts'), 'export const fresh = 2;\n'); writeFileSync(join(main, 'scratchpad.mjs'), '// scratch\n'); } },
    { at: 22 * hour, act: request(checkoutRestoreRequestPath(config), 'checkout-restore', 'a standing pane wrote the checkout again', 'graphyard-operator-agent') },
    { at: 30 * hour, act: request(loopRestartRequestPath(config), 'restart', 'master restart from the confined master session', 'graphyard-master') },
  ];
  plan[0].act(); plan.shift();
  let failNextRestart = true, pid = 1000;
  const end = start + 2 * day;
  const restoreEnv = withEnv({ ...env, GRAPHYARD_TEST_SERVE_DELAY_MS: String(holdMs) });
  try { while (clock < end) {
    const host = new EventEmitter(), own = ++pid;
    process.env.GRAPHYARD_TEST_LOOP_PID = String(own);
    // Each wait between passes — the refused startup's and every cycle's — is ten simulated minutes.
    const intervalMs = () => {
      clock += 10 * minute;
      if (existsSync(record)) { serves.push(serveRecord(record)); unlinkSync(record); }
      for (const step of plan.filter(entry => start + entry.at <= clock)) { step.act(); plan.splice(plan.indexOf(step), 1); }
      if (clock >= end) host.emit('SIGTERM');
      return 1;
    };
    const checkout = async () => {
      const read = await readCoordinatorCheckout(main);
      const escalation = state.actions['escalation:dirty-checkout'];
      reads.push({ at: clock, pid: own, escalation: escalation?.state ?? null, attempts: escalation?.attempts ?? null });
      return read;
    };
    const restartLoop = async () => {
      const landed = !failNextRestart;
      restarts.push({ at: clock, pid: own, landed });
      if (!landed) { failNextRestart = false; throw new Error('systemctl --user restart graphyard-master.service: Failed to connect to bus'); }
      host.emit('SIGTERM');
    };
    await runDaemon(config, state, effects(now, persist, notifications), { intervalMs, identity: { pid: own, host: 'machine-a' }, signals: ['SIGTERM'], process: host as never, now, checkout, restartLoop, environment,
      log: line => journal.push({ at: clock, pid: own, line }) });
  } } finally { restoreEnv(); }

  // Each request was carried out once: two restores, each to its own named ref, and one restart request answered.
  const served = journal.filter(entry => /\] checkout-restore (restored|clean|failed)|\] loop-restart request/.test(entry.line) && !/restart (done|failed):/.test(entry.line));
  assert.equal(served.length, 3, `three requests served once each: ${served.map(entry => entry.line).join(' | ')}`);
  // Each restore ran in the release snapshot's own CLI — detached at origin's base-branch tip, sharing the checkout's object store — under a grant the serving loop issued and the entry consumed; never in the loop's loaded code.
  const restores = served.filter(entry => entry.line.includes('checkout-restore restored'));
  assert.equal(restores.length, 2);
  assert.ok(restores.every(entry => entry.line.includes(`served from the origin base-branch release ${release.slice(0, 12)}, a detached shared-clone snapshot of it`)), restores.map(entry => entry.line).join(' | '));
  assert.equal(serves.length, 2, 'the snapshot\'s CLI ran once per restore');
  const alive = notifications.filter(entry => entry.state === 'alive').map(entry => entry.at);
  for (const serve of serves) {
    assert.deepEqual(serve.args, ['master', 'checkout-restore', '--serve']);
    assert.equal(serve.snapshotHead, release); assert.equal(serve.snapshotBranch, null); assert.equal(serve.snapshotShared, true);
    assert.equal(serve.grant.file, checkoutRestoreGrantPath(config)); assert.equal(serve.grant.consumed, true);
    assert.ok(restores.some(entry => entry.pid === serve.grant.content?.loop.pid), 'issued under the serving loop\'s own pid, the one its cursor lock names');
    const { signature, ...payload } = serve.grant.content!;
    assert.equal(signature, signCheckoutRestoreGrant(payload, credential), 'signed with the installation\'s coordinator credential');
    // The restore outlasted the watchdog window, and the supervisor was fed throughout it: no two keep-alives
    // around or during the held freeze lie further apart than the window, and several fell inside it.
    assert.ok(serve.frozenAt && serve.thawedAt && serve.thawedAt - serve.frozenAt >= holdMs, `the freeze was held ${serve.thawedAt! - serve.frozenAt!} ms, past the ${watchdogMs} ms window`);
    const around = alive.filter(at => at >= serve.frozenAt! - watchdogMs && at <= serve.thawedAt! + watchdogMs).sort((a, b) => a - b);
    const inside = around.filter(at => at >= serve.frozenAt! && at <= serve.thawedAt!);
    assert.ok(inside.length >= 4, `the keep-alive was fed ${inside.length} times during the ${holdMs} ms freeze (every ${watchdogMs / 4} ms): ${around.map(at => at - serve.frozenAt!).join(', ')} ms from the freeze`);
    const gaps = around.slice(1).map((at, index) => at - around[index]);
    assert.ok(gaps.every(gap => gap < watchdogMs), `no keep-alive gap reached the watchdog window through the restore: ${gaps.join(', ')} ms`);
    assert.ok(around[0] < serve.frozenAt! && around.at(-1)! > serve.thawedAt!, 'fed before the freeze began and after it ended');
  }
  assert.ok(notifications.some(entry => entry.state === 'ready'), 'each loop told its supervisor it was ready');
  assert.deepEqual(serves.map(serve => serve.grant.content?.loop.pid), restores.map(entry => entry.pid), 'each grant names the one pid of the loop that served: its cursor lock\'s');
  assert.ok(!existsSync(checkoutRestoreGrantPath(config)), 'no grant outlives its serve');
  // Two restores may share a stamp's second; the ref names their commits too, so they are ordered by what they hold.
  const holds = (ref: string, path: string) => { try { git(main, 'cat-file', '-e', `${ref}:${path}`); return 1; } catch { return 0; } };
  const refs = git(main, 'for-each-ref', '--format=%(refname)', checkoutRestoreRefPrefix).split('\n').filter(Boolean).sort((a, b) => holds(a, 'src/fresh.ts') - holds(b, 'src/fresh.ts'));
  assert.equal(refs.length, 2, `one named ref per restore: ${refs.join(', ')}`);
  assert.equal(git(main, 'show', `${refs[0]}:src/loop.ts`), 'export const loop = 2; // hotfix', 'the first hotfix is saved');
  assert.equal(git(main, 'show', `${refs[1]}:src/fresh.ts`), 'export const fresh = 2;', 'the second restore saved the working file');
  assert.equal(git(main, 'show', `${refs[1]}^2:src/fresh.ts`), 'export const fresh = 1;', 'and the staged version beside it');
  assert.equal(git(main, 'show', `${refs[1]}:scratchpad.mjs`), '// scratch', 'and the untracked scratch outside the source paths');
  assert.equal(git(main, 'status', '--porcelain'), '', 'no non-ignored dirty path is left');
  assert.deepEqual(dirtyCheckoutPaths(await readCoordinatorCheckout(main)), [], 'the checkout ends the days clean');
  // The restarts: the first ask failed and was asked again on the next pass by the same loop; every
  // other request owed exactly one, and each landed loop is a new process.
  assert.deepEqual(restarts.map(entry => entry.landed), [false, true, true, true], `restarts: ${JSON.stringify(restarts)}`);
  assert.equal(restarts[0].pid, restarts[1].pid, 'the failed restart is retried by the loop that owed it');
  assert.ok(restarts[1].at - restarts[0].at <= 10 * minute, 'on its very next pass');
  assert.equal(new Set(restarts.filter(entry => entry.landed).map(entry => entry.pid)).size, 3, 'each landed restart ended a different loop');
  for (const file of [checkoutRestoreRequestPath(config), loopRestartRequestPath(config)])
    assert.equal((await readCheckoutRestoreRequest(file))?.outcome?.restart?.state, 'done', `${file}: the restarted loop recorded its restart done`);
  // The escalation: refused at startup and again after the second hotfix, settled by each restore,
  // and never failed again after the last one for the rest of the days.
  const lastRestore = restarts[3 - 1].at;
  const after = reads.filter(entry => entry.at > lastRestore);
  assert.ok(after.length >= 100 && after.at(-1)!.at - lastRestore >= day, `the days ran on ${(after.at(-1)!.at - lastRestore) / hour} hours past the last restore`);
  assert.ok(after.every(entry => entry.escalation === 'done'), 'the escalation stays settled');
  assert.equal(new Set(after.map(entry => entry.attempts)).size, 1, 'no further failed attempt is recorded');
  assert.equal(Object.keys(state.actions).filter(key => key.startsWith('escalation:dirty-checkout')).length, 1, 'one escalation row all days');
  assert.ok(!journal.some(entry => entry.at > restarts.at(-1)!.at && /checkout-restore|loop-restart|escalation failed/.test(entry.line) && !/restart done/.test(entry.line)),
    `the last restarted loop serves nothing again: ${journal.filter(entry => entry.at > restarts.at(-1)!.at && /checkout-restore|loop-restart/.test(entry.line)).map(entry => entry.line).join(' | ')}`);
  assert.ok(new Set(reads.map(entry => entry.pid)).size >= 4, 'the days ran four loop processes');
});

test('integration:soak-checkout-restore-drift — over two simulated days of the real loop, a checkout-restore request against a clean checkout whose HEAD moved under the loop is adopted: the drift escalation settles, the loop restarts through its unit onto that HEAD, the restarted loop runs it, and nothing is served, restarted or raised again', { timeout: 600_000 }, async () => {
  const { main, config, release, record, env } = await installation();
  git(main, 'checkout', '-q', '--detach');
  const loaded = git(main, 'rev-parse', 'HEAD');
  const start = Date.parse('2030-01-01T00:00:00Z');
  let clock = start;
  const now = () => clock;
  const state = emptyDaemonState(config);
  const persist = (current: DaemonState) => writeDaemonState(config, current);
  const journal: { at: number; pid: number; line: string }[] = [];
  const restarts: { at: number; pid: number }[] = [];
  const reads: { at: number; pid: number; head: string | null; escalation: string | null; attempts: number | null; detail: string | null }[] = [];
  let moved: string | null = null;
  const request = (file: string, act: string, reason: string, requestedBy: string) => () => writeFileSync(file, JSON.stringify({ id: `r-${clock}`, act, reason, requestedAt: new Date(clock).toISOString(), requestedBy, args: [], outcome: null }));
  const plan = [
    // A hand checkout moves HEAD forward onto a new commit, clean: the drift the guard refuses.
    { at: 1 * hour, act: () => { writeFileSync(join(main, 'src', 'next.ts'), 'export const next = 1;\n'); git(main, 'add', 'src/next.ts'); git(main, 'commit', '-q', '-m', 'moved under the loop'); moved = git(main, 'rev-parse', 'HEAD'); } },
    { at: 3 * hour, act: request(checkoutRestoreRequestPath(config), 'checkout-restore', 'escalation:dirty-checkout standing: HEAD moved while the loop ran', 'graphyard-doctor') },
  ];
  let pid = 2000;
  const end = start + 2 * day;
  const restoreEnv = withEnv(env);
  try { while (clock < end) {
    const host = new EventEmitter(), own = ++pid;
    process.env.GRAPHYARD_TEST_LOOP_PID = String(own);
    const intervalMs = () => {
      clock += 10 * minute;
      for (const step of plan.filter(entry => start + entry.at <= clock)) { step.act(); plan.splice(plan.indexOf(step), 1); }
      if (clock >= end) host.emit('SIGTERM');
      return 1;
    };
    const checkout = async () => {
      const read = await readCoordinatorCheckout(main);
      const escalation = state.actions['escalation:dirty-checkout'];
      reads.push({ at: clock, pid: own, head: read.commit, escalation: escalation?.state ?? null, attempts: escalation?.attempts ?? null, detail: escalation?.detail ?? null });
      return read;
    };
    const restartLoop = async () => { restarts.push({ at: clock, pid: own }); host.emit('SIGTERM'); };
    await runDaemon(config, state, effects(now, persist), { intervalMs, identity: { pid: own, host: 'machine-a' }, signals: ['SIGTERM'], process: host as never, now, checkout, restartLoop,
      log: line => journal.push({ at: clock, pid: own, line }) });
  } } finally { restoreEnv(); }
  const adopted = git(main, 'rev-parse', 'HEAD'), movedTo = moved as string | null;
  assert.ok(movedTo === adopted && adopted !== loaded, 'HEAD moved');
  // Before the request: the drift stood as a failed escalation naming the remedy the installation runs itself.
  const standing = reads.filter(entry => entry.at >= start + 1 * hour + 20 * minute && entry.at < start + 3 * hour);
  assert.ok(standing.length >= 5 && standing.every(entry => entry.escalation === 'failed'), `the drift escalation stood before the request: ${JSON.stringify(standing.slice(0, 3))}`);
  assert.ok(standing.every(entry => entry.detail?.includes(`its HEAD moved from ${loaded.slice(0, 12)} to ${adopted.slice(0, 12)}`) && entry.detail.includes('graphyard master checkout-restore REASON')), `the refusal names the drift and the remedy: ${standing[0].detail}`);
  // The request was served once, as an adoption: no dirty path, HEAD adopted, settled, restarted — by the loop that found it.
  const served = journal.filter(entry => /\] checkout-restore (restored|adopted|clean|failed)/.test(entry.line) && !/restart (done|failed):/.test(entry.line));
  assert.equal(served.length, 1, `one request served once: ${served.map(entry => entry.line).join(' | ')}`);
  assert.match(served[0].line, new RegExp(`checkout-restore adopted: the coordinator checkout at ${main} held no dirty path, but its HEAD ${adopted.slice(0, 12)} is not ${loaded.slice(0, 12)}, the commit the loop runs; the loop adopts it \\(GY-1531\\) and restarts through its supervising unit onto it; served from the origin base-branch release ${release.slice(0, 12)}, a detached shared-clone snapshot of it`));
  // The judgement ran in the release snapshot's CLI under the loop's grant, and found nothing to restore.
  const serve = serveRecord(record);
  assert.equal(serve.snapshotHead, release); assert.equal(serve.grant.consumed, true); assert.equal(serve.grant.content?.loop.pid, served[0].pid, 'the grant names the serving loop, as its cursor lock does');
  assert.ok(served[0].at - start - 3 * hour <= 10 * minute, 'on the next pass after it was filed');
  assert.deepEqual(restarts.map(entry => entry.pid), [served[0].pid], 'exactly one restart, asked by the loop that served the request');
  const stored = await readCheckoutRestoreRequest(checkoutRestoreRequestPath(config));
  assert.equal(stored?.outcome?.state, 'adopted'); assert.equal(stored?.outcome?.commit, adopted);
  assert.equal(stored?.outcome?.restart?.state, 'done', 'the restarted loop recorded its restart done');
  // Nothing was saved or moved: the checkout stands clean at the adopted HEAD, with no restore ref.
  assert.equal(git(main, 'rev-parse', 'HEAD'), adopted);
  assert.equal(git(main, 'status', '--porcelain'), '');
  assert.equal(git(main, 'for-each-ref', '--format=%(refname)', checkoutRestoreRefPrefix), '');
  // The escalation settled with the adoption, before the restart, and stayed settled for the rest of the days under the restarted loop.
  const after = reads.filter(entry => entry.at > restarts[0].at);
  assert.ok(after.length >= 100 && after.at(-1)!.at - restarts[0].at >= day, `the days ran on ${(after.at(-1)!.at - restarts[0].at) / hour} hours past the restart`);
  assert.ok(after.every(entry => entry.escalation === 'done' && entry.pid !== restarts[0].pid), 'the escalation stays settled under a new loop process');
  assert.equal(new Set(after.map(entry => entry.attempts)).size, 1, 'no further failed attempt is recorded');
  assert.equal(Object.keys(state.actions).filter(key => key.startsWith('escalation:dirty-checkout')).length, 1, 'one escalation row all days');
  assert.ok(!journal.some(entry => entry.at > restarts[0].at && /checkout-restore|escalation failed|loop-restart/.test(entry.line) && !/restart done/.test(entry.line)),
    `the restarted loop serves nothing again: ${journal.filter(entry => entry.at > restarts[0].at && /checkout-restore|escalation failed/.test(entry.line)).map(entry => entry.line).join(' | ')}`);
  const settledLine = journal.find(entry => entry.pid === served[0].pid && entry.line.includes('escalation done:'));
  assert.ok(settledLine && settledLine.at <= restarts[0].at && settledLine.line.includes(`is clean again at ${adopted.slice(0, 12)}, the commit the loop runs`), `the serving loop settled the drift onto the adopted HEAD before restarting: ${settledLine?.line}`);
});

test('integration:soak-checkout-restore-diverged — over two simulated days of the real loop, a checkout-restore request against a clean checkout whose HEAD is detached at an orphan commit (neither on the base branch nor above the commit the loop runs) saves that HEAD under refs/graphyard/checkout-restore/diverged-*, detaches the checkout at the serving release and restarts the loop through its unit once; the restore stays settled for the rest of the days, and the serve entry\'s output still parses under the strict schema of a loop loaded before GY-1745', async () => {
  const { main, config, release, record, env } = await installation();
  git(main, 'fetch', '-q', 'origin'); // the base ref the diverged judgement reads
  git(main, 'checkout', '-q', '--detach');
  const loaded = git(main, 'rev-parse', 'HEAD');
  const start = Date.parse('2030-01-01T00:00:00Z');
  let clock = start;
  const now = () => clock;
  const state = emptyDaemonState(config);
  const persist = (current: DaemonState) => writeDaemonState(config, current);
  const journal: { at: number; pid: number; line: string }[] = [];
  const restarts: { at: number; pid: number }[] = [];
  const reads: { at: number; pid: number; escalation: string | null; attempts: number | null }[] = [];
  let diverged: string | null = null;
  const request = (file: string, act: string, reason: string, requestedBy: string) => () => writeFileSync(file, JSON.stringify({ id: `r-${clock}`, act, reason, requestedAt: new Date(clock).toISOString(), requestedBy, args: [], outcome: null }));
  const plan = [
    // A hand checkout moves HEAD onto an orphan commit, clean: neither merged nor forward of the loaded commit.
    { at: 1 * hour, act: () => { git(main, 'checkout', '-q', '--orphan', 'side'); writeFileSync(join(main, 'side.ts'), 'export const side = 1;\n'); git(main, 'add', 'side.ts'); git(main, 'commit', '-q', '-m', 'orphan'); diverged = git(main, 'rev-parse', 'HEAD'); git(main, 'checkout', '-q', '--detach'); git(main, 'branch', '-q', '-D', 'side'); } },
    { at: 3 * hour, act: request(checkoutRestoreRequestPath(config), 'checkout-restore', 'escalation:dirty-checkout standing: HEAD diverged', 'graphyard-doctor') },
  ];
  let pid = 3000;
  const end = start + 2 * day;
  const restoreEnv = withEnv(env);
  try { while (clock < end) {
    const host = new EventEmitter(), own = ++pid;
    process.env.GRAPHYARD_TEST_LOOP_PID = String(own);
    const intervalMs = () => {
      clock += 10 * minute;
      for (const step of plan.filter(entry => start + entry.at <= clock)) { step.act(); plan.splice(plan.indexOf(step), 1); }
      if (clock >= end) host.emit('SIGTERM');
      return 1;
    };
    const checkout = async () => {
      const read = await readCoordinatorCheckout(main);
      const escalation = state.actions['escalation:dirty-checkout'];
      reads.push({ at: clock, pid: own, escalation: escalation?.state ?? null, attempts: escalation?.attempts ?? null });
      return read;
    };
    const restartLoop = async () => { restarts.push({ at: clock, pid: own }); host.emit('SIGTERM'); };
    await runDaemon(config, state, effects(now, persist, undefined, loaded), { intervalMs, identity: { pid: own, host: 'machine-a' }, signals: ['SIGTERM'], process: host as never, now, checkout, restartLoop,
      log: line => journal.push({ at: clock, pid: own, line }) });
  } } finally { restoreEnv(); }
  assert.ok(diverged, 'the orphan HEAD was made');
  const served = journal.filter(entry => /\] checkout-restore (restored|adopted|clean|failed)/.test(entry.line) && !/restart (done|failed):/.test(entry.line));
  assert.equal(served.length, 1, `one request served once: ${served.map(entry => entry.line).join(' | ')}`);
  assert.match(served[0].line, /checkout-restore adopted: .*neither on the base branch nor a descendant of the commit the loop runs/);
  const refs = git(main, 'for-each-ref', '--format=%(refname)', checkoutRestoreRefPrefix).split('\n').filter(Boolean);
  assert.equal(refs.length, 1, `one saved ref: ${refs.join(', ')}`);
  assert.ok(refs[0].startsWith(`${checkoutRestoreRefPrefix}diverged-`), refs[0]);
  assert.equal(git(main, 'rev-parse', refs[0]), diverged, 'the diverged HEAD is kept under the ref');
  assert.equal(git(main, 'rev-parse', 'HEAD'), release, 'the checkout stands at the serving release');
  assert.equal(release, loaded); assert.equal(git(main, 'status', '--porcelain'), '');
  // The older-loaded-loop boundary: the entry's printed output parses under the strict schema a loop loaded before GY-1745 holds, and reads as a restore that owes the restart.
  const oldSchema = z.object({ restored: z.object({ ref: z.string(), commit: z.string(), paths: z.array(z.string()), skipped: z.array(z.object({ pid: z.number().int(), error: z.string() })).default([]) }).nullable(), head: z.string().nullable() }).strict();
  const printed = oldSchema.parse((serveRecord(record) as unknown as { outcome: unknown }).outcome);
  assert.equal(printed.restored?.ref, refs[0]); assert.equal(printed.head, release);
  assert.deepEqual(restarts.map(entry => entry.pid), [served[0].pid], 'exactly one restart, asked by the loop that served the request');
  const stored = await readCheckoutRestoreRequest(checkoutRestoreRequestPath(config));
  assert.equal(stored?.outcome?.state, 'adopted'); assert.equal(stored?.outcome?.ref, refs[0]); assert.equal(stored?.outcome?.restart?.state, 'done');
  const after = reads.filter(entry => entry.at > restarts[0].at);
  assert.ok(after.length >= 100 && after.at(-1)!.at - restarts[0].at >= day, 'the days ran on past the restart');
  assert.ok(after.every(entry => entry.escalation === 'done' && entry.pid !== restarts[0].pid), 'the escalation stays settled under a new loop process');
  assert.equal(new Set(after.map(entry => entry.attempts)).size, 1, 'no further failed attempt is recorded');
  assert.equal(git(main, 'for-each-ref', '--format=%(refname)', checkoutRestoreRefPrefix).split('\n').filter(Boolean).length, 1, 'no later cycle saved another ref');
  assert.ok(!journal.some(entry => entry.at > restarts[0].at && /checkout-restore|escalation failed|loop-restart/.test(entry.line) && !/restart done/.test(entry.line)), 'the restarted loop serves nothing again');
});
