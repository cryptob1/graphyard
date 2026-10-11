import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { checkoutRestoreServeFlag, releasePinnedRestore, releaseServes, servingRelease, snapshotRelease } from '../src/cli/checkout-restore-release.js';
import { checkoutRestoreRefPrefix, fileCheckoutRestoreRequest, readCheckoutRestoreRequest, serveCheckoutRestore } from '../src/cli/master-checkout-restore.js';
import { checkoutRestoreDriftRemedy, coordinatorCheckoutGuard } from '../src/daemon/run.js';
import { emptyDaemonState } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { readCoordinatorCheckout } from '../src/master/profiles.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1680 (instance GY-1679): the loop served `master checkout-restore` from the code it had loaded,
// so GY-1672's unreadable-cwd skip, merged and deployed, reached no installation whose loop could
// not restart — the loop the request exists to restart — and a request that found the checkout
// clean but at a HEAD the loop had not loaded ended `clean`, with no settle and no restart, while the
// drift escalation stood. The act now runs from the verified serving release's own CLI in a detached
// shared-clone snapshot of it, and a clean drifted checkout is adopted: settled, and restarted onto.

const worktree = fileURLToPath(new URL('..', import.meta.url));
const helper = fileURLToPath(new URL('./helpers/checkout-restore-serve-child.ts', import.meta.url));

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
/** The checkout's own entry at the commit the loop loaded: were the act run from the checkout's tree, it would say so and fail. */
const loadedEntry = '#!/usr/bin/env node\nconsole.error("the checkout\'s own tree served the act");\nprocess.exit(3);\n';

/**
 * A coordinator checkout whose `release` commit holds the serve-capable CLI (what the deployment
 * step verified serving) and whose HEAD, `loaded`, is a later commit — the one the loop loaded —
 * whose own entry refuses, so only the snapshot can have served the act.
 */
async function fixture(name: string) {
  const base = await temporaryDirectory(name);
  const root = join(base, 'coordinator');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  mkdirSync(join(root, 'src', 'cli'), { recursive: true }); mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 1;\n');
  writeFileSync(join(root, 'bin', 'graphyard.mjs'), releaseEntry);
  writeFileSync(join(root, 'src', 'cli', 'checkout-restore-release.ts'), "export const checkoutRestoreServeFlag = '--serve';\n");
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
  const file = join(base, 'state', 'graphyard-master.checkout-restore.json');
  mkdirSync(join(base, 'state'), { recursive: true });
  const env = { GRAPHYARD_TEST_FAKE_PROC: proc, GRAPHYARD_TEST_SERVE_RECORD: record, GRAPHYARD_TEST_DENY_PATHS: join(proc, '1372', 'cwd') };
  return { base, root, git, release, loaded, proc, record, checkout, file, env };
}
/** Sets the helper's environment for the child the act spawns, returning its restoration. */
function withEnv(env: Record<string, string>) {
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  return () => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
}
const serveRecord = (record: string) => JSON.parse(readFileSync(record, 'utf8')) as { entry: string; snapshot: string; sent: string[]; snapshotHead: string | null; snapshotBranch: string | null; snapshotShared: boolean; snapshotModules: boolean; outcome: unknown };

test('integration:checkout-restore-release-pinned-serve — the loop serves a checkout-restore request from a detached shared-clone snapshot of the verified serving release, and with an unreadable-cwd same-user daemon present the act completes: the freeze skips it, every dirty path is saved under refs/graphyard/checkout-restore/, the escalation is settled and the restart asked', { timeout: 120_000 }, async () => {
  const { base, root, git, release, loaded, record, file, env } = await fixture('checkout-restore-release-pinned');
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 2; // hotfix\n');
  writeFileSync(join(root, 'scratchpad.mjs'), '// scratch\n');
  await fileCheckoutRestoreRequest(file, 'escalation:dirty-checkout', 'graphyard-doctor');
  const settled: (string | null)[] = []; let restarts = 0;
  const restore = withEnv(env);
  let outcome;
  try {
    outcome = await serveCheckoutRestore(file, root, {
      pid: 100, restart: async () => { restarts++; }, settle: async adopt => { settled.push(adopt); }, loaded: () => loaded,
      restore: releasePinnedRestore({ release: () => ({ deployment: { source: 'endpoint', sha: release }, baseBranch: 'main' }) }),
    });
  } finally { restore(); }
  assert.equal(outcome?.state, 'restored', outcome?.detail);
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
  const { root, git, release, loaded, proc, record, checkout, file, env } = await fixture('checkout-restore-release-fail-closed');
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 2; // hotfix\n');
  writeFileSync(join(root, 'scratchpad.mjs'), '// scratch\n');
  // pid 410: its cwd read refused EACCES, its leader a zombie, its live thread 411 inside the checkout — a writer the freeze must stop.
  processEntry(proc, 410, { cwd: checkout, state: 'Z' }); threadEntry(proc, 410, 410, { state: 'Z', cwd: null }); threadEntry(proc, 410, 411, { cwd: checkout });
  const settled: (string | null)[] = []; let restarts = 0;
  const serve = () => serveCheckoutRestore(file, root, {
    pid: 100, restart: async () => { restarts++; }, settle: async adopt => { settled.push(adopt); }, loaded: () => loaded,
    restore: releasePinnedRestore({ release: () => ({ deployment: { source: 'endpoint', sha: release }, baseBranch: 'main' }) }),
  });
  const untouched = (served: ReturnType<typeof serveRecord>) => {
    assert.equal(readFileSync(join(root, 'src', 'loop.ts'), 'utf8'), 'export const loop = 2; // hotfix\n', 'the tracked change stands');
    assert.ok(existsSync(join(root, 'scratchpad.mjs')), 'the untracked file stands');
    assert.equal(git('for-each-ref', checkoutRestoreRefPrefix), '', 'no ref was written');
    assert.equal(served.snapshotHead, release, 'the act ran from the release snapshot');
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
});

test('unit:serve-uses-verified-release — the serving release is the deployment step\'s verified sha when the store holds it, else the fetched base-branch tip at origin; the act is the snapshot\'s own CLI run with the serve entry, and only an unmaterializable or pre-entry release falls back to the loop\'s code, saying so', async () => {
  const base = await temporaryDirectory('serve-uses-verified-release');
  const root = join(base, 'coordinator'), origin = join(base, 'origin.git');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  mkdirSync(join(root, 'src', 'cli'), { recursive: true }); mkdirSync(join(root, 'bin'), { recursive: true }); mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'bin', 'graphyard.mjs'), '#!/usr/bin/env node\n');
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 1;\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  git('add', '-A'); git('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'before the serve entry');
  const older = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'src', 'cli', 'checkout-restore-release.ts'), "export const checkoutRestoreServeFlag = '--serve';\n");
  git('add', '-A'); git('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'the serve entry');
  const served = git('rev-parse', 'HEAD');
  execFileSync('git', ['clone', '-q', '--bare', root, origin], { stdio: 'ignore' });
  git('remote', 'add', 'origin', origin);
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 2;\n');
  git('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-am', 'the loop loaded this');
  const loaded = git('rev-parse', 'HEAD');
  execFileSync('git', ['-C', origin, 'update-ref', 'refs/heads/main', served], { stdio: 'ignore' });

  // The release: the verified sha first; unobserved or missing from the store, the base branch's tip at origin, fetched.
  assert.deepEqual(await servingRelease(root, { deployment: { source: 'endpoint', sha: served }, baseBranch: 'main' }), { commit: served, source: 'deployment' });
  assert.deepEqual(await servingRelease(root, { deployment: { source: 'unavailable', sha: null }, baseBranch: 'main' }), { commit: served, source: 'origin' });
  assert.equal(git('rev-parse', 'refs/remotes/origin/main'), served, 'the tip was fetched');
  assert.deepEqual(await servingRelease(root, { deployment: { source: 'endpoint', sha: 'f'.repeat(40) }, baseBranch: 'main' }), { commit: served, source: 'origin' });
  const none = await servingRelease(root, { deployment: null, baseBranch: 'release' });
  assert.match('reason' in none ? none.reason : '', /no verified release is observed serving; origin\/release could not be fetched .*; refs\/remotes\/origin\/release does not resolve/);

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
  const olderSnapshot = await snapshotRelease(root, older);
  try { assert.equal(releaseServes(olderSnapshot.directory), false, 'a release from before the entry would file a request of its own'); } finally { await olderSnapshot.dispose(); }

  // The act: the snapshot's CLI, run with the serve entry and the request's root and reason, its output the outcome.
  const runs: { command: string; args: string[]; cwd?: string; head: string; shared: boolean }[] = [];
  const entry = (output: string | Error): ChildRun => (command, args, options) => {
    if (command === 'git') return defaultChildRun(command, args, options);
    const cwd = options?.cwd!;
    runs.push({ command, args, cwd, head: execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), shared: existsSync(join(cwd, '.git', 'objects', 'info', 'alternates')) });
    if (output instanceof Error) throw output;
    return output;
  };
  const inputs = { deployment: { source: 'endpoint', sha: served }, baseBranch: 'main' };
  const at = new Date('2030-01-01T00:00:00Z');
  const act = releasePinnedRestore({ release: () => inputs, run: entry(JSON.stringify({ restored: null, head: loaded })), command: directory => ({ command: 'node', args: [join(directory, 'bin', 'graphyard.mjs')] }) });
  const outcome = await act(root, 'the loop refuses its checkout (requested by graphyard-doctor)', at);
  assert.deepEqual(outcome, { restored: null, head: loaded, served: `served from the verified serving release ${served.slice(0, 12)}, a detached shared-clone snapshot of it` });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].command, 'node');
  assert.deepEqual(runs[0].args.slice(1), ['master', 'checkout-restore', checkoutRestoreServeFlag, root, 'the loop refuses its checkout (requested by graphyard-doctor)']);
  assert.equal(runs[0].args[0], join(runs[0].cwd!, 'bin', 'graphyard.mjs'), 'the snapshot\'s own entry');
  assert.equal(runs[0].head, served, 'run in the snapshot at the verified release, not the checkout the loop loaded');
  assert.ok(runs[0].shared);
  assert.ok(!existsSync(runs[0].cwd!), 'the snapshot is disposed after');
  // The child's refusal is the act's error, its stderr the message; an unreadable outcome is an error naming it.
  const refused = Object.assign(new Error('Command failed: node bin/graphyard.mjs master checkout-restore\nthe working directory of pid 200 (EINVAL) cannot be read, so whether it writes in the checkout cannot be verified and nothing was restored'), { stderr: 'the working directory of pid 200 (EINVAL) cannot be read, so whether it writes in the checkout cannot be verified and nothing was restored' });
  await assert.rejects(releasePinnedRestore({ release: () => inputs, run: entry(refused), command: directory => ({ command: 'node', args: [join(directory, 'bin', 'graphyard.mjs')] }) })(root, 'reason', at), /served from the verified serving release .*: Command failed: node bin\/graphyard.mjs master checkout-restore\nthe working directory of pid 200/s);
  await assert.rejects(releasePinnedRestore({ release: () => inputs, run: entry('not json'), command: directory => ({ command: 'node', args: [join(directory, 'bin', 'graphyard.mjs')] }) })(root, 'reason', at), /served from the verified serving release .*, whose outcome could not be read \(.*\): not json/);
  // The loop's own code serves only when no release can be materialized or the release predates the entry — and says so.
  runs.length = 0;
  const own = await releasePinnedRestore({ release: () => ({ deployment: null, baseBranch: 'release' }), run: entry('never run') })(root, 'reason', at);
  assert.equal(runs.length, 0);
  assert.equal(own.restored, null); assert.equal(own.head, loaded);
  assert.match(own.served!, /^served by the loop's own code: no serving release could be materialized \(no verified release is observed serving; .*refs\/remotes\/origin\/release does not resolve\)$/);
  const pre = await releasePinnedRestore({ release: () => ({ deployment: { source: 'endpoint', sha: older }, baseBranch: 'main' }), run: entry('never run') })(root, 'reason', at);
  assert.equal(runs.length, 0);
  assert.equal(pre.served, `served by the loop's own code: the verified serving release ${older.slice(0, 12)} predates the serve entry`);
  assert.equal(git('status', '--porcelain'), '', 'a clean checkout stays clean through every path');
});

test('unit:clean-drift-settles-and-restarts — a request that finds no dirty path but a HEAD other than the commit the loop loaded is adopted: the outcome names the HEAD, the guard settles the drift escalation onto it and the restart through the unit is asked; a clean checkout at the loaded commit stays `clean` with neither', async () => {
  const base = await temporaryDirectory('clean-drift-settles');
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
