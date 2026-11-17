import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readlinkSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installLauncherPath, publishCliRelease, resolvedLauncher, writeInstallLauncher } from '../src/install/cli-release.js';
import { installLoopSupervisor } from '../src/install/loop-unit.js';
import { systemdCommandLineWords } from '../src/install/units.js';
import { restartMasterLoop, type LockRefusal } from '../src/master/loop-restart.js';
import { setupFromZeroChecks } from '../src/setup-from-zero.js';
import type { MasterConfig } from '../src/master/profiles.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3337: the loop systemd unit always runs the current release, and master restart goes through
// it. The unit's ExecStart names the install's one stable launcher (`<installDir>/bin/graphyard.mjs`,
// a symlink to the published release's own launcher), written by the install and by every
// publication — so an upgrade moves what the unit runs and no hand rewrite is ever needed. Master
// restart restarts the unit whenever it is this install's supervisor, runs detached only where no
// systemd user manager answers, and stops a unit it must pass over before starting a detached loop,
// so the unit's Restart=always cannot crash-loop beside it. Doctor names the unit and the fix for an
// ExecStart that resolves to an old release or another install's, and for a loop crash-looping on
// the master lock.

const repository = 'owner/project';
const releasePath = (installDir: string, sha: string) => join(installDir, 'deploy', 'build', '.graphyard', 'cli-releases', sha);
const releaseTree = async (installDir: string, sha: string) => {
  const tree = releasePath(installDir, sha);
  await mkdir(join(tree, 'bin'), { recursive: true });
  await mkdir(join(tree, '.graphyard'), { recursive: true });
  await writeFile(join(tree, 'bin', 'graphyard.mjs'), '#!/usr/bin/env node\n');
  return tree;
};
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('unit:loop-unit-runs-current-release — the unit names the install\'s stable launcher and an upgrade moves what it runs without rewriting the unit; master restart goes through the unit, stops a unit it passes over, runs detached with no user manager; doctor names the unit and its fix', async () => {
  const home = await temporaryDirectory('loop-unit-release-home'), root = await temporaryDirectory('loop-unit-release-checkout');
  const configHome = join(home, 'graphyard'), installDir = join(configHome, 'owner-project');
  try {
    execFileSync('git', ['init', '-q', root]);
    await mkdir(join(root, '.graphyard'), { recursive: true });
    await writeFile(join(root, '.graphyard', 'master.json'), JSON.stringify({ repository }));
    const launched = join(root, 'launched.txt'), cliPath = join(root, 'cli.mjs');
    await writeFile(cliPath, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(launched)}, process.argv.slice(2).join(' '));\n`);
    const config = { hostId: 'this-host', cliPath, repository, installDir, run: { intervalSeconds: 20 } } as unknown as MasterConfig;
    // The deploy watch's source checkout, and the install's deploy/build, both holding a launcher
    // the publication rewrites onto the pointer protocol.
    const source = join(home, 'watch-checkout');
    for (const directory of [source, join(installDir, 'deploy', 'build')]) {
      await mkdir(join(directory, 'bin'), { recursive: true });
      await writeFile(join(directory, 'bin', 'graphyard.mjs'), '#!/usr/bin/env node\n');
    }
    const a = await releaseTree(installDir, 'a'.repeat(40)), b = await releaseTree(installDir, 'b'.repeat(40));

    // The first publication: the install's stable launcher comes to exist with it.
    await publishCliRelease(installDir, source, 'a'.repeat(40));
    assert.ok(existsSync(installLauncherPath(installDir)), 'every publication writes the install\'s stable launcher');
    assert.equal(resolvedLauncher(installLauncherPath(installDir)), join(a, 'bin', 'graphyard.mjs'));

    // master init installs the unit naming that launcher, never the CLI that happened to run it.
    const calls: string[][] = [];
    const host = { home, temporaryDirectories: [join(home, 'volatile')], run: (command: string, args: string[]) => { calls.push([command, ...args]); return ''; } };
    const input = { root, cliPath, repository, intervalSeconds: 20, execPath: '/usr/bin/node', installDir };
    const installed = await installLoopSupervisor(input, host);
    assert.equal(installed.wrote, 'created');
    const unit = JSON.parse(await readFile(join(root, '.graphyard', 'units.json'), 'utf8')).master as string;
    const unitPath = join(home, '.config', 'systemd', 'user', unit);
    const unitText = await readFile(unitPath, 'utf8');
    assert.match(unitText, new RegExp(`^ExecStart=/usr/bin/node ${escape(installLauncherPath(installDir))} master run$`, 'm'), 'the unit names the install\'s one stable launcher');
    const unitLauncher = () => systemdCommandLineWords(/^ExecStart=(.+)$/m.exec(unitText)![1])[1]!;

    // The upgrade: a new release is published, the unit is not rewritten by hand, and its ExecStart
    // resolves to the new release.
    await publishCliRelease(installDir, source, 'b'.repeat(40));
    assert.equal(await readFile(unitPath, 'utf8'), unitText, 'the unit file is untouched by the publication');
    assert.equal(resolvedLauncher(unitLauncher()), join(b, 'bin', 'graphyard.mjs'), 'the unrewritten ExecStart resolves to the new release');

    // Master restart with the unit present restarts the unit and starts no detached loop.
    const manager = (spec: { directory?: string; launcher?: string; reachable?: boolean } = {}) => {
      const given: string[][] = [];
      let mainPid = 4242;
      const systemctl = async (args: string[]) => {
        given.push(args);
        if (spec.reachable === false) throw new Error('Failed to connect to bus: No medium found');
        if (args[0] === 'restart') { mainPid = 5151; return ''; }
        if (args[0] !== 'show') return '';
        return `LoadState=loaded\nActiveState=active\nMainPID=${mainPid}\nWorkingDirectory=${spec.directory ?? root}\nExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node ${spec.launcher ?? installLauncherPath(installDir)} master run ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }\n`;
      };
      return { given, systemctl };
    };
    const through = manager();
    const restarted = await restartMasterLoop(root, config, null, { systemctl: through.systemctl, host: { home }, platform: 'linux' });
    assert.equal(restarted.supervisor, unit);
    assert.ok(through.given.some(args => args.join(' ') === `restart ${unit}`), 'the restart goes through the unit');
    await new Promise(done => setTimeout(done, 300));
    assert.equal(existsSync(launched), false, 'no detached master run is started beside the unit');

    // With no systemd user manager at all there is no unit to go through: the detached loop stands.
    const bare = await temporaryDirectory('loop-unit-release-bare');
    execFileSync('git', ['init', '-q', bare]);
    await mkdir(join(bare, '.graphyard'), { recursive: true });
    await writeFile(join(bare, '.graphyard', 'master.json'), JSON.stringify({ repository }));
    const detachedCli = join(bare, 'cli.mjs'), detachedLaunched = join(bare, 'launched.txt');
    await writeFile(detachedCli, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(detachedLaunched)}, process.argv.slice(2).join(' '));\n`);
    const none = manager({ reachable: false });
    const detached = await restartMasterLoop(bare, { ...config, cliPath: detachedCli } as MasterConfig, null, { systemctl: none.systemctl, host: { home }, platform: 'linux' });
    assert.equal(detached.supervisor, null);
    assert.ok(detached.log, 'the detached restart logs beside the config');
    for (let attempt = 0; attempt < 50 && !existsSync(detachedLaunched); attempt++) await new Promise(done => setTimeout(done, 100));
    assert.equal(await readFile(detachedLaunched, 'utf8'), 'master run');

    // A unit present whose ExecStart runs another install's CLI is stopped before the detached loop,
    // never restarted, and the mismatch names the rewrite that fixes it.
    const other = join(configHome, 'other-project');
    const c = await releaseTree(other, 'c'.repeat(40));
    await publishCliRelease(other, source, 'c'.repeat(40));
    const foreign = manager({ launcher: join(c, 'bin', 'graphyard.mjs') });
    const mismatched = await restartMasterLoop(root, config, null, { systemctl: foreign.systemctl, host: { home }, platform: 'linux' });
    assert.equal(mismatched.supervisor, null);
    assert.ok(!foreign.given.some(args => args[0] === 'restart'), 'the unit running another install\'s CLI is never restarted');
    assert.ok(foreign.given.some(args => args.join(' ') === `stop ${unit}`), 'the unit is stopped before the detached loop starts');
    assert.match(mismatched.mismatch ?? '', new RegExp(`^${unit} was not restarted: .*not this install's`));
    assert.match(mismatched.mismatch ?? '', /master init --token-stdin --replace-supervisor/);
    for (let attempt = 0; attempt < 50 && !existsSync(launched); attempt++) await new Promise(done => setTimeout(done, 100));
    assert.equal(await readFile(launched, 'utf8'), 'master run', 'the fallback starts this install\'s loop detached');

    // Doctor names the unit and the fix when its ExecStart resolves to an old release or another
    // install's, reports nothing against the launcher the install wrote, and names a loop
    // crash-looping on the master lock.
    const doctor = async (lockRefusal?: LockRefusal | null) => {
      const lines = await setupFromZeroChecks({ root, env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GRAPHYARD_CONFIG_HOME: configHome }, status: null, reachable: true,
        environments: join(home, 'agents'), sandbox: () => null, trialSandbox: () => null, systemctl: async () => '',
        ...(lockRefusal === undefined ? {} : { lockRefusal }) });
      return lines.filter(line => line.id === 'loop-unit-release' || line.id === 'loop-lock');
    };
    const writeUnit = async (launcher: string) => { await writeFile(unitPath, unitText.replace(/^ExecStart=.+$/m, `ExecStart=/usr/bin/node ${launcher} master run`)); };
    await writeUnit(join(c, 'bin', 'graphyard.mjs'));
    let lines = await doctor();
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.status, 'fail');
    assert.ok(lines[0]!.detail.includes(unit), `the fault names the unit: ${lines[0]!.detail}`);
    assert.match(lines[0]!.detail, /another install/);
    assert.match(lines[0]!.step, /master init --token-stdin --replace-supervisor/);

    await writeUnit(join(a, 'bin', 'graphyard.mjs'));
    lines = await doctor();
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.status, 'fail');
    assert.ok(lines[0]!.detail.includes(unit));
    assert.match(lines[0]!.detail, new RegExp(`names the release ${'a'.repeat(12)}`));
    assert.match(lines[0]!.detail, /not the release this install serves/);
    assert.match(lines[0]!.step, /master init --token-stdin --replace-supervisor/);

    await writeFile(unitPath, unitText);
    lines = await doctor();
    assert.deepEqual(lines.map(line => line.status), ['pass'], `the install's own launcher holds no fault: ${JSON.stringify(lines)}`);
    assert.ok(lines[0]!.detail.includes(unit));

    const crash = { holder: { pid: 4242, host: 'this-host', startedAt: null }, refusedAt: new Date().toISOString(), count: 3 };
    lines = await doctor(crash);
    assert.equal(lines.length, 2);
    const lock = lines.find(line => line.id === 'loop-lock')!;
    assert.equal(lock.status, 'fail');
    assert.match(lock.detail, /crash-looping on the lock pid 4242/);
    assert.match(lock.step, /master restart/);
    lines = await doctor({ ...crash, count: 1 });
    assert.equal(lines.filter(line => line.id === 'loop-lock').length, 0, 'a single refusal is not a crash loop');
    await rm(bare, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('unit:install-launcher-written-by-install — the launcher is written beside the unit whenever a release is published, and only then', async () => {
  const home = await temporaryDirectory('loop-unit-launcher-home');
  try {
    const installDir = join(home, 'graphyard', 'owner-project');
    assert.equal(await writeInstallLauncher(installDir), null, 'nothing is written while no release is published');
    assert.equal(existsSync(installLauncherPath(installDir)), false);
    const source = join(home, 'watch-checkout');
    await mkdir(join(source, 'bin'), { recursive: true });
    await writeFile(join(source, 'bin', 'graphyard.mjs'), '#!/usr/bin/env node\n');
    await releaseTree(installDir, 'a'.repeat(40));
    await publishCliRelease(installDir, source, 'a'.repeat(40));
    assert.equal(await writeInstallLauncher(installDir), installLauncherPath(installDir), 'the install writes the same launcher the publication did');
    assert.equal(readlinkSync(installLauncherPath(installDir)), join('..', 'deploy', 'build', '.graphyard', 'cli-published', 'bin', 'graphyard.mjs'));
  } finally { await rm(home, { recursive: true, force: true }); }
});
