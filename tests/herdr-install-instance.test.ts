import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UpDependencies, UpEvent, UpHerdr, UpRequest } from '../src/up.js';
import type { HerdrHostDeps, HerdrInstance } from '../src/master/herdr.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1511: every Graphyard install shows its agents in Herdr. A second install on a host, whose
 * default Herdr plugin another install's server holds, gets its own Herdr instance (its own
 * XDG_CONFIG_HOME and session); every herdr call it makes goes there through one helper; and up sets
 * Herdr up from scratch on every run. One case per proof: unit:herdr-install-instance-created,
 * unit:herdr-calls-target-install-instance, unit:herdr-attach-command-shown,
 * unit:up-sets-up-herdr-from-scratch and unit:setup-page-herdr-connect-instructions.
 */
const herdr = () => import('../src/master/herdr.js');
const up = () => import('../src/up.js');
const SERVER = 'http://127.0.0.1:4310';
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const src = fileURLToPath(new URL('../src/', import.meta.url));

/** A host where every setup step is already green, so a run is only its Herdr handling and the install's arguments. */
function upWorld(options: { herdrElsewhere: boolean; herdrOnly?: () => { code: number; stdout: string } }) {
  const calls: string[][] = [];
  const green = { github: true, githubRepository: 'acme/shop', appPermissions: { missing: [] }, reviewerApps: [{ id: 'claude', appId: 9 }],
    fleet: { roles: [{ role: 'worker', accounts: ['claude-a'] }, { role: 'reviewer', accounts: ['claude-a'] }], accounts: [{ name: 'claude-a', enabled: true, loggedIn: true, smoke: { result: 'pass' } }] },
    setup: { protection: 'checks', loop: true } };
  const deps = (root: string, events: UpEvent[], herdrHost?: UpHerdr): UpDependencies => {
    let clock = 0;
    return {
      root, pollMs: 1, emit: event => { events.push(event); }, now: () => clock, sleep: async ms => { clock += ms; },
      serverUrl: async () => SERVER, masterToken: async () => 'm'.repeat(40), operatorToken: async () => 'a'.repeat(40), signIn: async () => null,
      status: async () => green, publishOnboarding: async () => null, onboardingMerged: async () => true,
      async cli(args) {
        calls.push(args);
        if (args[0] === 'install' && args.includes('--plan')) return { code: 0, stdout: JSON.stringify({ preflight: [{ name: 'GitHub CLI', ok: true },
          ...(options.herdrElsewhere && !args.includes('--herdr-instance') && !args.includes('--no-herdr') ? [{ name: 'Herdr plugin', ok: false, detail: 'bound to https://other.example' }] : [])] }) };
        if (args[0] === 'install' && args.includes('--herdr-only')) return options.herdrOnly?.() ?? { code: 1, stdout: '', stderr: 'unexpected --herdr-only' };
        return { code: 0, stdout: '{}' };
      },
      ...(herdrHost ? { herdr: herdrHost } : {}),
    };
  };
  return { calls, deps };
}
const request: UpRequest = { repository: 'acme/shop', provider: 'compose', agent: false, reviewer: 'claude', master: 'claude', goalFile: null, browserProfile: null };

/** Herdr on a simulated host for up: what each step was asked, and what it did. */
function fakeHerdrHost(state: { binary: boolean; running: Set<string>; plugin?: () => string | null; enabled?: () => boolean; enable?: () => Promise<void> }) {
  const log: { step: string; instance?: HerdrInstance | null; workspace?: string | null }[] = [];
  const host: UpHerdr = {
    binary: async () => { log.push({ step: 'binary' }); const installed = !state.binary; state.binary = true; return { binary: '/home/op/.local/bin/herdr', installed }; },
    server: async (_binary, instance) => {
      const key = instance?.session ?? 'default', started = !state.running.has(key);
      state.running.add(key); log.push({ step: 'server', instance });
      return { started, unit: started ? `graphyard-herdr${instance ? '-acme-shop' : ''}.service` : null, workspace: instance ? 'w9' : null };
    },
    record: async (instance, workspace) => { log.push({ step: 'record', instance, workspace }); },
    // The plugin the install linked: bound to this install's server unless the state says otherwise.
    plugin: async () => { const url = state.plugin ? state.plugin() : SERVER; return url ? { url, enabled: state.enabled?.() ?? true } : null; },
    enable: async instance => { log.push({ step: 'enable', instance }); await state.enable?.(); },
  };
  return { host, log };
}

test('unit:herdr-install-instance-created — a host whose default Herdr plugin another server holds gets this install its own instance, plugin linked there for its server, its server started and recorded in master.json, the default instance untouched; a free default stays as today', async () => {
  const { installHerdrInstance, targetHerdr } = await herdr();
  const { runUp } = await up();
  const { setupRepository } = await import('../src/repository-setup.js');
  const { recordHerdrInstance, loadStoredMasterConfig } = await import('../src/master/config.js');
  const instance = installHerdrInstance('acme-shop', '/home/op');
  assert.deepEqual(instance, { configHome: '/home/op/.config/graphyard/acme-shop/herdr', session: 'graphyard-acme-shop' });

  // up, default bound elsewhere: the install runs with --herdr-instance (never --herdr-rebind or --no-herdr),
  // the instance's server is set up, and the instance is recorded with its workspace.
  const elsewhere = upWorld({ herdrElsewhere: true });
  const root = await temporaryDirectory('herdr-instance-up');
  const events: UpEvent[] = [];
  const host = fakeHerdrHost({ binary: true, running: new Set(['default']) });
  const result = await runUp(request, elsewhere.deps(root, events, host.host));
  assert.equal(result.exitCode, 0, result.next);
  const own = installHerdrInstance('acme-shop');
  const applies = elsewhere.calls.filter(args => args[0] === 'install' && args.includes('--apply'));
  assert.ok(applies.length && applies.every(args => args.includes('--herdr-instance')), 'the install links the plugin in its own instance');
  assert.ok(!elsewhere.calls.flat().some(arg => arg === '--herdr-rebind' || arg === '--no-herdr'), 'the default instance is never rebound and Herdr is never skipped');
  assert.deepEqual(host.log.filter(entry => entry.step !== 'binary'), [{ step: 'server', instance: own }, { step: 'record', instance: own, workspace: 'w9' }]);
  assert.ok(events.some(event => event.kind === 'note' && event.text.includes(`own Herdr instance (session ${own.session})`)));
  assert.equal(JSON.parse(await readFile(join(root, '.graphyard/up.json'), 'utf8')).herdrInstance, true, 'the choice is kept for reruns');

  // up, default free: no instance, the default server is set up, nothing is recorded, the install runs as today.
  const free = upWorld({ herdrElsewhere: false });
  const freeRoot = await temporaryDirectory('herdr-instance-free');
  const freeHost = fakeHerdrHost({ binary: true, running: new Set(['default']) });
  assert.equal((await runUp(request, free.deps(freeRoot, [], freeHost.host))).exitCode, 0);
  assert.ok(free.calls.filter(args => args[0] === 'install').every(args => !args.includes('--herdr-instance') && !args.includes('--no-herdr')));
  assert.deepEqual(freeHost.log.filter(entry => entry.step !== 'binary'), [{ step: 'server', instance: null }]);

  // The install's repository setup links and enables the plugin in the instance, for this install's
  // server, through a real herdr spawn (a fake binary on PATH), and writes nothing in the default config.
  const scratch = await temporaryDirectory('herdr-instance-link');
  const bin = join(scratch, 'bin'), log = join(scratch, 'herdr.log'), repo = join(scratch, 'repo'), home = join(scratch, 'home');
  const previous = { PATH: process.env.PATH, HERDR_LOG: process.env.HERDR_LOG };
  try {
    await mkdir(bin, { recursive: true }); await mkdir(repo, { recursive: true });
    await writeFile(join(bin, 'herdr'), `#!/bin/sh\necho "XDG=$XDG_CONFIG_HOME ARGS=$*" >> "$HERDR_LOG"\n[ "$1" = "--session" ] && shift 2\n[ "$1 $2" = "plugin config-dir" ] && echo "$XDG_CONFIG_HOME/herdr/plugins/config/graphyard"\nexit 0\n`);
    await chmod(join(bin, 'herdr'), 0o755);
    process.env.PATH = `${bin}${delimiter}${process.env.PATH}`; process.env.HERDR_LOG = log;
    execFileSync('git', ['init', '-q', repo]); execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/shop.git'], { cwd: repo });
    const scoped = installHerdrInstance('acme-shop', home);
    const fetcher = (async () => new Response(JSON.stringify({ actor: { id: 'worker-a', role: 'worker' }, repository: 'acme/shop' }))) as unknown as typeof fetch;
    const linked = await setupRepository(repo, { url: 'https://new.example', cliPath: launcher, hostId: 'host', token: 'worker-token-0123456789abcdef0123456789' }, { herdr: true, herdrInstance: scoped, fetcher, executors: false });
    assert.equal(linked.pluginConfigured, true);
    const lines = (await readFile(log, 'utf8')).trim().split('\n');
    assert.ok(lines.every(line => line.startsWith(`XDG=${scoped.configHome} ARGS=--session ${scoped.session} `)), lines.join('\n'));
    for (const step of ['plugin link', 'plugin config-dir graphyard', 'plugin enable graphyard']) assert.ok(lines.some(line => line.includes(`ARGS=--session ${scoped.session} ${step}`)), step);
    assert.equal(JSON.parse(await readFile(join(scoped.configHome, 'herdr/plugins/config/graphyard/config.json'), 'utf8')).url, 'https://new.example');
    await assert.rejects(readdir(join(home, '.config/herdr')), 'nothing is written in the default instance\'s config');

    // master.json records the instance and its workspace; loading it targets every herdr call there.
    const credentials = join(scratch, 'credentials'); await mkdir(credentials, { recursive: true });
    await writeFile(join(credentials, 'master.token'), 'c'.repeat(40), { mode: 0o600 });
    await mkdir(join(repo, '.graphyard'), { recursive: true });
    await writeFile(join(repo, '.graphyard/master.json'), JSON.stringify({ version: 1, url: 'https://new.example', credentialFile: join(credentials, 'master.token'), cliPath: launcher, repository: 'acme/shop', baseBranch: 'main', githubAppId: 7, hostId: 'host', masterAgentName: 'graphyard-master-shop', workers: [] }), { mode: 0o600 });
    assert.equal(await recordHerdrInstance(repo, scoped, 'w9'), true);
    assert.equal(await recordHerdrInstance(repo, scoped, 'w9'), false, 'a rerun changes nothing');
    const loaded = await loadStoredMasterConfig(repo);
    assert.deepEqual(loaded.herdrInstance, scoped); assert.equal(loaded.herdrWorkspace, 'w9');
    const { herdrTarget } = await herdr();
    assert.deepEqual(herdrTarget(), scoped);
  } finally {
    process.env.PATH = previous.PATH;
    if (previous.HERDR_LOG === undefined) delete process.env.HERDR_LOG; else process.env.HERDR_LOG = previous.HERDR_LOG;
    targetHerdr(null);
    await rm(scratch, { recursive: true, force: true });
  }
});

/** A self-contained host install (GY-717) through the install harness, with the host's files seeded first. */
async function hostInstall(seed: Map<string, { content: string; mode: number }>, extraResponses: { match: string; result: any }[] = []) {
  const { harness } = await import('./install-harness.js');
  const { applyInstall, buildPlan, prepareInstall } = await import('../src/install/index.js');
  const fixture = await harness({ provider: 'host', serverUrl: 'https://graphyard.example.test', hostFiles: seed, extraResponses });
  const inputs = { repository: 'owner/project', provider: 'host' as const, selfContained: true, sshHost: '203.0.113.20', sshUser: 'root', domain: 'graphyard.example.test' };
  const session = await prepareInstall(fixture.root, inputs, fixture.deps);
  const summary = await applyInstall(session, await buildPlan(session));
  const lines = () => [...fixture.remotes.values()][0].commands.map(command => [command.program, ...command.args].join(' '));
  return { fixture, session, summary, lines, inputs };
}
const hostPlugin = (configHome: string) => `${configHome}/herdr/plugins/config/graphyard/config.json`;
const hostMaster = '/home/graphyard/code/owner-project/.graphyard/master.json';

test('unit:herdr-install-instance-created — a self-contained host whose default Herdr plugin another install holds gets this install its own instance there: its unit and server, the plugin linked for this server, its workspace, and master.json recording it; a free default is linked in place', async () => {
  const { installHerdrInstance } = await herdr();
  const own = installHerdrInstance('owner-project', '/home/graphyard');
  const elsewhere = JSON.stringify({ url: 'https://other.example', token: 'other-token' });
  const seed = new Map([[hostPlugin('/home/graphyard/.config'), { content: elsewhere, mode: 0o600 }], [hostMaster, { content: JSON.stringify({ version: 1, herdrWorkspace: 'old' }), mode: 0o600 }]]);
  const bound = await hostInstall(seed);
  try {
    const files = bound.fixture.hostFiles, lines = bound.lines();
    const unit = files.get('/home/graphyard/.config/systemd/user/graphyard-herdr-owner-project.service')!;
    assert.match(unit.content, new RegExp(`^Environment=XDG_CONFIG_HOME=${own.configHome}$`, 'm'));
    assert.match(unit.content, /^ExecStart=\/home\/graphyard\/\.local\/bin\/herdr --session graphyard-owner-project server$/m);
    assert.ok(lines.some(line => line.endsWith('systemctl --user enable --now graphyard-herdr-owner-project.service')), 'its server is started');
    for (const step of ['plugin link /home/graphyard/graphyard --disabled', 'plugin enable graphyard', 'workspace create --cwd /home/graphyard/code/owner-project --label graphyard-owner-project --no-focus'])
      assert.ok(lines.some(line => line.endsWith(`herdr --session ${own.session} ${step}`)), step);
    const linked = JSON.parse(files.get(hostPlugin(own.configHome))!.content);
    assert.equal(linked.url, 'https://graphyard.example.test'); assert.equal(files.get(hostPlugin(own.configHome))!.mode, 0o600);
    assert.equal(files.get(hostPlugin('/home/graphyard/.config'))!.content, elsewhere, 'the default instance\'s plugin is not touched');
    assert.ok(!lines.some(line => /\/herdr plugin (link|enable)/.test(line)), 'nothing is linked or enabled in the default instance');
    const master = JSON.parse(files.get(hostMaster)!.content);
    assert.deepEqual(master.herdrInstance, own); assert.equal(master.herdrWorkspace, 'w1');
    assert.equal(bound.summary.host!.herdr!.instance!.session, own.session);
    assert.ok(bound.summary.host!.units.some(entry => entry.name === 'graphyard-herdr-owner-project.service'), 'the instance\'s unit is reported');
    assert.match(bound.summary.profiles!.repository.detail, /own Herdr instance \(session graphyard-owner-project\)/);
  } finally { await bound.fixture.cleanup(); }

  // A free default: linked and enabled there for this install's server, no instance and no unit of its own.
  const free = await hostInstall(new Map([[hostMaster, { content: JSON.stringify({ version: 1 }), mode: 0o600 }]]));
  try {
    const files = free.fixture.hostFiles, lines = free.lines();
    assert.equal(JSON.parse(files.get(hostPlugin('/home/graphyard/.config'))!.content).url, 'https://graphyard.example.test');
    assert.ok(lines.some(line => line.endsWith('/home/graphyard/.local/bin/herdr plugin enable graphyard')));
    assert.ok(!lines.some(line => line.includes('--session')), 'no instance');
    assert.ok(!files.has('/home/graphyard/.config/systemd/user/graphyard-herdr-owner-project.service'));
    assert.equal(JSON.parse(files.get(hostMaster)!.content).herdrInstance, undefined);
  } finally { await free.fixture.cleanup(); }
});

test('unit:up-sets-up-herdr-from-scratch — a self-contained host is set up again on every run by install --herdr-only: a stopped instance server restarted, a failed plugin step named, and its instance kept', async () => {
  const { installHerdrInstance } = await herdr();
  const { harness } = await import('./install-harness.js');
  const { installHerdrOnly, prepareInstall } = await import('../src/install/index.js');
  const { herdrConnectCommands } = await import('../src/model/setup-checklist.js');
  const own = installHerdrInstance('owner-project', '/home/graphyard');
  const seed = new Map([[hostPlugin('/home/graphyard/.config'), { content: JSON.stringify({ url: 'https://other.example' }), mode: 0o600 }], [hostMaster, { content: JSON.stringify({ version: 1 }), mode: 0o600 }]]);
  const first = await hostInstall(seed);
  try {
    // The next run: the instance's server has stopped, and its plugin was left disabled.
    let running = false, enable = { stdout: '', stderr: 'plugin graphyard failed to load', code: 1 };
    const rerun = await harness({ provider: 'host', serverUrl: 'https://graphyard.example.test', root: first.fixture.root, configHome: first.fixture.configHome, hostFiles: first.fixture.hostFiles, installed: true, extraResponses: [
      { match: `--session ${own.session} status server`, result: () => running ? 'status: running\n' : 'status: not running\n' },
      { match: 'enable --now graphyard-herdr-owner-project.service', result: () => { running = true; return ''; } },
      { match: `--session ${own.session} plugin enable graphyard`, result: () => enable },
    ] });
    const session = await prepareInstall(rerun.root, first.inputs, rerun.deps, 'plan');
    const failed = await installHerdrOnly(session);
    assert.equal(failed.herdr, null);
    assert.equal(failed.herdrFailure!.step, 'plugin');
    assert.match(failed.herdrFailure!.message, /^Herdr plugin failed: herdr plugin enable in session graphyard-owner-project on graphyard-host exited 1: plugin graphyard failed to load/);
    const lines = () => [...rerun.remotes.values()][0].commands.map(command => [command.program, ...command.args].join(' '));
    assert.ok(lines().some(line => line.endsWith('systemctl --user enable --now graphyard-herdr-owner-project.service')), 'the stopped server is started again');
    // Fixed: the same command sets it up, the recorded instance kept (the default's plugin is still another install's).
    enable = { stdout: '', stderr: '', code: 0 };
    const fixed = await installHerdrOnly(session);
    assert.deepEqual(fixed.herdr!.instance, own);
    assert.equal(fixed.herdr!.attach, herdrConnectCommands({ configHome: own.configHome, session: own.session, host: 'graphyard@203.0.113.20' }).ssh);
    assert.equal(fixed.herdr!.attach, `ssh -t graphyard@203.0.113.20 'XDG_CONFIG_HOME=${own.configHome} herdr session attach ${own.session}'`);
    assert.ok(!lines().some(line => /\/herdr plugin (link|enable)/.test(line)), 'the default instance is never linked');
    await rerun.cleanup();
  } finally { await first.fixture.cleanup(); }
});

test('unit:up-sets-up-herdr-from-scratch — up runs install --herdr-only on every run for a self-contained host and prints its attach command, records a named failure, and sets Herdr up on this machine for hetzner and docker-host', async () => {
  const { runUp } = await up();
  const attach = `ssh -t graphyard@203.0.113.20 'XDG_CONFIG_HOME=/home/graphyard/.config/graphyard/acme-shop/herdr herdr session attach graphyard-acme-shop'`;
  let answer: { code: number; stdout: string } = { code: 0, stdout: JSON.stringify({ herdr: { instance: null, attach }, herdrFailure: null }) };
  const world = upWorld({ herdrElsewhere: false, herdrOnly: () => answer });
  const root = await temporaryDirectory('herdr-host-up');
  const local = fakeHerdrHost({ binary: true, running: new Set() });
  const hostRequest = { ...request, provider: 'host' };
  for (let run = 1; run <= 2; run++) {
    const events: UpEvent[] = [];
    const result = await runUp(hostRequest, world.deps(root, events, local.host));
    assert.equal(result.exitCode, 0, result.next);
    assert.equal(result.herdrAttach, attach);
    assert.ok(events.some(event => event.kind === 'note' && event.text === `Watch this install's agents in Herdr: ${attach}`));
    assert.equal(world.calls.filter(args => args.includes('--herdr-only')).length, run, 'checked on every run, the install done or not');
  }
  assert.deepEqual(local.log, [], 'Herdr on this machine is not touched for a host whose loop runs elsewhere');
  const only = world.calls.find(args => args.includes('--herdr-only'))!;
  assert.deepEqual(only.slice(0, 4), ['install', '--provider', 'host', '--repo']);
  // A named failure on the host is recorded like any other, and cleared by the run that sets it up.
  answer = { code: 1, stdout: JSON.stringify({ herdr: null, herdrFailure: { step: 'plugin', message: 'Herdr plugin failed: herdr plugin enable on graphyard-host exited 1: failed to load' } }) };
  const failed = await runUp(hostRequest, world.deps(root, [], local.host));
  assert.equal(failed.herdrAttach, null);
  assert.equal(JSON.parse(await readFile(join(root, '.graphyard/up.json'), 'utf8')).herdrFailure, 'Herdr plugin failed: herdr plugin enable on graphyard-host exited 1: failed to load');
  answer = { code: 0, stdout: JSON.stringify({ herdr: { instance: null, attach }, herdrFailure: null }) };
  assert.equal((await runUp(hostRequest, world.deps(root, [], local.host))).herdrAttach, attach);
  assert.equal(JSON.parse(await readFile(join(root, '.graphyard/up.json'), 'utf8')).herdrFailure, null);

  // hetzner and docker-host install only the server elsewhere: their loop and Herdr run here.
  for (const provider of ['hetzner', 'docker-host']) {
    const elsewhere = upWorld({ herdrElsewhere: false });
    const host = fakeHerdrHost({ binary: true, running: new Set() });
    const result = await runUp({ ...request, provider }, elsewhere.deps(await temporaryDirectory(`herdr-${provider}`), [], host.host));
    assert.equal(result.exitCode, 0, result.next);
    assert.deepEqual(host.log.map(entry => entry.step), ['binary', 'server'], provider);
    assert.equal(result.herdrAttach, 'herdr');
    assert.ok(!elsewhere.calls.some(args => args.includes('--herdr-only')));
  }
});

test('unit:up-sets-up-herdr-from-scratch — a plugin link or enable that fails inside the install is a named, recorded failure, never a Herdr reported set up; the run after it is fixed links it, and a plugin found unbound on a rerun runs the install again', async () => {
  const { runUp } = await up();
  const world = upWorld({ herdrElsewhere: false });
  const root = await temporaryDirectory('herdr-plugin-failure');
  let plugin: string | null = null;
  const host = fakeHerdrHost({ binary: true, running: new Set(), plugin: () => plugin });
  const events: UpEvent[] = [];
  const failed = await runUp(request, world.deps(root, events, host.host));
  assert.equal(failed.exitCode, 0, failed.next);
  assert.equal(failed.herdrAttach, null, 'no attach command for a plugin that is not linked');
  assert.ok(!events.some(event => event.kind === 'note' && event.text.startsWith('Watch this install\'s agents')));
  const recorded = JSON.parse(await readFile(join(root, '.graphyard/up.json'), 'utf8'));
  assert.equal(recorded.noHerdr, true);
  assert.equal(recorded.herdrFailure, `Herdr plugin failed: the graphyard plugin in the host's default Herdr is not configured after the install linked it, not to ${SERVER}`);
  assert.equal(world.calls.filter(args => args[0] === 'install' && args.includes('--apply')).length, 1);

  // Fixed: the next run installs again with Herdr, and the plugin is checked bound to this server.
  plugin = SERVER;
  const fixed = await runUp(request, world.deps(root, [], host.host));
  assert.equal(fixed.herdrAttach, 'herdr');
  const applies = world.calls.filter(args => args[0] === 'install' && args.includes('--apply'));
  assert.ok(applies.length === 2 && !applies[1].includes('--no-herdr'));
  assert.equal(JSON.parse(await readFile(join(root, '.graphyard/up.json'), 'utf8')).herdrFailure, null);

  // A rerun finding the plugin unbound (repointed or removed since): the install runs once more and relinks it.
  let reads = 0;
  plugin = null;
  const relink = fakeHerdrHost({ binary: true, running: new Set(), plugin: () => (++reads > 1 ? SERVER : 'https://other.example') });
  const rerunEvents: UpEvent[] = [];
  const again = await runUp(request, world.deps(root, rerunEvents, relink.host));
  assert.equal(again.herdrAttach, 'herdr');
  assert.equal(world.calls.filter(args => args[0] === 'install' && args.includes('--apply')).length, 3, 'the done install ran again once');
  assert.ok(rerunEvents.some(event => event.kind === 'note' && /is bound to https:\/\/other\.example, not this install's server; running the install again to link it/.test(event.text)));
});

test('unit:up-sets-up-herdr-from-scratch — an enable that fails after config.json was written for this server is a named, recorded failure, retried on the next run; a plugin disabled since an earlier run is enabled again', async () => {
  const { runUp, upHerdr } = await up();
  // upHerdr reads the enabled state Herdr reports, not only config.json: a real herdr spawn (a fake
  // binary on PATH) whose config.json names this server while `plugin list` reports it disabled.
  const scratch = await temporaryDirectory('herdr-plugin-enable');
  const bin = join(scratch, 'bin'), config = join(scratch, 'config'), flag = join(scratch, 'enabled'), refuse = join(scratch, 'refuse');
  const previous = process.env.PATH;
  try {
    await mkdir(bin, { recursive: true }); await mkdir(config, { recursive: true });
    await writeFile(join(config, 'config.json'), JSON.stringify({ url: SERVER, token: 't' }));
    await writeFile(join(bin, 'herdr'), `#!/bin/sh
[ "$1" = "--session" ] && shift 2
case "$1 $2" in
  "plugin config-dir") echo ${JSON.stringify(config)} ;;
  "plugin list") if [ -e ${JSON.stringify(flag)} ]; then e=true; else e=false; fi; echo "{\\"result\\":{\\"plugins\\":[{\\"plugin_id\\":\\"graphyard\\",\\"enabled\\":$e}]}}" ;;
  "plugin enable") if [ -e ${JSON.stringify(refuse)} ]; then echo "plugin graphyard failed to load" >&2; exit 1; fi; : > ${JSON.stringify(flag)} ;;
esac
exit 0
`);
    await chmod(join(bin, 'herdr'), 0o755);
    process.env.PATH = `${bin}${delimiter}${previous}`;
    const host = upHerdr(scratch, 'acme/shop');
    assert.deepEqual(await host.plugin(null), { url: SERVER, enabled: false }, 'a written config.json is not an enabled plugin');
    await writeFile(refuse, '');
    await assert.rejects(host.enable(null), (error: any) => error.step === 'plugin' && /herdr plugin enable graphyard exited 1: plugin graphyard failed to load/.test(error.message));
    assert.deepEqual(await host.plugin(null), { url: SERVER, enabled: false });
    await rm(refuse);
    await host.enable(null);
    assert.deepEqual(await host.plugin(null), { url: SERVER, enabled: true });
  } finally { process.env.PATH = previous; }

  // up: the install wrote config.json for this server, then its enable failed. up enables it, is
  // refused, and records the named failure with no attach command; the next run retries and sets it up.
  const world = upWorld({ herdrElsewhere: false });
  const root = await temporaryDirectory('herdr-plugin-enable-up');
  let enabled = false, refused = true;
  const fake = fakeHerdrHost({ binary: true, running: new Set(), enabled: () => enabled,
    enable: async () => { if (refused) throw new (await herdr()).HerdrSetupFailure('plugin', 'herdr plugin enable graphyard exited 1: plugin graphyard failed to load'); enabled = true; } });
  const events: UpEvent[] = [];
  const failed = await runUp(request, world.deps(root, events, fake.host));
  assert.equal(failed.exitCode, 0, failed.next);
  assert.equal(failed.herdrAttach, null, 'no attach command for a plugin Herdr reports disabled');
  assert.ok(!events.some(event => event.kind === 'note' && event.text.startsWith('Watch this install\'s agents')));
  let recorded = JSON.parse(await readFile(join(root, '.graphyard/up.json'), 'utf8'));
  assert.equal(recorded.noHerdr, true);
  assert.equal(recorded.herdrFailure, 'Herdr plugin failed: herdr plugin enable graphyard exited 1: plugin graphyard failed to load');
  assert.equal(fake.log.filter(entry => entry.step === 'enable').length, 1);

  // Fixed: the next run sets Herdr up again, enables the plugin, and clears the failure.
  refused = false;
  const fixed = await runUp(request, world.deps(root, [], fake.host));
  assert.equal(fixed.herdrAttach, 'herdr');
  recorded = JSON.parse(await readFile(join(root, '.graphyard/up.json'), 'utf8'));
  assert.equal(recorded.noHerdr, false);
  assert.equal(recorded.herdrFailure, null);
  assert.equal(fake.log.filter(entry => entry.step === 'enable').length, 2);

  // Disabled between runs: a rerun whose install is done enables it again rather than reporting it set up.
  enabled = false;
  const rerunEvents: UpEvent[] = [];
  const again = await runUp(request, world.deps(root, rerunEvents, fake.host));
  assert.equal(again.herdrAttach, 'herdr');
  assert.equal(enabled, true);
  assert.ok(rerunEvents.some(event => event.kind === 'note' && event.text === 'Herdr\'s graphyard plugin is bound to this install\'s server but not enabled; enabling it'));

  // An enable Herdr accepts while still reporting the plugin disabled is named too, never reported set up.
  enabled = false;
  const stuck = fakeHerdrHost({ binary: true, running: new Set(), enabled: () => false });
  const ignored = await runUp(request, world.deps(root, [], stuck.host));
  assert.equal(ignored.herdrAttach, null);
  assert.equal(JSON.parse(await readFile(join(root, '.graphyard/up.json'), 'utf8')).herdrFailure, `Herdr plugin failed: the graphyard plugin in the host's default Herdr is bound to ${SERVER} but Herdr still reports it disabled after enabling it`);
});

test('unit:herdr-calls-target-install-instance — every herdr call an install with its own instance makes carries its XDG_CONFIG_HOME and --session through the shared helper, and no herdr spawn in src/ bypasses it', async () => {
  const { herdrCall, herdrJson, herdrInvocation, herdrViaEnv, listHerdrAgents, targetHerdr, herdrServerSeen } = await herdr();
  const { herdrSessionProbe } = await import('../src/supervisor.js');
  const { watchInstantExit } = await import('../src/auto-dispatch.js');
  const instance = { configHome: '/home/op/.config/graphyard/acme-shop/herdr', session: 'graphyard-acme-shop' };
  const calls: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const run = (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => { calls.push({ command, args, env: options?.env }); return JSON.stringify({ result: { agents: [{ pane_id: 'w1:p1' }] } }); };
  try {
    // The default instance: arguments and options unchanged, as before this item.
    targetHerdr(null);
    await herdrJson(['agent', 'list'], run);
    assert.deepEqual(calls.pop(), { command: 'herdr', args: ['agent', 'list'], env: undefined });
    assert.deepEqual(herdrViaEnv(['--version'], null).args, ['--version']);

    // Its own instance: the loop's inventory and launches, the supervisor's probe, the install's transport.
    targetHerdr(instance);
    await listHerdrAgents(run, null);
    assert.equal(herdrServerSeen(), true);
    herdrCall(run, ['pane', 'send-keys', 'w1:p1', 'Enter']);
    assert.equal(herdrSessionProbe({ HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' }, (command, args, options) => run(command, args, options))(), true);
    for (const call of calls) {
      assert.deepEqual(call.args.slice(0, 2), ['--session', instance.session], call.args.join(' '));
      assert.equal(call.env?.XDG_CONFIG_HOME, instance.configHome);
      assert.equal(call.env?.HERDR_SOCKET_PATH, undefined, 'a pane\'s socket never redirects the call');
    }
    const supervisorCall = calls.at(-1)!;
    assert.deepEqual(supervisorCall.args, ['--session', instance.session, 'agent', 'list']);
    assert.deepEqual(herdrViaEnv(['plugin', 'config-dir', 'graphyard']), { command: 'env', args: ['-u', 'HERDR_SOCKET_PATH', `XDG_CONFIG_HOME=${instance.configHome}`, `GRAPHYARD_HERDR_CONFIG_HOME=${instance.configHome}`, `GRAPHYARD_HERDR_SESSION=${instance.session}`, herdrInvocation([]).command, '--session', instance.session, 'plugin', 'config-dir', 'graphyard'] });
    // The launcher's instant-exit watch reads the call's own arguments past the session.
    const watch = watchInstantExit((command, args) => { calls.push({ command, args }); return 'screen'; });
    const launch = herdrInvocation(['pane', 'run', 'w1:p1', 'claude']);
    await watch.run(launch.command, launch.args);
    assert.deepEqual(calls.at(-1)!.args, ['--session', instance.session, 'pane', 'run', 'w1:p1', 'claude']);
  } finally { targetHerdr(null); }

  // No herdr spawn in src/ names the binary itself: each goes through src/master/herdr.ts. A spawn is any
  // call whose program argument is herdr, however it is spelled (a literal, a layout's or deps' herdr
  // path, a herdr binary variable) and in whichever position the wrapper takes it (exec, asUser's
  // third argument), followed by its argument list; a timed step named 'herdr' is no spawn.
  const spawnsHerdr = (line: string) => /(?<![Ss]tep)[(,]\s*(?:['"`]herdr['"`]|[\w$.]*\.herdr\b|[\w$]*[hH]erdr(?:Binary|Path|Bin)\b(?:\(\))?|binary)\s*,\s*\[/.test(line) && !/^\s*(\/\/|\*)/.test(line);
  // The guard catches the spellings that bypassed it before, a self-contained host's setup among them.
  for (const line of [`await asUser(remote, HOST_HOME, layout.herdr, ['workspace', 'list'], { allowFailure: true })`, `run('herdr', ['agent', 'list'])`,
    `execFileSync(herdrBinary(), ['plugin', 'enable', 'graphyard'])`, `deps.exec(binary, ['status', 'server'])`, `transport.exec("herdr", ['--version'])`]) assert.ok(spawnsHerdr(line), line);
  for (const line of [`herdrCall(run, ['agent', 'list'])`, `const call = herdrViaEnv(args, instance, layout.herdr);`, `asUser(remote, HOST_HOME, call.command, call.args)`, `timings.step('herdr', () => effects.agents())`]) assert.ok(!spawnsHerdr(line), line);
  const files: string[] = [];
  const walk = async (directory: string) => { for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) await walk(path); else if (/\.tsx?$/.test(entry.name)) files.push(path); } };
  await walk(src);
  assert.ok(files.some(file => relative(src, file) === join('install', 'host.ts')), 'the walk reaches host setup');
  const bypass = files.filter(file => relative(src, file) !== join('master', 'herdr.ts')).flatMap(file => {
    const text = execFileSync('cat', [file], { encoding: 'utf8' });
    return text.split('\n').map((line, index) => ({ file: relative(src, file), line: index + 1, text: line })).filter(entry => spawnsHerdr(entry.text));
  });
  assert.deepEqual(bypass, [], 'every herdr spawn goes through herdrCall, herdrJson, herdrRun, herdrSync or herdrViaEnv');
});

test('unit:herdr-calls-target-install-instance — a self-contained host runs every herdr command of its setup through the shared helper, against its own instance when it has one', async () => {
  const { harness } = await import('./install-harness.js');
  const { applyInstall, buildPlan, prepareInstall } = await import('../src/install/index.js');
  const configFile = '/home/graphyard/.config/herdr/plugins/config/graphyard/config.json';
  const hostFiles = new Map([[configFile, { content: JSON.stringify({ url: 'https://other.example', token: 'other-token' }), mode: 0o600 }]]);
  const fixture = await harness({ provider: 'host', serverUrl: 'https://graphyard.example.test', hostFiles });
  try {
    const session = await prepareInstall(fixture.root, { repository: 'owner/project', provider: 'host', selfContained: true, sshHost: '203.0.113.20', sshUser: 'root', domain: 'graphyard.example.test' }, fixture.deps);
    await applyInstall(session, await buildPlan(session));
    const lines = [...fixture.remotes.values()][0].commands.map(command => [command.program, ...command.args].join(' '));
    const herdrLines = lines.filter(line => line.includes('/home/graphyard/.local/bin/herdr ') && !line.includes('install.sh'));
    assert.ok(herdrLines.length >= 6, herdrLines.join('\n'));
    for (const line of herdrLines) {
      // Only the read of the default's binding reaches the default instance; every other call carries the instance.
      if (/\/herdr plugin config-dir graphyard$/.test(line)) continue;
      assert.match(line, / env -u HERDR_SOCKET_PATH XDG_CONFIG_HOME=\/home\/graphyard\/\.config\/graphyard\/owner-project\/herdr GRAPHYARD_HERDR_CONFIG_HOME=\S+ GRAPHYARD_HERDR_SESSION=graphyard-owner-project \/home\/graphyard\/\.local\/bin\/herdr --session graphyard-owner-project /, line);
    }
    assert.ok(herdrLines.filter(line => !line.includes('--session')).every(line => /plugin config-dir graphyard$/.test(line)), 'the default instance is only read');
  } finally { await fixture.cleanup(); }
});

test('unit:herdr-attach-command-shown — up prints, and master status shows, the one command that opens the install\'s agents in Herdr', async () => {
  const { herdrAttachCommand, installHerdrInstance } = await herdr();
  const { runUp } = await up();
  const { masterStatusReport } = await import('../src/cli/master-status.js');
  const { masterConfigSchema } = await import('../src/master.js');
  const { emptyDaemonState, writeDaemonState } = await import('../src/master-daemon.js');
  const instance = installHerdrInstance('acme-shop');
  assert.equal(herdrAttachCommand(instance), `XDG_CONFIG_HOME=${instance.configHome} herdr session attach graphyard-acme-shop`);
  assert.equal(herdrAttachCommand(null), 'herdr');

  for (const elsewhere of [true, false]) {
    const world = upWorld({ herdrElsewhere: elsewhere });
    const events: UpEvent[] = [];
    const result = await runUp(request, world.deps(await temporaryDirectory('herdr-attach-up'), events, fakeHerdrHost({ binary: true, running: new Set() }).host));
    const attach = herdrAttachCommand(elsewhere ? instance : null);
    assert.equal(result.herdrAttach, attach);
    assert.ok(events.some(event => event.kind === 'note' && event.text === `Watch this install's agents in Herdr: ${attach}`));
    assert.ok(!events.some(event => event.kind === 'note' && /--no-herdr/.test(event.text)), 'no --no-herdr note in its place');
  }

  const root = await temporaryDirectory('herdr-attach-status');
  const credentials = await temporaryDirectory('herdr-attach-credentials');
  try {
    execFileSync('git', ['init', '-q', root]); execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/shop.git'], { cwd: root });
    await writeFile(join(credentials, 'coordinator.token'), 'c'.repeat(40), { mode: 0o600 });
    const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(credentials, 'coordinator.token'), cliPath: launcher, repository: 'acme/shop', baseBranch: 'main', githubAppId: 7, hostId: 'machine-a', masterAgentName: 'graphyard-master-shop', workers: [], herdrInstance: instance });
    await writeDaemonState(master, emptyDaemonState(master));
    const masterApi = async (path: string) => path === 'work-snapshot' ? { work: [], now: new Date().toISOString() } : { decisions: [] };
    const report = await masterStatusReport(root, master, masterApi, { actor: { id: 'coordinator-1' } }, { commit: null });
    assert.deepEqual({ instance: report.herdr.instance, attach: report.herdr.attach }, { instance, attach: herdrAttachCommand(instance) });
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); }

  const docs = await readFile(fileURLToPath(new URL('../docs/install.md', import.meta.url)), 'utf8');
  assert.match(docs, /herdr session attach/, 'docs/install.md names the attach command');
});

/** A simulated host for host setup: commands answered from its state, files kept in memory. */
function simulatedHost(state: { herdr: 'missing' | 'local' | 'path'; installerWorks: boolean; running: Set<string>; systemctlWorks?: boolean; linger?: boolean; lingerAllowed?: boolean }) {
  const files = new Map<string, string>(), dirs = new Set<string>(), links = new Map<string, string>(), commands: string[] = [];
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' }), fail = (stderr: string) => ({ code: 1, stdout: '', stderr });
  const deps: HerdrHostDeps = {
    home: '/home/op', path: '/home/op/.local/bin:/usr/bin', user: 'op',
    exec: async (command, args, options) => {
      commands.push([command, ...args].join(' '));
      if (command === 'sh' && args[1] === 'command -v herdr') return state.herdr === 'path' ? ok('/usr/local/bin/herdr\n') : fail('');
      if (command === 'sh') { if (state.installerWorks) state.herdr = 'local'; return state.installerWorks ? ok('installed herdr to /home/op/.local/bin/herdr') : fail('curl: (6) Could not resolve host: herdr.dev'); }
      if (command.endsWith('/herdr')) {
        if (state.herdr === 'missing' || (command === '/home/op/.local/bin/herdr' && state.herdr !== 'local') || (command === '/usr/local/bin/herdr' && state.herdr !== 'path')) return fail('not found');
        const session = args[0] === '--session' ? args[1] : 'default', rest = args[0] === '--session' ? args.slice(2) : args;
        if (session !== 'default') assert.equal(options?.env?.XDG_CONFIG_HOME, '/home/op/.config/graphyard/acme-shop/herdr');
        if (rest[0] === '--version') return ok('herdr 0.9.1');
        if (rest.join(' ') === 'status server') return ok(`status: ${state.running.has(session) ? 'running' : 'not running'}\n`);
        if (rest.join(' ') === 'workspace list') return ok(JSON.stringify({ result: { workspaces: [] } }));
        if (rest[0] === 'workspace' && rest[1] === 'create') return ok(JSON.stringify({ result: { workspace: { workspace_id: 'w9', label: 'shop' } } }));
        return fail(`unexpected ${rest.join(' ')}`);
      }
      if (command === 'loginctl') {
        if (args[0] === 'show-user') return state.linger ? ok('yes\n') : args[1] === 'op' ? ok('no\n') : fail('no such user');
        if (args.join(' ') === 'enable-linger op' && state.lingerAllowed !== false) { state.linger = true; return ok(); }
        return fail('Could not enable linger: Access denied');
      }
      if (command === 'systemctl') {
        if (state.systemctlWorks === false) return fail('Failed to connect to bus');
        if (args[1] === 'enable') { const unit = files.get(`/home/op/.config/systemd/user/${args[3]}`)!; state.running.add(/--session (\S+) server/.exec(unit)?.[1] ?? 'default'); }
        return ok();
      }
      return ok();
    },
    readFile: async path => files.get(path) ?? null,
    writeFile: async (path, text) => { files.set(path, text); },
    mkdir: async path => { dirs.add(path); },
    symlink: async (target, path) => { links.set(path, target); },
    exists: path => files.has(path) || dirs.has(path) || links.has(path) || path === '/home/op/.config/gh',
    sleep: async () => {},
  };
  return { deps, files, links, commands };
}

test('unit:up-sets-up-herdr-from-scratch — every up sets Herdr up with no flag: installs a missing herdr with Herdr\'s own installer, starts a stopped server as a user unit that survives a reboot, links the plugin, idempotent on rerun; only a named, recorded failure leaves Herdr out', async () => {
  const { ensureHerdrBinary, ensureHerdrServer, herdrInstaller, installHerdrInstance, HerdrSetupFailure } = await herdr();
  const { runUp, upHerdr } = await up();
  const instance = installHerdrInstance('acme-shop', '/home/op');

  // No herdr: Herdr's own installer, no root, then the binary in ~/.local/bin.
  const fresh = simulatedHost({ herdr: 'missing', installerWorks: true, running: new Set() });
  assert.deepEqual(await ensureHerdrBinary(fresh.deps), { binary: '/home/op/.local/bin/herdr', installed: true });
  assert.ok(fresh.commands.includes(`sh -c ${herdrInstaller}`));
  assert.equal(herdrInstaller, 'curl -fsSL https://herdr.dev/install.sh | sh');
  assert.ok(!fresh.commands.some(command => /\bsudo\b/.test(command)), 'no root');
  // Rerun: found, not installed again.
  fresh.commands.length = 0;
  assert.deepEqual(await ensureHerdrBinary(fresh.deps), { binary: '/home/op/.local/bin/herdr', installed: false });
  assert.ok(!fresh.commands.some(command => command.startsWith('sh -c curl')));

  // A stopped server: a user unit, enabled (WantedBy=default.target) and started, lingering for reboots.
  const started = await ensureHerdrServer(fresh.deps, '/home/op/.local/bin/herdr', null, 'acme-shop');
  assert.deepEqual(started, { started: true, unit: 'graphyard-herdr.service' });
  const defaultUnit = fresh.files.get('/home/op/.config/systemd/user/graphyard-herdr.service')!;
  assert.match(defaultUnit, /^ExecStart=\/home\/op\/\.local\/bin\/herdr server$/m);
  assert.match(defaultUnit, /^Restart=on-failure$/m); assert.match(defaultUnit, /^WantedBy=default\.target$/m);
  assert.ok(fresh.commands.includes('systemctl --user enable --now graphyard-herdr.service') && fresh.commands.includes('loginctl enable-linger op'));
  assert.ok(fresh.commands.includes('loginctl show-user op --property=Linger --value'), 'lingering is read back, not assumed');
  // Its own instance: a unit per install, with its config home and session.
  const own = await ensureHerdrServer(fresh.deps, '/home/op/.local/bin/herdr', instance, 'acme-shop');
  assert.deepEqual(own, { started: true, unit: 'graphyard-herdr-acme-shop.service' });
  const ownUnit = fresh.files.get('/home/op/.config/systemd/user/graphyard-herdr-acme-shop.service')!;
  assert.match(ownUnit, /^Environment=XDG_CONFIG_HOME=\/home\/op\/\.config\/graphyard\/acme-shop\/herdr$/m);
  assert.match(ownUnit, /^ExecStart=\/home\/op\/\.local\/bin\/herdr --session graphyard-acme-shop server$/m);
  // Rerun: a running server is left as it is.
  fresh.commands.length = 0;
  assert.deepEqual(await ensureHerdrServer(fresh.deps, '/home/op/.local/bin/herdr', instance, 'acme-shop'), { started: false, unit: null });
  assert.ok(!fresh.commands.some(command => command.startsWith('systemctl')));
  assert.ok(!fresh.commands.includes('loginctl enable-linger op'), 'lingering already holds, so it is only read');
  // up's own Herdr steps on that host: the instance prepared, its server running, its workspace found or made.
  const steps = upHerdr('/repo', 'acme/shop', fresh.deps);
  assert.deepEqual(await steps.server('/home/op/.local/bin/herdr', instance, 'acme-shop'), { started: false, unit: null, workspace: 'w9' });
  assert.equal(fresh.links.get('/home/op/.config/herdr/sessions/graphyard-acme-shop'), `${instance.configHome}/herdr/sessions/graphyard-acme-shop`);
  assert.equal(fresh.links.get(`${instance.configHome}/gh`), '/home/op/.config/gh');

  // Failures are named HerdrSetupFailures.
  await assert.rejects(ensureHerdrBinary(simulatedHost({ herdr: 'missing', installerWorks: false, running: new Set() }).deps), (error: any) => error instanceof HerdrSetupFailure && error.step === 'install' && /Could not resolve host/.test(error.message));
  await assert.rejects(ensureHerdrServer(simulatedHost({ herdr: 'path', installerWorks: true, running: new Set(), systemctlWorks: false }).deps, '/usr/local/bin/herdr', null, null), (error: any) => error instanceof HerdrSetupFailure && error.step === 'server' && /Failed to connect to bus/.test(error.message));
  // Lingering refused: the unit would not come back after a reboot, so that is a named failure, never reported as surviving one.
  const refusedLinger = simulatedHost({ herdr: 'path', installerWorks: true, running: new Set(), lingerAllowed: false });
  await assert.rejects(ensureHerdrServer(refusedLinger.deps, '/usr/local/bin/herdr', null, null), (error: any) => error instanceof HerdrSetupFailure && error.step === 'server' && /lingering is off for op and loginctl enable-linger op exited 1: Could not enable linger: Access denied/.test(error.message) && /sudo loginctl enable-linger op/.test(error.message));
  // A rerun on that host, its server now running under the unit: lingering is checked again and still refused.
  await assert.rejects(ensureHerdrServer(refusedLinger.deps, '/usr/local/bin/herdr', null, null), (error: any) => error instanceof HerdrSetupFailure && /lingering is off/.test(error.message));
  refusedLinger.deps.exec = (original => async (command: string, args: string[], options?: any) => command === 'loginctl' && args[0] === 'enable-linger' ? { code: 0, stdout: '', stderr: '' } : original(command, args, options))(refusedLinger.deps.exec);
  await assert.rejects(ensureHerdrServer(refusedLinger.deps, '/usr/local/bin/herdr', null, null), (error: any) => /enable-linger op left it off/.test(error.message), 'an enable that answers 0 but leaves lingering off is still refused');

  // up, with no flag: a host with no herdr installs it, starts its server, and the install links the plugin (no --no-herdr).
  const world = upWorld({ herdrElsewhere: false });
  const root = await temporaryDirectory('herdr-from-scratch');
  const state = { binary: false, running: new Set<string>() };
  const host = fakeHerdrHost(state);
  const events: UpEvent[] = [];
  assert.equal((await runUp(request, world.deps(root, events, host.host))).exitCode, 0);
  assert.deepEqual(host.log.map(entry => entry.step), ['binary', 'server']);
  assert.ok(events.some(event => event.kind === 'note' && /herdr was not installed; Herdr's own installer put it at/.test(event.text)));
  assert.ok(events.some(event => event.kind === 'note' && /now runs as the user unit graphyard-herdr\.service/.test(event.text)));
  assert.ok(world.calls.filter(args => args[0] === 'install').every(args => !args.includes('--no-herdr')));
  // Rerun: every step checked again, nothing installed or started twice, the install not rerun.
  const rerunEvents: UpEvent[] = [];
  const applies = world.calls.filter(args => args[0] === 'install' && args.includes('--apply')).length;
  assert.equal((await runUp(request, world.deps(root, rerunEvents, host.host))).exitCode, 0);
  assert.deepEqual(host.log.map(entry => entry.step), ['binary', 'server', 'binary', 'server']);
  assert.ok(!rerunEvents.some(event => event.kind === 'note' && /was not installed|now runs as the user unit/.test(event.text)));
  assert.equal(world.calls.filter(args => args[0] === 'install' && args.includes('--apply')).length, applies);

  // A failure is the only way Herdr is left out: named, recorded in up.json, and set up on the run after it is fixed.
  const failing = upWorld({ herdrElsewhere: false });
  const failRoot = await temporaryDirectory('herdr-from-scratch-failure');
  let broken = true;
  const failingHost: UpHerdr = { ...fakeHerdrHost({ binary: true, running: new Set() }).host, binary: async () => { if (broken) throw new HerdrSetupFailure('install', 'herdr is not installed and Herdr\'s installer exited 6'); return { binary: '/home/op/.local/bin/herdr', installed: true }; } };
  const failEvents: UpEvent[] = [];
  assert.equal((await runUp(request, failing.deps(failRoot, failEvents, failingHost))).exitCode, 0);
  assert.ok(failing.calls.filter(args => args[0] === 'install').every(args => args.includes('--no-herdr')));
  assert.ok(failEvents.some(event => event.kind === 'note' && /^Herdr is left out of this install: Herdr install failed: herdr is not installed/.test(event.text)));
  const recorded = JSON.parse(await readFile(join(failRoot, '.graphyard/up.json'), 'utf8'));
  assert.equal(recorded.noHerdr, true); assert.match(recorded.herdrFailure, /^Herdr install failed/);
  broken = false; failing.calls.length = 0;
  assert.equal((await runUp(request, failing.deps(failRoot, [], failingHost))).exitCode, 0);
  const again = failing.calls.filter(args => args[0] === 'install' && args.includes('--apply'));
  assert.ok(again.length === 1 && !again[0].includes('--no-herdr'), 'the install runs again, now linking the plugin');
  const cleared = JSON.parse(await readFile(join(failRoot, '.graphyard/up.json'), 'utf8'));
  assert.equal(cleared.noHerdr, false); assert.equal(cleared.herdrFailure, null);
});

test('unit:setup-page-herdr-connect-instructions — the Setup page shows copyable local, SSH and Herdr remote attach commands, and whether the Herdr server runs, for an install with its own instance and one on the default instance', async () => {
  const { SetupView } = await import('../web/pages/setup.js');
  const { herdrConnectCommands, herdrWatch } = await import('../src/model/setup-checklist.js');
  const { loopHerdr, encodeLoopHerdr, LoopRegistry } = await import('../src/model/executor-presence.js');
  const page = (herdrReport: unknown) => renderToStaticMarkup(createElement(SetupView, { status: { setup: { protection: 'off', loop: true, herdr: herdrReport } }, onConnect: () => {}, onSubmitGoal: () => {} }));
  const decode = (html: string) => html.replaceAll('&#x27;', '\'').replaceAll('&quot;', '"').replaceAll('&amp;', '&');

  const own = { configHome: '/home/op/.config/graphyard/acme-shop/herdr', session: 'graphyard-acme-shop', host: 'shop-box.tail1234.ts.net', running: true };
  const html = decode(page(own));
  assert.match(html, /Watch your agents in Herdr/);
  assert.match(html, /data-herdr-connect="instance"/); assert.match(html, /data-herdr-running="yes"/);
  for (const command of ['XDG_CONFIG_HOME=/home/op/.config/graphyard/acme-shop/herdr herdr session attach graphyard-acme-shop',
    'ssh -t shop-box.tail1234.ts.net \'XDG_CONFIG_HOME=/home/op/.config/graphyard/acme-shop/herdr herdr session attach graphyard-acme-shop\'',
    'herdr --remote shop-box.tail1234.ts.net --session graphyard-acme-shop']) assert.ok(html.includes(`data-copy="${command}"`), `copyable: ${command}`);

  // The default instance, its host unknown and its server down: plain herdr, and a HOST placeholder.
  const fallback = decode(page({ configHome: null, session: null, host: null, running: false }));
  assert.match(fallback, /data-herdr-connect="default"/); assert.match(fallback, /data-herdr-running="no"/);
  for (const command of ['herdr', 'ssh -t HOST herdr', 'herdr --remote HOST']) assert.ok(fallback.includes(`data-copy="${command}"`), `copyable: ${command}`);
  assert.match(fallback, /Replace HOST/);
  // Before any loop reported: shown, its state unknown.
  assert.match(page(undefined), /data-herdr-running="unknown"/);
  assert.deepEqual(herdrConnectCommands(herdrWatch(null)), { local: 'herdr', ssh: 'ssh -t HOST herdr', remote: 'herdr --remote HOST' });

  // The loop names its server on its reads; the control plane keeps it with the loop's presence for /api/status.
  const header = encodeLoopHerdr(own);
  assert.deepEqual(loopHerdr(header), own);
  assert.equal(loopHerdr('%7Bnot json'), null);
  const registry = new LoopRegistry(), now = new Date();
  registry.observe({ principal: 'coordinator-1', intervalSeconds: 20, herdr: loopHerdr(header) }, now);
  assert.deepEqual(registry.live(now)?.herdr, own);
});
