import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { masterConfinementVariable, masterSessionConfinement, startAgentSession } from '../src/master/launch.js';
import { dirtyCheckoutPaths, readCoordinatorCheckout } from '../src/master/profiles.js';
import { hostProcessLaunchTargets, masterCredentialMask, peerTokenDirectory, preparePeerExchange, sessionMountNamespaceWorks } from '../src/master/confinement.js';
import { loopRestartRequestPath } from '../src/daemon/run.js';
import { confinedMaster } from '../src/cli/master/operations.js';
import { masterRecords } from '../src/master/conversation.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1658: the loop-launched master session ran with the coordinator checkout writable (it opted
// out of GY-888's confinement), and it and standing agent panes hotfixed the serving checkout until
// the GY-857 guard refused every loop start on it — with no remedy the installation could run
// itself. The master session now launches with the checkout read-only, and a launch that cannot be
// confined is refused.

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
  const outside = join(base, 'config'); mkdirSync(outside);
  const live = await masterSessionConfinement('claude', root, {}, [outside]);
  const inside = (script: string) => spawnSync(live.wrapper[0], [...live.wrapper.slice(1), 'bash', '-c', script], { cwd: root, encoding: 'utf8' });
  // The scripted hotfix of a tracked path fails at the OS level, by every route.
  for (const script of ['echo hotfix >> src/loop.ts', 'sed -i s/1/2/ src/loop.ts', 'cp Dockerfile src/loop.ts', `git -C ${root} commit -q --allow-empty -m hotfix`, `git -C ${root} stash push -q`, 'rm src/gone.ts',
    `echo hotfix >> /proc/1/root${root}/src/loop.ts`, `echo hotfix >> /proc/${process.pid}/root${root}/src/loop.ts`,
    `systemd-run --user --quiet --wait sh -c 'echo hotfix >> ${root}/src/loop.ts'`, `systemctl --user show-environment`])
    assert.notEqual(inside(script).status, 0, `the master session cannot run: ${script}`);
  assert.equal(readFileSync(join(root, 'src', 'loop.ts'), 'utf8'), 'export const loop = 1;\n', 'the tracked file is unchanged');
  assert.deepEqual(dirtyCheckoutPaths(await readCoordinatorCheckout(root)), [], 'the checkout stays clean');
  // The loop owns conversation evidence even though its parent managed state is writable.
  const record = join(masterRecords(root), 'conversation.jsonl');
  writeFileSync(record, 'original\n');
  assert.notEqual(inside(`echo forged > ${record}`).status, 0, 'conversation records stay read-only');
  assert.notEqual(inside(`rm ${record}`).status, 0, 'conversation records cannot be deleted');
  assert.equal(readFileSync(record, 'utf8'), 'original\n');
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
  assert.ok(confinedMaster({ [masterConfinementVariable]: 'master' }) && !confinedMaster({}), 'and routes its master restart to a loop request');
  // Its restart acts on the host through systemd, so it is routed to the loop, never run against the masked manager.
  const cliSource = readFileSync(join(import.meta.dirname, '..', 'src', 'cli', 'master.ts'), 'utf8');
  assert.match(cliSource, /id === 'restart' && confinedMaster\(\) \? \[operationsCommand\]/, 'a confined master restart goes only to the loop request');
  // Its `master restart` files a request beside the cursor, which the loop serves on the host.
  for (const path of [loopRestartRequestPath({ credentialFile: join(outside, 'coordinator.token') })]) {
    const filed = inside(`echo '{}' > ${path}`);
    assert.equal(filed.status, 0, filed.stderr);
  }
});

test('unit:master-session-peer-grant — a recorded peer\'s token directory is granted writable while its install and an unpeered one stay masked', async () => {
  const base = await temporaryDirectory('master-peer-grant');
  const { root } = coordinator(base);
  // Two installs under one config home beside an unrelated third: this one's credential, a peer's
  // directory holding the token this Master placed for it, and one no configuration names.
  const configHome = join(base, 'config'), mine = join(configHome, 'a-install'), theirs = join(configHome, 'b-install');
  mkdirSync(join(mine, 'masters'), { recursive: true });
  const credentialFile = join(mine, 'masters', `${'x'.repeat(20)}.token`);
  writeFileSync(credentialFile, 't'.repeat(40), { mode: 0o600 });
  mkdirSync(join(theirs, 'masters'), { recursive: true });
  mkdirSync(join(configHome, 'c-install'), { recursive: true });
  const config = { credentialFile, peers: [{ name: 'b-install', url: 'http://127.0.0.1:4310', tokenFile: join(peerTokenDirectory(mine), 'b-install.token'), configDirectory: theirs }] };
  // The launch's preparation creates each side's peers directory and returns the peer's to grant.
  assert.deepEqual(preparePeerExchange(config), [peerTokenDirectory(theirs)]);
  assert.ok(existsSync(peerTokenDirectory(theirs)) && existsSync(peerTokenDirectory(mine)), 'both installs\' peers directories exist before the confinement binds them');
  const confinement = await masterSessionConfinement('claude', root, { bwrap: 'bwrap', platform: 'linux', mountNamespaceWorks: true },
    [join(mine, 'masters'), peerTokenDirectory(theirs)], undefined, masterCredentialMask(config, [], configHome));
  const words = confinement.wrapper;
  const granted = words.indexOf(peerTokenDirectory(theirs));
  assert.ok(granted > 0 && words[granted - 1] === '--bind', 'the peer\'s token directory is bound writable');
  const masked = words.findIndex((word, index) => word === '--tmpfs' && words[index + 1] === theirs);
  assert.ok(masked > 0 && masked < granted, 'the peer\'s install directory stays masked — its credentials unreadable — and only its peers directory is bound in after the mask');
  assert.ok(words.some((word, index) => word === '--tmpfs' && words[index + 1] === join(configHome, 'c-install')), 'an install no configuration names stays masked');
  // Without the peer recorded, its directory is neither granted nor readable: the session that
  // first records the peer places nothing and names the rerun (GY-3385).
  const before = await masterSessionConfinement('claude', root, { bwrap: 'bwrap', platform: 'linux', mountNamespaceWorks: true },
    [join(mine, 'masters')], undefined, masterCredentialMask({ credentialFile }, [], configHome));
  assert.ok(!before.wrapper.includes(peerTokenDirectory(theirs)), 'an unrecorded peer\'s directory is not granted');
  assert.ok(before.wrapper.some((word, index) => word === '--tmpfs' && before.wrapper[index + 1] === theirs), 'an unrecorded peer\'s install directory stays masked');
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
