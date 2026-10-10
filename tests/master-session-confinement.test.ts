import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { masterConfinementVariable, masterSessionConfinement, startAgentSession } from '../src/master/launch.js';
import { dirtyCheckoutPaths, hostProcessLaunchTargets, readCoordinatorCheckout, sessionMountNamespaceWorks } from '../src/master/profiles.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { checkoutRestoreRemedy, coordinatorCheckoutGuard, serveLoopRequests } from '../src/daemon/run.js';
import { emptyDaemonState } from '../src/master-daemon.js';
import { checkoutRestoreCommand, checkoutRestoreRefPrefix, checkoutRestoreRequestPath, checkoutWriterProcesses, fileCheckoutRestoreRequest, freezeCheckoutWriters, loopExecutorsRequestPath, loopRestartRequestPath, readCheckoutRestoreRequest, restoreCoordinatorCheckout, serveCheckoutRestore, statusPaths } from '../src/cli/master-checkout-restore.js';
import { doctorCommandVerdict, doctorSanctionedCommands as piSanctioned } from '../integrations/pi/index.js';
import { doctorPrompt, doctorSanctionedCommands } from '../src/daemon/doctor.js';
import { confinedMaster } from '../src/cli/master/operations.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1658: the loop-launched master session ran with the coordinator checkout writable (it opted
// out of GY-888's confinement), and it and standing agent panes hotfixed the serving checkout until
// the GY-857 guard refused every loop start on it — with no remedy the installation could run
// itself. The master session now launches with the checkout read-only, a launch that cannot be
// confined is refused, the escalation names the standing panes as the suspected writers with the
// remedy, and `master checkout-restore` saves every dirty path under a named ref and restarts the loop.

function coordinator(base: string) {
  const root = join(base, 'coordinator');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 1;\n');
  writeFileSync(join(root, 'src', 'gone.ts'), 'export const gone = 1;\n');
  writeFileSync(join(root, 'Dockerfile'), 'FROM node:22\n');
  writeFileSync(join(root, '.gitignore'), '.graphyard/\n*.log\n');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  git('config', 'user.email', 'graphyard@localhost'); git('config', 'user.name', 'Graphyard');
  git('add', '.'); git('commit', '-q', '-m', 'coordinator');
  return { root, git };
}
const config = (directory: string): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(directory, 'coordinator.token'), cliPath: 'graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], run: {} });
const guardFor = (root: string, state: ReturnType<typeof emptyDaemonState>, agents: () => Promise<unknown[]> = async () => []) => coordinatorCheckoutGuard({
  state: () => state, read: () => readCoordinatorCheckout(root), agents: agents as never, snapshot: async () => ({ work: [] as Work[], now: new Date().toISOString() }),
  persist: async () => {}, now: () => Date.now(), log: () => {}, applies: () => true });

test('integration:master-session-checkout-readonly — the master session cannot write a tracked path of the coordinator checkout, directly or through a host process it asks to start, while its managed state and its admin writes still work', async () => {
  const base = await temporaryDirectory('master-confinement');
  const { root, git } = coordinator(base);
  const confinement = await masterSessionConfinement('claude', root, { bwrap: 'bwrap', platform: 'linux', mountNamespaceWorks: true });
  assert.equal(confinement.mechanism, 'read-only-mount');
  const words = confinement.wrapper;
  const at = words.indexOf(root);
  assert.ok(at > 0 && words[at - 1] === '--ro-bind', 'the checkout is bound read-only');
  assert.ok(words.includes(join(root, '.graphyard')) && words[words.indexOf(join(root, '.graphyard')) - 1] === '--bind', 'the managed .graphyard state is re-exposed writable');
  assert.ok(words.includes('--unshare-pid') && words[words.indexOf('--proc') + 1] === '/proc', 'the master runs in its own PID namespace with a fresh /proc: no /proc/PID/root route back to the writable checkout');
  // The host's process-launch channels are hidden exactly as for every other session: no systemd-run --user, no system bus.
  const targets = hostProcessLaunchTargets();
  for (const directory of targets.directories.filter(path => existsSync(path) && statSync(path).isDirectory()))
    assert.ok(words.some((word, index) => word === '--tmpfs' && words[index + 1] === realpathSync(directory)), `${directory} is masked`);
  for (const socket of targets.busSockets.filter(path => existsSync(path))) assert.ok(words.includes(realpathSync(socket)), `the session bus ${socket} is replaced`);
  assert.deepEqual(words.slice(1, 4), ['--setenv', masterConfinementVariable, 'master'], 'the wrapper marks the session confined, so its master restart asks the loop');
  if (process.platform !== 'linux') return;
  assert.ok(await sessionMountNamespaceWorks(), 'mount namespaces work on this Linux host');
  const live = await masterSessionConfinement('claude', root);
  const outside = join(base, 'config'); mkdirSync(outside);
  const inside = (script: string) => spawnSync(live.wrapper[0], [...live.wrapper.slice(1), 'bash', '-c', script], { cwd: root, encoding: 'utf8' });
  // The scripted hotfix of a tracked path fails at the OS level, by every route.
  for (const script of ['echo hotfix >> src/loop.ts', 'sed -i s/1/2/ src/loop.ts', 'cp Dockerfile src/loop.ts', `git -C ${root} commit -q --allow-empty -m hotfix`, `git -C ${root} stash push -q`, 'rm src/gone.ts',
    `echo hotfix >> /proc/1/root${root}/src/loop.ts`, `echo hotfix >> /proc/${process.pid}/root${root}/src/loop.ts`,
    `systemd-run --user --quiet --wait sh -c 'echo hotfix >> ${root}/src/loop.ts'`, `systemctl --user show-environment`])
    assert.notEqual(inside(script).status, 0, `the master session cannot run: ${script}`);
  assert.equal(readFileSync(join(root, 'src', 'loop.ts'), 'utf8'), 'export const loop = 1;\n', 'the tracked file is unchanged');
  assert.deepEqual(dirtyCheckoutPaths(await readCoordinatorCheckout(root)), [], 'the checkout stays clean');
  // Its managed .graphyard state, the state beside its credential, a dispatch's worktree and the
  // host's processes (the loop's pid its commands judge) all stay reachable.
  const managed = inside(`mkdir -p .graphyard/master-actions && echo '{}' > .graphyard/master-actions/record.json && echo '{}' > ${outside}/coordinator.daemon.json`);
  assert.equal(managed.status, 0, managed.stderr);
  assert.ok(existsSync(join(root, '.graphyard', 'master-actions', 'record.json')) && existsSync(join(outside, 'coordinator.daemon.json')));
  const dispatch = inside(`git -C ${root} worktree add -q -b graphyard/gy-1-1 .graphyard/worktrees/GY-1-1 main && git -C ${root}/.graphyard/worktrees/GY-1-1 commit -q --allow-empty -m work`);
  assert.equal(dispatch.status, 0, dispatch.stderr);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the coordinator checkout did not move');
  assert.notEqual(inside(`kill -0 ${process.pid}`).status, 0, 'no host process is visible to signal');
  assert.equal(inside(`printenv ${masterConfinementVariable}`).stdout.trim(), 'master', 'the session knows it is confined');
  assert.ok(confinedMaster({ [masterConfinementVariable]: 'master' }) && !confinedMaster({}), 'and routes its master restart and master executors to loop requests');
  // Its admin commands that act on the host — the executors' restart through systemd, their host-pid
  // liveness — are routed to the loop, never run against the masked manager or its own PID namespace.
  const cliSource = readFileSync(join(import.meta.dirname, '..', 'src', 'cli', 'master.ts'), 'utf8');
  assert.match(cliSource, /\(id === 'restart' \|\| id === 'executors'\) && confinedMaster\(\) \? \[operationsCommand\]/, 'a confined master restart or executors goes only to the loop request');
  // Its `master restart` and `master executors` file requests beside the cursor, which the loop serves on the host.
  for (const path of [loopRestartRequestPath({ credentialFile: join(outside, 'coordinator.token') }), loopExecutorsRequestPath({ credentialFile: join(outside, 'coordinator.token') })]) {
    const filed = inside(`echo '{}' > ${path}`);
    assert.equal(filed.status, 0, filed.stderr);
  }
});

test('unit:master-session-confinement-refusal — a master launch that cannot carry the confinement is refused, never started unconfined', async () => {
  const base = await temporaryDirectory('master-refusal');
  const { root } = coordinator(base);
  for (const probe of [{ bwrap: null, platform: 'linux' }, { bwrap: 'bwrap', platform: 'darwin' }, { bwrap: 'bwrap', platform: 'linux', mountNamespaceWorks: false }])
    await assert.rejects(masterSessionConfinement('claude', root, probe), /Graphyard never starts a session unconfined.*The master session is refused rather than started with the checkout writable/s, `refused on ${JSON.stringify(probe)}`);
  // Through the launcher: the refusal comes before anything is typed into the pane.
  const typed: string[][] = [];
  const run = (_bin: string, args: string[]) => { typed.push(args); return '{}'; };
  await assert.rejects(startAgentSession('graphyard-master-project', 'cursor', 'w1V:pM1', ['--force', '--trust'], 'Run the master loop', run, { directory: root, coordinatorRoot: root, confinement: 'master', confinementProbe: { bwrap: null, platform: 'linux' } }),
    /bubblewrap \(bwrap\) is not installed.*master session is refused/s);
  assert.equal(typed.filter(args => args[0] === 'pane' && args[1] === 'run').length, 0, 'no runtime command reached the pane');
  // No production launch opts out of the confinement any more.
  for (const file of ['src/master/master-session.ts', 'src/master/harness.ts']) {
    const source = readFileSync(join(import.meta.dirname, '..', file), 'utf8');
    assert.ok(!source.includes('confinement: false') && source.includes("confinement: 'master'"), `${file} launches the master confined`);
  }
});

test('integration:standing-pane-writer-attribution — the dirty-checkout escalation names a standing pane working in the checkout as the suspected writer, with a remedy the installation runs', async () => {
  const base = await temporaryDirectory('writer-attribution');
  const { root } = coordinator(base);
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 2; // hotfix\n');
  const state = emptyDaemonState(config(base));
  const panes = [{ name: 'agy', pane_id: 'w1V:pHHY', cwd: root }, { name: 'graphyard-claude-1', pane_id: 'w1V:pW1', cwd: join(root, '.graphyard', 'worktrees', 'GY-1-1') }, { name: 'elsewhere', pane_id: 'w1V:pX', cwd: base }];
  const refusal = await guardFor(root, state, async () => panes).start(null);
  assert.ok(refusal);
  const escalation = state.actions['escalation:dirty-checkout'];
  assert.equal(escalation?.state, 'failed');
  assert.match(escalation!.detail, /Suspected writer — one standing session's pane still points at it: agy \(pane w1V:pHHY, cwd [^)]+\)/, 'the standing pane is named as the suspected writer');
  assert.ok(!escalation!.detail.includes('graphyard-claude-1') && !escalation!.detail.includes('w1V:pX'), 'managed worktrees and other directories are not suspects');
  assert.ok(escalation!.detail.includes(checkoutRestoreRemedy), 'the remedy the installation runs itself is named');
  assert.match(checkoutRestoreRemedy, /graphyard master checkout-restore REASON/);
});

test('unit:doctor-allowlist-checkout-restore — the doctor may run master checkout-restore, and still no checkout mutation of its own', () => {
  assert.ok(doctorSanctionedCommands.includes('checkout-restore') && piSanctioned.includes('checkout-restore'), 'both allowlists sanction it');
  const context = { cwd: '/srv/graphyard', cli: '/srv/graphyard/bin/graphyard.mjs' };
  assert.deepEqual(doctorCommandVerdict(`graphyard master checkout-restore "the loop refuses its dirty checkout"`, context).allow, true);
  const prose = doctorCommandVerdict(`node /srv/graphyard/bin/graphyard.mjs master checkout-restore 'the loop's checkout holds 6 dirty paths; save them'`, context);
  assert.equal(prose.allow, true, 'a reason with an apostrophe runs as one prose argument');
  assert.match(prose.command ?? '', /master checkout-restore 'the loop'\\''s checkout holds 6 dirty paths; save them'$/);
  for (const line of ['git -C /srv/graphyard stash push', 'git stash', 'git checkout -- src/loop.ts', 'systemctl --user restart graphyard-master'])
    assert.equal(doctorCommandVerdict(line, context).allow, false, `${line} stays refused`);
  assert.match(doctorPrompt({ repository: 'owner/project', cliPath: '/srv/graphyard/bin/graphyard.mjs' }, { items: [], faults: [] }), /escalation:dirty-checkout.*master checkout-restore/);
});

test('integration:checkout-restore-clears-guard — the restore saves every dirty path under a named ref, discards nothing, restarts the loop through its unit and ends the escalation', async () => {
  const base = await temporaryDirectory('checkout-restore');
  const { root, git } = coordinator(base);
  const head = git('rev-parse', 'HEAD');
  // The installation's shape: tracked hotfixes, a deleted file, new source, and scratch outside the source paths.
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 2; // hotfix\n');
  // A staged version and a different working version of the same path: both must survive.
  writeFileSync(join(root, 'Dockerfile'), 'FROM node:22\nRUN apt-get install -y curl\n');
  git('add', 'Dockerfile');
  writeFileSync(join(root, 'Dockerfile'), 'FROM node:22\nRUN apt-get install -y git\n');
  execFileSync('rm', [join(root, 'src', 'gone.ts')]);
  mkdirSync(join(root, 'src', 'fresh'));
  writeFileSync(join(root, 'src', 'fresh', 'patch.ts'), 'export const fresh = 1;\n');
  // Untracked scratch outside the source paths the guard reads: preserved and restored like the rest.
  writeFileSync(join(root, 'scratchpad.mjs'), '// scratch\n');
  mkdirSync(join(root, 'scratchpad')); writeFileSync(join(root, 'scratchpad', 'notes.md'), 'notes\n');
  // An ignored file inside that untracked directory: no dirty path, and never deleted with its neighbour.
  writeFileSync(join(root, 'scratchpad', 'cache.log'), 'ignored work\n');
  mkdirSync(join(root, 'src', 'fresh', 'deep'), { recursive: true }); writeFileSync(join(root, 'src', 'fresh', 'deep', 'more.ts'), 'export const more = 1;\n');
  const state = emptyDaemonState(config(base));
  const guard = guardFor(root, state);
  assert.ok(await guard.start(null), 'the dirty checkout is refused');
  assert.equal(state.actions['escalation:dirty-checkout']?.attempts, 1);
  // The doctor files the request beside the cursor; the loop carries it out.
  const file = checkoutRestoreRequestPath(config(base));
  assert.equal(file, join(base, 'coordinator.checkout-restore.json'));
  await fileCheckoutRestoreRequest(file, 'the loop refuses its dirty checkout', 'graphyard-operator-agent');
  // The suspected writer: a standing process working in the checkout. It is stopped for the restore
  // and continued after, so it can write nothing between the snapshot and the reset.
  const writer = spawn('sleep', ['60'], { cwd: root, stdio: 'ignore' });
  // A process already stopped by job control stays stopped: the restore never continues work it did not stop.
  const suspended = spawn('sleep', ['60'], { cwd: root, stdio: 'ignore' });
  const processState = (pid: number) => readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0];
  process.kill(suspended.pid!, 'SIGSTOP');
  for (let tries = 0; processState(suspended.pid!) !== 'T' && tries < 200; tries++) await new Promise(done => setTimeout(done, 5));
  let frozenDuring: { pids: number[]; stopped: number[]; states: string[]; dirtyAtThaw: number } | null = null;
  const quiesce = async (directory: string) => {
    const frozen = await freezeCheckoutWriters(directory);
    const states = frozen.pids.map(processState);
    return { thaw: () => { frozenDuring = { pids: frozen.pids, stopped: frozen.stopped, states, dirtyAtThaw: Number(spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim().length) }; frozen.thaw(); } };
  };
  const restarts: { pid: number }[] = [];
  let failRestart = true;
  const restart = (pid: number) => async () => { restarts.push({ pid }); if (failRestart) { failRestart = false; throw new Error('Failed to connect to bus'); } };
  let outcome;
  try {
    assert.deepEqual(checkoutWriterProcesses(root), [writer.pid!, suspended.pid!].sort((a, b) => a - b), 'the standing processes in the checkout are the suspected writers; this process is spared');
    outcome = await serveCheckoutRestore(file, root, { settle: () => guard.settle(), restart: restart(41), pid: 41, quiesce });
    assert.notEqual(processState(writer.pid!), 'T', 'the writer is continued after the restore');
    assert.equal(processState(suspended.pid!), 'T', 'the process stopped before the restore is left stopped');
  } finally { writer.kill('SIGKILL'); suspended.kill('SIGKILL'); }
  assert.equal(outcome?.state, 'restored', outcome?.detail);
  assert.deepEqual(frozenDuring, { pids: [writer.pid!, suspended.pid!].sort((a, b) => a - b), stopped: [writer.pid], states: ['T', 'T'], dirtyAtThaw: 0 }, 'both writers stood stopped through the whole restore, and only the one it stopped is continued');
  // The restart failed: recorded so, never as done, and asked again on the next pass until it lands.
  assert.equal(outcome!.restart?.state, 'failed');
  assert.equal((await readCheckoutRestoreRequest(file))?.outcome?.restart?.state, 'failed');
  assert.equal((await serveCheckoutRestore(file, root, { restart: restart(41), pid: 41 }))?.restart?.state, 'requested', 'the same loop asks again');
  assert.equal(await serveCheckoutRestore(file, root, { restart: restart(41), pid: 41 }), null, 'a restart already asked is not asked twice by the same loop');
  assert.equal((await serveCheckoutRestore(file, root, { restart: restart(42), pid: 42 }))?.restart?.state, 'done', 'the restarted loop records the restart done');
  assert.deepEqual(restarts, [{ pid: 41 }, { pid: 41 }], 'the loop restarts through its unit until it lands, and no restarted loop asks again');
  assert.ok(outcome!.ref!.startsWith(checkoutRestoreRefPrefix));
  assert.deepEqual(outcome!.paths.sort(), ['Dockerfile', 'scratchpad.mjs', 'scratchpad/notes.md', 'src/fresh/deep/more.ts', 'src/fresh/patch.ts', 'src/gone.ts', 'src/loop.ts'], 'every untracked file by its own path');
  // Clean, and nothing lost: the ref holds every byte, on top of the HEAD it was taken at.
  const checkout = await readCoordinatorCheckout(root);
  assert.deepEqual(dirtyCheckoutPaths(checkout), [], 'readCoordinatorCheckout reports an empty dirty set');
  assert.equal(checkout.commit, head, 'HEAD did not move');
  assert.equal(git('rev-parse', `${outcome!.ref}^`), head);
  assert.equal(git('show', `${outcome!.ref}:src/loop.ts`), 'export const loop = 2; // hotfix');
  assert.equal(git('show', `${outcome!.ref}:src/fresh/patch.ts`), 'export const fresh = 1;');
  assert.match(git('show', `${outcome!.ref}:Dockerfile`), /apt-get install -y git/, 'the working version is saved');
  assert.match(git('show', `${outcome!.ref}^2:Dockerfile`), /apt-get install -y curl/, 'and the staged version, as the index stood');
  assert.equal(git('rev-parse', `${outcome!.ref}^2^`), head);
  assert.notEqual(spawnSync('git', ['-C', root, 'cat-file', '-e', `${outcome!.ref}:src/gone.ts`]).status, 0, 'the deletion is recorded too');
  assert.equal(readFileSync(join(root, 'src', 'gone.ts'), 'utf8'), 'export const gone = 1;\n', 'the deleted file is back at HEAD');
  assert.equal(git('show', `${outcome!.ref}:scratchpad.mjs`), '// scratch', 'untracked scratch outside the source paths is preserved');
  assert.equal(git('show', `${outcome!.ref}:scratchpad/notes.md`), 'notes');
  assert.ok(!existsSync(join(root, 'scratchpad.mjs')) && !existsSync(join(root, 'scratchpad', 'notes.md')), 'and returned to HEAD with the rest');
  assert.equal(readFileSync(join(root, 'scratchpad', 'cache.log'), 'utf8'), 'ignored work\n', 'the ignored file beside it is never deleted');
  assert.ok(!existsSync(join(root, 'src', 'fresh')), 'a directory the restore emptied goes too');
  assert.equal(git('status', '--porcelain'), '', 'no non-ignored dirty path is left');
  assert.equal(git('stash', 'list'), '', 'the shared stash stack is untouched');
  // The escalation settled before the restart, and records no further failed attempt.
  assert.equal(state.actions['escalation:dirty-checkout']?.state, 'done');
  assert.equal(state.actions['escalation:dirty-checkout']?.attempts, 1);
  assert.equal((await guard.betweenCycles()).refusal, null);
  assert.equal(state.actions['escalation:dirty-checkout']?.state, 'done');
  // The request carries its outcome, and is served once.
  assert.equal((await readCheckoutRestoreRequest(file))?.outcome?.ref, outcome!.ref);
  assert.equal(await serveCheckoutRestore(file, root, { restart: restart(43), pid: 43 }), null);
  // A request on a clean checkout restores nothing and restarts nothing.
  await fileCheckoutRestoreRequest(file, 'check again', 'graphyard-operator-agent');
  assert.equal((await serveCheckoutRestore(file, root, { restart: restart(43), pid: 43 }))?.state, 'clean');
  assert.equal(restarts.length, 2);
  // The confined master's `master restart`: a request the loop serves by restarting through its unit.
  const restartFile = loopRestartRequestPath(config(base));
  await fileCheckoutRestoreRequest(restartFile, 'master restart from the confined master session', 'graphyard-master', new Date(), 'restart');
  assert.equal((await serveCheckoutRestore(restartFile, root, { restart: restart(43), pid: 43 }))?.state, 'restart');
  assert.deepEqual(restarts.at(-1), { pid: 43 });
});

test('integration:coordinator-serves-current-release — after a restore, a restarted loop on a newer commit serves it, with nothing refused', async () => {
  const base = await temporaryDirectory('restore-serves');
  const { root, git } = coordinator(base);
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 2; // hotfix\n');
  const state = emptyDaemonState(config(base));
  assert.ok(await guardFor(root, state).start(null));
  const file = checkoutRestoreRequestPath(config(base));
  await fileCheckoutRestoreRequest(file, 'restore', 'graphyard-master');
  assert.equal((await serveCheckoutRestore(file, root, { restart: async () => {} }))?.state, 'restored');
  // The merged release lands on the clean checkout (the self-upgrade the dirty tree refused), and
  // the loop the unit restarts loads it: its HEAD is the commit it serves, with nothing to refuse.
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 3; // merged\n');
  git('commit', '-q', '-am', 'merged release');
  const restarted = guardFor(root, state);
  assert.equal(await restarted.start(null), null);
  assert.equal(restarted.expected(), git('rev-parse', 'HEAD'));
  assert.equal(state.actions['escalation:dirty-checkout']?.state, 'done');
  // The command side: a request the loop does not answer in time is reported as filed.
  const pending = await checkoutRestoreCommand(config(base), ['restore', 'again'], 'graphyard-master', { waitMs: 20, pollMs: 5 });
  assert.equal(pending.state, 'requested');
  await assert.rejects(checkoutRestoreCommand(config(base), [], 'graphyard-master'), /Use master checkout-restore REASON/);
});

test('unit:checkout-restore-freeze-fails-closed — a writer that cannot be stopped, or does not show stopped, refuses the restore before anything is touched, and only what it stopped is continued', async () => {
  const states = new Map<number, string>([[11, 'S'], [12, 'S'], [13, 'T'], [14, 'S']]);
  const sent: string[] = [];
  const signal = (refuse: number[]) => (pid: number, name: NodeJS.Signals) => {
    sent.push(`${name}:${pid}`);
    if (refuse.includes(pid)) throw Object.assign(new Error(`kill EPERM ${pid}`), { code: 'EPERM' });
    states.set(pid, name === 'SIGSTOP' ? 'T' : 'S');
  };
  const state = (pid: number) => states.get(pid) ?? null;
  // Another user's process: SIGSTOP is refused, so the freeze throws and continues the one it had stopped.
  await assert.rejects(freezeCheckoutWriters('/checkout', { scan: () => [11, 12, 13], signal: signal([12]), state }), /writer pid 12 could not be stopped.*nothing was restored/);
  assert.deepEqual(sent, ['SIGSTOP:11', 'SIGSTOP:12', 'SIGCONT:11'], 'the stopped one is continued; the one stopped before is never signalled');
  assert.equal(states.get(13), 'T');
  // A process that takes the signal but never shows stopped (a ptrace stop elsewhere, an uninterruptible wait) refuses too.
  sent.length = 0; states.set(11, 'S');
  const stuck = (pid: number, name: NodeJS.Signals) => { sent.push(`${name}:${pid}`); };
  await assert.rejects(freezeCheckoutWriters('/checkout', { scan: () => [11], signal: stuck, state, settleMs: 30, pollMs: 5 }), /did not stop within 30ms/);
  assert.deepEqual(sent, ['SIGSTOP:11', 'SIGCONT:11']);
  // A writer that exits between the scan and the signal writes nothing more: it is no refusal.
  sent.length = 0;
  const exiting = (pid: number, name: NodeJS.Signals) => { sent.push(`${name}:${pid}`); if (pid === 14) { states.delete(14); throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }); } states.set(pid, name === 'SIGSTOP' ? 'T' : 'S'); };
  states.set(11, 'S');
  // One forked during the freeze is found on the next read and stopped too.
  let reads = 0;
  const frozen = await freezeCheckoutWriters('/checkout', { scan: () => ++reads === 1 ? [11, 14] : [11, 14, 15], signal: exiting, state: pid => pid === 15 ? (states.get(15) ?? 'R') : state(pid) });
  assert.deepEqual(frozen.stopped, [11, 15]);
  frozen.thaw();
  assert.deepEqual(sent, ['SIGSTOP:11', 'SIGSTOP:14', 'SIGSTOP:15', 'SIGCONT:11', 'SIGCONT:15']);
  // Through the restore: a freeze that fails leaves every dirty path where it was, and writes no ref.
  const base = await temporaryDirectory('freeze-fails-closed');
  const { root, git } = coordinator(base);
  writeFileSync(join(root, 'src', 'loop.ts'), 'export const loop = 2; // hotfix\n');
  writeFileSync(join(root, 'scratchpad.mjs'), '// scratch\n');
  await assert.rejects(restoreCoordinatorCheckout(root, 'restore', undefined, new Date(), () => { throw new Error('the checkout\'s writer pid 12 could not be stopped'); }), /could not be stopped/);
  assert.equal(readFileSync(join(root, 'src', 'loop.ts'), 'utf8'), 'export const loop = 2; // hotfix\n');
  assert.ok(existsSync(join(root, 'scratchpad.mjs')));
  assert.equal(git('for-each-ref', checkoutRestoreRefPrefix), '', 'no ref was written');
  // An untracked nested repository cannot be saved in the ref: refused, untouched.
  execFileSync('git', ['init', '-q', join(root, 'vendor')]); writeFileSync(join(root, 'vendor', 'local.txt'), 'nested work\n');
  execFileSync('git', ['-C', join(root, 'vendor'), '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '--allow-empty', '-m', 'nested']);
  await assert.rejects(restoreCoordinatorCheckout(root, 'restore', undefined, new Date(), () => ({ thaw: () => {} })), /untracked nested repositories \(vendor\/\).*nothing was restored/);
  assert.ok(existsSync(join(root, 'vendor', 'local.txt')) && existsSync(join(root, 'scratchpad.mjs')));
  assert.equal(git('for-each-ref', checkoutRestoreRefPrefix), '', 'no ref was written');
  // Writer discovery that cannot enumerate the process table is no empty writer set: the freeze refuses.
  assert.throws(() => checkoutWriterProcesses(root, process.pid, join(base, 'no-proc')), /cannot be enumerated.*nothing was restored/);
  mkdirSync(join(base, 'empty-proc'));
  assert.throws(() => checkoutWriterProcesses(root, process.pid, join(base, 'empty-proc')), /lists no process/);
  sent.length = 0;
  await assert.rejects(freezeCheckoutWriters(root, { scan: directory => checkoutWriterProcesses(directory, process.pid, join(base, 'no-proc')), signal: signal([]), state }), /cannot be enumerated/);
  assert.deepEqual(sent, [], 'nothing was signalled');
  assert.deepEqual(statusPaths(`R  new.ts\0old.ts\0?? scratch/\0 M src/a.ts\0`).sort(), ['new.ts', 'old.ts', 'scratch/', 'src/a.ts'], 'every status entry and rename origin is a restored path');
});

test('unit:confined-master-executors-through-loop — a confined master\'s master executors is a request the loop runs on the host, once, recording what it printed', async () => {
  const base = await temporaryDirectory('confined-executors');
  const { root } = coordinator(base);
  const settings = config(base);
  const ran: string[][] = [];
  const executors = async (args: string[]) => { ran.push(args); return args[0] === 'restart' ? { host: 'machine-a', result: 'refused', reason: 'an executor holds a claim' } : { host: 'machine-a', executors: [], lines: [] }; };
  const pending = checkoutRestoreCommand(settings, ['restart', '--timeout', '60'], 'graphyard-master', { act: 'executors', waitMs: 2_000, pollMs: 5 });
  const file = loopExecutorsRequestPath(settings);
  for (let tries = 0; !(await readCheckoutRestoreRequest(file)) && tries < 200; tries++) await new Promise(done => setTimeout(done, 5));
  assert.deepEqual((await readCheckoutRestoreRequest(file))?.args, ['restart', '--timeout', '60']);
  const restarts: number[] = [];
  const served = await serveLoopRequests(settings, root, { restart: async () => { restarts.push(1); }, pid: 41, executors });
  assert.equal(served.length, 1);
  assert.equal(served[0].state, 'executors');
  const answer = await pending;
  assert.deepEqual((answer as { result?: unknown }).result, { host: 'machine-a', result: 'refused', reason: 'an executor holds a claim' }, 'the command prints what the loop ran');
  assert.equal(process.exitCode, 1, 'a refused executor restart exits non-zero for the confined master too');
  process.exitCode = 0;
  assert.deepEqual(await serveLoopRequests(settings, root, { restart: async () => { restarts.push(1); }, pid: 42, executors }), [], 'served once, by no later loop either');
  assert.deepEqual(ran, [['restart', '--timeout', '60']]);
  assert.deepEqual(restarts, [], 'an executors request owes the loop no restart of its own');
  // A loop without the host command answers it failed rather than leaving it standing.
  await fileCheckoutRestoreRequest(file, 'master executors from the confined master session', 'graphyard-master', new Date(), 'executors', []);
  assert.equal((await serveLoopRequests(settings, root, { restart: async () => {}, pid: 43 }))[0]?.state, 'failed');
});
