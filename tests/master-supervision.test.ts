import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentRuntimeRun, agentRuntimeTimeoutMs, daemonExecutor, listHerdrAgents, masterConfigSchema, masterHarness, observeHerdrAgents, setupMaster, type MasterConfig } from '../src/master.js';
import { daemonEffects, emptyDaemonState, runDaemon, writeDaemonState } from '../src/master-daemon.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { installLoopSupervisor, LoopSupervisorRefusal, loopStopTimeoutSeconds, loopSupervision, loopSupervisionAttention, loopUnitDirectory, loopUnitName, loopUnitText, loopWatchdogSeconds, supervisorSupport, temporaryDirectories, testSuiteHomeGuard, underTestRunner, unsupervisedInstruction } from '../src/supervisor.js';

/**
 * Each test is named for the proof it produces (GY-114): integration:setup-installs-supervisor,
 * unit:supervision-reported, unit:unsupervised-host-stated, integration:runtime-calls-bounded,
 * manual:supervisor-onboarding-review and integration:supervisor-install-explicit-only.
 *
 * GY-84 promised that "a supervised deployment restarts it automatically". Nothing installed that
 * supervisor and nothing checked for one, so the promise held only where somebody had copied the
 * packaged unit by hand. These cover the three halves of closing that: setup installs it, status
 * verifies it, and a host that cannot have one is told so instead of being left to find out — and
 * the guard that the install is an explicit operator action and never a side effect, added after a
 * test run wrote the real user's unit with a temporary checkout as its WorkingDirectory.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const source = (name: string) => readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), 'utf8');
const supervisedUser = String(process.getuid?.() ?? '');

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-supervision-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  return root;
}
function config(credentialFile: string, overrides: Record<string, unknown> = {}): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], ...overrides });
}

/**
 * A stub of the host's supervisor: it records every command, and answers the state queries the
 * way the real one does — on stdout, with a non-zero exit for every state but the good one, and
 * `loginctl show-user` answering nothing unless the user is named. Its repositories live under the
 * system temporary directory, so it declares no temporary directory of its own; the real default is
 * exercised by the explicit-only proof.
 */
function hostStub(states: { enabled?: string; active?: string; linger?: string } = {}) {
  const calls: string[][] = [];
  const answer = (args: string[]) => {
    if (args[1] === 'is-enabled') return states.enabled ?? 'enabled';
    if (args[1] === 'is-active') return states.active ?? 'active';
    return '';
  };
  return {
    calls,
    host: {
      platform: 'linux' as NodeJS.Platform,
      temporaryDirectories: [] as string[],
      run: (command: string, args: string[]) => {
        calls.push([command, ...args]);
        // Without a user argument, `show-user` describes the login manager, which has no Linger.
        if (command === 'loginctl' && args[0] === 'show-user') return args[1] && !args[1].startsWith('--') ? `${states.linger ?? 'yes'}\n` : '\n';
        if (command === 'loginctl') return '';
        const text = answer(args);
        // systemctl reports a bad state on stdout and exits non-zero; the reader must take the word.
        if (args[1] === 'is-enabled' && text !== 'enabled' || args[1] === 'is-active' && text !== 'active') {
          throw Object.assign(new Error(`Command failed: systemctl ${args.join(' ')}`), { stdout: `${text}\n`, status: 1 });
        }
        return `${text}\n`;
      },
    },
  };
}
const changes = (calls: string[][]) => calls.filter(call => call[0] === 'systemctl' && ['daemon-reload', 'enable', 'restart', 'start', 'stop', 'disable'].includes(call[2]) || call[0] === 'loginctl' && call[1] === 'enable-linger');
const fileState = async (path: string) => { try { const info = await stat(path); return { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino }; } catch { return null; } };

test('integration:setup-installs-supervisor — setup writes, enables and starts the loop unit, and a second run changes nothing', async () => {
  const root = await repository();
  const credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-supervision-credentials-'));
  const home = await mkdtemp(join(tmpdir(), 'graphyard-supervision-home-'));
  try {
    const first = hostStub();
    const setup = await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory, run: { intervalSeconds: 20 }, installSupervisor: true },
      coordinatorStatus as typeof fetch, { supervisorHost: { ...first.host, home } });

    // The unit is written from this installation, not copied from an example.
    const unitPath = join(home, '.config/systemd/user', loopUnitName);
    const unit = await readFile(unitPath, 'utf8');
    assert.equal(setup.supervisor!.unitPath, unitPath);
    assert.equal(setup.supervisor!.state, 'created');
    assert.match(unit, new RegExp(`^WorkingDirectory=${root}$`, 'm'));
    assert.match(unit, new RegExp(`^ExecStart=\\S+ ${launcher} master run$`, 'm'));

    // The restart policy: back after a crash, however often, and back after a reboot.
    assert.match(unit, /^Restart=always$/m);
    assert.match(unit, /^RestartSec=\d+$/m);
    const sections = Object.fromEntries(unit.split(/^\[(\w+)\]$/m).slice(1).reduce<[string, string][]>((pairs, part, index, parts) => index % 2 ? [...pairs, [parts[index - 1], part]] : pairs, []));
    // In [Unit]: in [Service] systemd ignores it, and a crash loop would be left dead.
    assert.match(sections.Unit, /^StartLimitIntervalSec=0$/m);
    assert.match(sections.Install, /^WantedBy=default\.target$/m);
    // The keep-alive that turns a hung cycle into a restart, and the room the loop needs to stop.
    assert.match(sections.Service, /^NotifyAccess=all$/m);
    assert.equal(/^WatchdogSec=(\d+)$/m.exec(sections.Service)![1], String(loopWatchdogSeconds(20)));
    assert.equal(/^TimeoutStopSec=(\d+)$/m.exec(sections.Service)![1], String(loopStopTimeoutSeconds));
    assert.ok(loopStopTimeoutSeconds * 1000 > agentRuntimeTimeoutMs, 'the unit gives the loop longer to stop than its longest bounded external call takes');
    assert.ok(loopWatchdogSeconds(20) * 1000 > 2 * 20_000, 'the packaged window never restarts a healthy loop mid-cycle');

    // It is enabled (so it returns after a reboot), started now, and this user lingers.
    assert.deepEqual(changes(first.calls),
      [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', loopUnitName], ['loginctl', 'enable-linger']]);
    assert.deepEqual({ installed: setup.supervisor!.installed, enabled: setup.supervisor!.enabled, active: setup.supervisor!.active, linger: setup.supervisor!.linger },
      { installed: true, enabled: true, active: true, linger: true });
    // It reports what it installed, in the words of the commands it ran.
    assert.ok(setup.supervisor!.performed.some(step => step.includes(unitPath)));
    assert.ok(setup.supervisor!.performed.includes(`systemctl --user enable --now ${loopUnitName}`));
    assert.equal(setup.supervisor!.refused, null);
    assert.deepEqual(setup.attention, [], 'a supervised installation raises nothing');

    // Re-running setup is idempotent: the same unit content is left alone and nothing is reloaded.
    const again = hostStub();
    const repeated = await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory, run: { intervalSeconds: 20 }, installSupervisor: true },
      coordinatorStatus as typeof fetch, { supervisorHost: { ...again.host, home } });
    assert.equal(repeated.supervisor!.state, 'unchanged');
    assert.equal(await readFile(unitPath, 'utf8'), unit, 'the unit on disk is byte-for-byte what the first run wrote');
    assert.equal(again.calls.some(call => call[2] === 'daemon-reload'), false, 'an unchanged unit is not reloaded');
    assert.equal(again.calls.some(call => call[2] === 'restart'), false, 'and the running loop is left alone');
    assert.ok(again.calls.some(call => call[2] === 'enable'), 'enabling stays idempotent rather than conditional');
    assert.deepEqual({ enabled: repeated.supervisor!.enabled, active: repeated.supervisor!.active }, { enabled: true, active: true });

    // A changed interval rewrites the unit, reloads it, and restarts the loop so the new window
    // takes effect now rather than at the next crash; no replace flag is needed for the same loop.
    const retuned = hostStub();
    const rewritten = await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory, run: { intervalSeconds: 120 }, installSupervisor: true },
      coordinatorStatus as typeof fetch, { supervisorHost: { ...retuned.host, home } });
    assert.equal(rewritten.supervisor!.state, 'updated');
    assert.match(await readFile(unitPath, 'utf8'), new RegExp(`^WatchdogSec=${loopWatchdogSeconds(120)}$`, 'm'));
    assert.deepEqual(changes(retuned.calls).map(call => call.slice(0, 3)),
      [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable'], ['systemctl', '--user', 'restart'], ['loginctl', 'enable-linger']], 'a rewritten unit is reloaded, enabled and restarted, in that order');
    assert.ok(rewritten.supervisor!.performed.includes(`systemctl --user restart ${loopUnitName}`), 'and setup says the loop was restarted');
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); }
});

test('unit:supervision-reported — master status reports whether the loop is supervised, and names the command that fixes it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-supervision-status-'));
  const root = await repository();
  const home = await mkdtemp(join(tmpdir(), 'graphyard-supervision-status-home-'));
  try {
    const credential = join(directory, 'coordinator.token');
    await writeFile(credential, coordinatorToken, { mode: 0o600 });
    const master = config(credential);
    await writeDaemonState(master, emptyDaemonState(master));
    const masterApi = async (path: string) => path === 'work-snapshot' ? { work: [], now: new Date().toISOString() } : { decisions: [] };
    const report = (host: NonNullable<Parameters<typeof masterStatusReport>[5]>['supervisorHost']) =>
      masterStatusReport(root, master, masterApi, { actor: { id: 'coordinator-1' } }, { commit: null }, { supervisorHost: host });

    // Installed, enabled and running: the setup section says so and raises nothing. The unit is
    // placed as an operator's install would leave it; status only ever reads.
    await mkdir(join(home, '.config/systemd/user'), { recursive: true });
    await writeFile(join(home, '.config/systemd/user', loopUnitName), loopUnitText({ root, cliPath: launcher, repository: 'owner/project', intervalSeconds: 20 }));
    const healthyHost = hostStub();
    const healthy = await report({ ...healthyHost.host, home });
    assert.deepEqual({ supported: healthy.setup.supervisor.supported, installed: healthy.setup.supervisor.installed, enabled: healthy.setup.supervisor.enabled, active: healthy.setup.supervisor.active, linger: healthy.setup.supervisor.linger },
      { supported: true, installed: true, enabled: true, active: true, linger: true });
    assert.deepEqual(healthy.setup.attention, []);
    assert.equal(healthy.attentionItems.some(item => /supervis/i.test(item.text)), false, 'a supervised loop is not an attention item');
    // Lingering is read for this user by name: `show-user` with no user describes the login manager.
    assert.ok(healthyHost.calls.some(call => call[0] === 'loginctl' && call[1] === 'show-user' && call[2] === supervisedUser && call.includes('--property=Linger')),
      `status asks loginctl about user ${supervisedUser}: ${JSON.stringify(healthyHost.calls.filter(call => call[0] === 'loginctl'))}`);
    assert.equal(changes(healthyHost.calls).length, 0, 'status changes nothing on the host');

    // Disabled: the loop runs now but nothing brings it back, and the fix is named exactly.
    const disabled = await report({ ...hostStub({ enabled: 'disabled' }).host, home });
    assert.equal(disabled.setup.supervisor.enabled, false);
    const item = disabled.attentionItems.find(entry => /installed but disabled/.test(entry.text));
    assert.ok(item, `the disabled supervisor is reported: ${JSON.stringify(disabled.setup.attention)}`);
    assert.equal(item!.subject, 'setup'); assert.equal(item!.human, false); assert.equal(item!.role, 'master');
    assert.equal(item!.next, `systemctl --user enable --now ${loopUnitName}`);
    assert.ok(disabled.setup.attention.includes(item!.text), 'and it is in the setup section the master reads');
    // The command the item names is one the master may run without an operator keypress.
    const allow = masterHarness(root, master, 'claude').allow.map(rule => rule.rule);
    assert.ok(allow.includes(`Bash(${item!.next})`), `the master's harness grants ${item!.next}`);

    // Stopped, and missing altogether: each says what is not happening and what starts it again.
    const stopped = await report({ ...hostStub({ active: 'inactive' }).host, home });
    assert.ok(stopped.attentionItems.some(entry => /installed but not running/.test(entry.text) && entry.next === `systemctl --user start ${loopUnitName}`));
    const bare = await mkdtemp(join(tmpdir(), 'graphyard-supervision-bare-'));
    try {
      const missing = await report({ ...hostStub({ enabled: 'not-found', active: 'inactive' }).host, home: bare });
      assert.equal(missing.setup.supervisor.installed, false);
      const absent = missing.attentionItems.find(entry => /no supervisor installed/.test(entry.text));
      assert.ok(absent, 'an installation with no supervisor is named, not assumed self-healing');
      assert.match(absent!.text, /nothing restarts it after a crash or a reboot/);
      assert.match(absent!.next, /master init/);
    } finally { await rm(bare, { recursive: true, force: true }); }

    // Not lingering: enabled, running, and still down after the next reboot, with the fix named.
    const unlingering = await report({ ...hostStub({ linger: 'no' }).host, home });
    assert.equal(unlingering.setup.supervisor.linger, false);
    const reboot = unlingering.attentionItems.find(entry => /may not start at boot/.test(entry.text));
    assert.ok(reboot, 'a user manager that does not start at boot is reported');
    assert.match(reboot!.next, /^loginctl enable-linger/);

    // A supervisor that cannot be read at all is unverified, never reported as healthy.
    const unreadable = await report({ platform: 'linux', home, run: (command: string, args: string[]) => { if (args[1]?.startsWith('is-')) throw new Error('systemd is not answering'); return ''; } });
    assert.equal(unreadable.setup.supervisor.enabled, null);
    assert.ok(unreadable.attentionItems.some(entry => /could not be verified/.test(entry.text)));
  } finally { await rm(directory, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); }
});

test('unit:unsupervised-host-stated — a host that can have no supervisor is told so at setup, with what to run instead', async () => {
  const root = await repository();
  const credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-supervision-unsupported-'));
  try {
    // Two ways a host has no supervisor to install: another platform, and no systemd user manager.
    assert.match(supervisorSupport({ platform: 'darwin' }).reason!, /this host reports darwin/);
    assert.match(supervisorSupport({ platform: 'linux', run: () => { throw new Error('Failed to connect to bus'); } }).reason!, /no reachable systemd user manager/);

    for (const host of [{ platform: 'darwin' as NodeJS.Platform }, { platform: 'linux' as NodeJS.Platform, run: () => { throw new Error('Failed to connect to bus'); } }]) {
      const setup = await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory, installSupervisor: true },
        coordinatorStatus as typeof fetch, { supervisorHost: host });
      assert.deepEqual({ supported: setup.supervisor!.supported, installed: setup.supervisor!.installed, state: setup.supervisor!.state }, { supported: false, installed: false, state: 'none' });
      // The limitation is stated, not implied: what does not happen, and what the operator must run.
      const instruction = setup.supervisor!.instruction!;
      assert.match(instruction, /self-healing does not apply here/);
      assert.match(instruction, /stays down until a person starts it/);
      assert.ok(instruction.includes(`${launcher} master run`), 'it names the command that keeps the loop alive');
      assert.ok(instruction.includes(root), 'and where to run it');
      assert.match(instruction, /start at boot/);
      // Setup says it on its own attention list and in what to do next, rather than only in a field.
      assert.equal(setup.attention.length, 1);
      assert.ok(setup.attention[0].includes(instruction));
      assert.ok(setup.next.startsWith(`${setup.attention[0]}.`), `next states the limitation first: ${setup.next}`);
      // Nothing was installed, so setup never reports a supervisor it does not have.
      assert.equal(setup.supervisor!.unitPath, null);
      assert.deepEqual(setup.supervisor!.performed, []);
    }

    // The same statement reaches master status, which never claims an unsupportable host is fine.
    const observed = await loopSupervision({ root, cliPath: launcher }, { platform: 'darwin' });
    assert.equal(observed.supported, false);
    assert.equal(observed.instruction, unsupervisedInstruction({ root, cliPath: launcher }));
    const [attention] = loopSupervisionAttention(observed);
    assert.match(attention.text, /not supervised on this host/);
    assert.equal(attention.next, observed.instruction);

    // And setup still completes: the configuration it wrote is the whole point of running it.
    assert.match(await readFile(join(root, '.graphyard/master.json'), 'utf8'), /"repository": "owner\/project"/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); }
});

test('integration:runtime-calls-bounded — a hung agent runtime fails its step, the cycle keeps going, and the loop still answers its stop signal', async () => {
  const stubs = await mkdtemp(join(tmpdir(), 'graphyard-supervision-runtime-'));
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-supervision-runtime-state-'));
  const root = await repository();
  const previousPath = process.env.PATH;
  try {
    // A runtime that accepts the call and never answers: the failure this bound exists for.
    await writeFile(join(stubs, 'herdr'), '#!/bin/sh\nexec sleep 600\n', { mode: 0o755 });
    process.env.PATH = `${stubs}:${previousPath}`;
    // The loop's own runner, at a bound short enough to measure; the shipped default is far longer.
    const bounded = agentRuntimeRun(400);

    const started = Date.now();
    assert.throws(() => listHerdrAgents(bounded), (error: NodeJS.ErrnoException & { killed?: boolean }) =>
      error.killed === true || error.code === 'ETIMEDOUT', 'the call is killed at its bound rather than waited on');
    assert.ok(Date.now() - started < 30_000, 'and it returns in the order of its bound, not of the runtime');
    // The step fails; Herdr is reported unavailable and Graphyard work state stays authoritative.
    assert.deepEqual(observeHerdrAgents(bounded), { agents: [], available: false, reason: 'Herdr session health is unavailable; Graphyard work state remains authoritative' });

    const credential = join(directory, 'coordinator.token');
    await writeFile(credential, coordinatorToken, { mode: 0o600 });
    const master = config(credential, { run: { intervalSeconds: 5 } });
    let cycles = 0;
    const effects = daemonEffects(root, master, {
      snapshot: async () => { if (++cycles >= 2) process.emit('SIGUSR2' as NodeJS.Signals); return { work: [], now: new Date().toISOString() }; },
      mutate: async () => ({}), executor: daemonExecutor('coordinator-1'), run: bounded,
    });
    // The loop's own reading of the runtime, through the hung stub: an empty answer, not a throw.
    assert.deepEqual(effects.agents(), []);

    const runStarted = Date.now();
    const result = await runDaemon(master, emptyDaemonState(master), effects,
      { intervalMs: 5, identity: { pid: process.pid, host: master.hostId }, signals: ['SIGUSR2'], log: () => {} });
    const elapsed = Date.now() - runStarted;
    assert.ok(result.cycles.length >= 2, `a hung runtime call ends its step, not the cycle: ${JSON.stringify(result.cycles)}`);
    assert.equal(result.stopped, true, 'and the loop answers its stop signal rather than staying wedged in the call');
    assert.ok(elapsed < loopStopTimeoutSeconds * 1000, `it stopped in ${elapsed}ms, inside the unit's ${loopStopTimeoutSeconds}s stop timeout`);

    // Every call into the runtime carries the bound, not just the ones a test reaches: these are
    // synchronous, so one unbounded call blocks the event loop and the SIGTERM handler with it.
    const master_ts = source('master.ts');
    for (const signature of [
      "export function herdrJson(args: string[], run: (command: string, args: string[]) => string = agentRuntimeRun())",
      "function herdrRun(args: string[], run: (command: string, args: string[]) => string = agentRuntimeRun())",
      "export function readSessionScreen(target: string, run: (command: string, args: string[]) => string = agentRuntimeRun(), lines = 80)",
    ]) assert.ok(master_ts.includes(signature), `the agent runtime is reached only through the bounded runner: ${signature}`);
    assert.doesNotMatch(master_ts, /execFileSync\([^)]*'herdr'/, 'no call reaches Herdr around the bounded runner');
    assert.match(master_ts, /agentRuntimeRun = \(timeoutMs: number = agentRuntimeTimeoutMs\)[\s\S]{0,300}?timeout: timeoutMs/);
    // The loop's other subprocess commands are bounded where it builds them.
    for (const file of ['master-daemon.ts', 'auto-dispatch.ts']) {
      const defaults = [...source(file).matchAll(/execFileSync\(command, args, \{[^}]*\}/g)];
      assert.ok(defaults.length, `${file} builds the loop's command runner`);
      for (const [call] of defaults) assert.match(call, /timeout:/, `${file} bounds every command the loop runs: ${call}`);
    }
  } finally {
    process.env.PATH = previousPath;
    await rm(stubs, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true }); await rm(root, { recursive: true, force: true });
  }
});

test('manual:supervisor-onboarding-review — the onboarding guide states that the loop must be supervised, how setup does it, and how to confirm it', async () => {
  const guide = await readFile(fileURLToPath(new URL('../docs/onboarding.md', import.meta.url)), 'utf8');
  for (const fragment of [loopUnitName, 'master status', 'systemctl --user enable --now', 'loginctl enable-linger', '--replace-supervisor', 'never a side effect']) {
    assert.ok(guide.includes(fragment), `docs/onboarding.md names ${fragment}`);
  }
  assert.match(guide, /^### The loop must be supervised$/m);
  // The unit the guide describes is the one setup writes, not a second description of it.
  const unit = loopUnitText({ root: '/path/to/coordinator-checkout', cliPath: launcher, repository: 'owner/project', intervalSeconds: 20 });
  assert.match(unit, /^Restart=always$/m);
  assert.ok(guide.includes('setup.supervisor'), 'the guide names the field an operator reads the answer from');
});

test('integration:supervisor-install-explicit-only — the unit is written only by an explicit operator install into the coordinator checkout on durable storage, never as a side effect', async () => {
  const root = await repository();
  const credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-supervision-explicit-credentials-'));
  const scratch = await mkdtemp(join(tmpdir(), 'graphyard-supervision-explicit-'));
  const home = join(scratch, 'home');
  const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  // The unit under the real user home, as it stands: this proof reads it and must leave it exactly so.
  const realUnit = join(loopUnitDirectory({ env: { ...process.env } }), loopUnitName);
  const realBefore = await fileState(realUnit);
  try {
    assert.ok(underTestRunner(), 'this proof runs under the test runner, which marks its processes; the shared guard keys on that mark');
    const setup = (input: Record<string, unknown> = {}, dependencies: Parameters<typeof setupMaster>[3] = {}) =>
      setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory, ...input }, coordinatorStatus as typeof fetch, dependencies);

    // 1. setupMaster with no supervisorHost and no option writes nothing outside the temporary root —
    //    not into the process's home either, which is redirected to a temp so a write would show.
    process.env.HOME = home; process.env.XDG_CONFIG_HOME = join(home, '.config');
    const plain = await setup();
    assert.equal(plain.supervisor, null, 'no option, no install, and nothing reported as installed');
    assert.deepEqual(plain.attention, []);
    assert.equal(await fileState(join(home, '.config/systemd/user', loopUnitName)), null, 'the process home holds no unit');
    // A host stub given without the option is not even consulted: the host is where, not whether.
    const idle = hostStub();
    const withHost = await setup({}, { supervisorHost: { ...idle.host, home } });
    assert.equal(withHost.supervisor, null);
    assert.deepEqual(idle.calls, [], 'a supervisor host without installSupervisor runs nothing');
    assert.equal(await fileState(join(home, '.config/systemd/user', loopUnitName)), null);
    process.env.HOME = previous.HOME; process.env.XDG_CONFIG_HOME = previous.XDG_CONFIG_HOME;
    if (previous.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;

    // 2. An explicit install whose WorkingDirectory is under the system temporary directory is
    //    refused by name, before anything is written or enabled, and setup still completes.
    const temporary = hostStub();
    delete (temporary.host as { temporaryDirectories?: string[] }).temporaryDirectories;
    const refusedByName = await setup({ installSupervisor: true }, { supervisorHost: { ...temporary.host, home } });
    assert.equal(refusedByName.supervisor!.state, 'refused');
    const named = temporaryDirectories().find(directory => refusedByName.supervisor!.refused!.includes(directory));
    assert.ok(named, `the refusal names the temporary directory: ${refusedByName.supervisor!.refused}`);
    assert.ok(refusedByName.supervisor!.refused!.includes(root), 'and the WorkingDirectory it refused');
    assert.match(refusedByName.supervisor!.instruction!, /master init from the coordinator checkout on durable storage/);
    assert.deepEqual(changes(temporary.calls), [], 'nothing was reloaded, enabled, started or restarted');
    assert.equal(await fileState(join(home, '.config/systemd/user', loopUnitName)), null, 'no unit was written');
    assert.deepEqual(refusedByName.supervisor!.performed, []);
    assert.equal(refusedByName.attention.length, 1);
    assert.ok(refusedByName.attention[0].includes(refusedByName.supervisor!.refused!) && refusedByName.attention[0].includes(refusedByName.supervisor!.instruction!), refusedByName.attention[0]);
    assert.ok(refusedByName.next.startsWith(`${refusedByName.attention[0]}.`), `next states the refusal first: ${refusedByName.next}`);
    assert.match(await readFile(join(root, '.graphyard/master.json'), 'utf8'), /"repository": "owner\/project"/, 'the configuration was still written');

    // 3. The installer's own refusals, against a host that declares its own temporary directory so
    //    the rest of this scratch space counts as durable for it.
    const volatile = join(scratch, 'volatile');
    const coordinator = join(scratch, 'coordinator');
    const unit = (checkout: string, cliPath = launcher, intervalSeconds = 20) => ({ root: checkout, cliPath, repository: 'owner/project', intervalSeconds });
    const stub = (states: Parameters<typeof hostStub>[0] = {}) => { const host = hostStub(states); return { calls: host.calls, host: { ...host.host, home, temporaryDirectories: [volatile] } }; };
    const configured = async (checkout: string) => { await mkdir(join(checkout, '.graphyard'), { recursive: true }); await writeFile(join(checkout, '.graphyard/master.json'), '{}\n'); return checkout; };
    const refusal = async (input: ReturnType<typeof unit>, expected: RegExp, options?: { replace?: boolean }) => {
      const host = stub();
      const result = await installLoopSupervisor(input, host.host, options);
      assert.equal(result.wrote, 'refused', `refused: ${JSON.stringify(result)}`);
      assert.match(result.refused!, expected);
      assert.deepEqual(changes(host.calls), [], `a refusal changes nothing on the host: ${result.refused}`);
      assert.deepEqual(result.performed, []);
      return result;
    };
    await refusal(unit(await configured(join(volatile, 'checkout'))), /under the temporary directory/);
    await refusal(unit(join(scratch, 'unconfigured')), /not the configured coordinator checkout/);
    await refusal(unit(await configured(join(scratch, 'durable', '.graphyard', 'worktrees', 'GY-1-1'))), /assignment worktree or session checkout/);
    await refusal(unit('relative/checkout'), /absolute path/);
    assert.equal(await fileState(join(home, '.config/systemd/user', loopUnitName)), null, 'none of them wrote the unit');

    // 4. The coordinator checkout installs; a unit that runs another loop is not replaced by a
    //    re-run from elsewhere unless the operator says so; the same loop is retuned without it.
    await configured(coordinator);
    const installed = await installLoopSupervisor(unit(coordinator), stub().host);
    assert.equal(installed.wrote, 'created');
    const unitPath = join(home, '.config/systemd/user', loopUnitName);
    const written = await readFile(unitPath, 'utf8');
    assert.match(written, new RegExp(`^WorkingDirectory=${coordinator}$`, 'm'));
    const other = await configured(join(scratch, 'other-checkout'));
    const foreign = await refusal(unit(other), /already runs a different loop/);
    assert.match(foreign.refused!, new RegExp(`WorkingDirectory=${coordinator}`));
    assert.match(foreign.instruction!, /master init --token-stdin --replace-supervisor/);
    assert.deepEqual({ installed: foreign.installed, enabled: foreign.enabled, active: foreign.active }, { installed: true, enabled: true, active: true }, 'what is there is reported as observed');
    await refusal(unit(coordinator, join(scratch, 'another-launcher.mjs')), /ExecStart=/);
    assert.equal(await readFile(unitPath, 'utf8'), written, 'the installed unit is untouched by a refused replacement');
    const retuned = stub();
    assert.equal((await installLoopSupervisor(unit(coordinator, launcher, 60), retuned.host)).wrote, 'updated', 'the same loop with a new interval is rewritten without a flag');
    assert.ok(retuned.calls.some(call => call[2] === 'restart'));
    // The packaged example, installed by hand for this same checkout, spells it with systemd's %h:
    // that is this loop, upgraded in place, not a foreign unit to refuse.
    const nested = await configured(join(home, 'code', 'coordinator'));
    await writeFile(unitPath, loopUnitText(unit(coordinator)).replace(`WorkingDirectory=${coordinator}`, 'WorkingDirectory=%h/code/coordinator').replace(` ${launcher} master run`, ` %h/code/coordinator/bin/graphyard.mjs master run`));
    const upgraded = await installLoopSupervisor(unit(nested, join(nested, 'bin/graphyard.mjs')), stub().host);
    assert.equal(upgraded.wrote, 'updated', `a hand-installed unit for the same checkout is upgraded, not refused: ${upgraded.refused}`);
    assert.match(await readFile(unitPath, 'utf8'), new RegExp(`^WorkingDirectory=${nested}$`, 'm'));
    await refusal(unit(coordinator), /already runs a different loop/);
    const replaced = stub();
    const replacement = await installLoopSupervisor(unit(other), replaced.host, { replace: true });
    assert.equal(replacement.wrote, 'updated');
    assert.match(await readFile(unitPath, 'utf8'), new RegExp(`^WorkingDirectory=${other}$`, 'm'));
    assert.deepEqual(changes(replaced.calls).map(call => call.slice(0, 3)), [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable'], ['systemctl', '--user', 'restart'], ['loginctl', 'enable-linger']]);

    // 5. The shared test guard: under the test runner, a home outside the system temporary
    //    directory is refused at the installer, whatever the test passed and before it reads or
    //    writes anything — the real user home included, which this proof leaves exactly as found.
    const realDirectory = join(homedir(), '.config/systemd/user');
    assert.throws(() => testSuiteHomeGuard(realDirectory), (error: unknown) => error instanceof LoopSupervisorRefusal && /test suite may not write/.test(error.message));
    assert.doesNotThrow(() => testSuiteHomeGuard(join(home, '.config/systemd/user')), 'a temp-rooted home passes');
    // The test-runner mark is this process's own, so the host's `env` — the documented way a test
    // redirects HOME, and the argument a test that "forgot" leaves empty — cannot switch the guard
    // off: every host below resolves the unit directory to the real user home and every one is refused.
    const hosts: Record<string, Partial<Parameters<typeof installLoopSupervisor>[1]>> = {
      'home: real': { home: homedir() },
      'env: {}': { env: {} },
      'env: { HOME: real }': { env: { HOME: homedir() } },
      'env: { PATH }': { env: { PATH: process.env.PATH } },
      'env: { XDG_CONFIG_HOME: real }': { env: { XDG_CONFIG_HOME: join(homedir(), '.config') } },
    };
    for (const [name, override] of Object.entries(hosts)) {
      const real = hostStub();
      const host = { ...real.host, temporaryDirectories: [volatile], ...override };
      assert.equal(loopUnitDirectory(host), realDirectory, `${name} resolves to the real unit directory`);
      const guarded = await installLoopSupervisor(unit(coordinator), host);
      assert.equal(guarded.wrote, 'refused', `${name}: ${JSON.stringify(guarded)}`);
      assert.match(guarded.refused!, /test suite may not write/, name);
      assert.match(guarded.instruction!, /home under the system temporary directory/, name);
      assert.deepEqual(changes(real.calls), [], `${name}: nothing was reloaded, enabled, started or restarted`);
      assert.deepEqual(guarded.performed, [], name);
      assert.equal(guarded.installed, realBefore !== null, `${name}: a refusal reports the unit that exists under the real home, not a state it never read`);
      assert.deepEqual(await fileState(realUnit), realBefore, `${name}: the unit under the real user home is exactly as it was`);
    }
    // Outside the test runner — the operator's `master init` — the guard is not a test guard. That
    // is shown by a process without the runner's marks, since nothing in-process can drop them.
    const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
    const bare = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT' && key !== 'npm_lifecycle_event' && !key.startsWith('NODE_OPTIONS')));
    const outside = execFileSync(process.execPath, ['--import', 'tsx', '-e',
      "import('./src/supervisor.ts').then(m => { m.testSuiteHomeGuard(process.env.GUARDED_DIRECTORY); console.log(JSON.stringify({ underTestRunner: m.underTestRunner() })); })"],
      { cwd: repositoryRoot, encoding: 'utf8', env: { ...bare, GUARDED_DIRECTORY: realDirectory }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
    assert.deepEqual(JSON.parse(outside.trim().split(/\r?\n/).at(-1)!), { underTestRunner: false }, 'without the marks the real home is not refused');

    // 6. Structurally: the install is reached from setupMaster only through the explicit option,
    //    which master init alone passes; nothing derives it from another argument; and the guard
    //    runs at the installer before its first write, so every test reaching either is covered.
    const master_ts = source('master.ts');
    assert.ok(master_ts.includes('input.installSupervisor === true ? await installLoopSupervisor('), 'setupMaster installs only on the explicit option');
    assert.doesNotMatch(master_ts, /credentialDirectory === undefined/, 'no other argument stands in for the option');
    assert.equal((master_ts.match(/installLoopSupervisor\(/g) ?? []).length, 1, 'one call site in setupMaster');
    const cli = source('cli/master.ts');
    assert.equal((cli.match(/installSupervisor: true/g) ?? []).length, 1, 'master init is the one command that passes it');
    assert.ok(cli.includes("'replace-supervisor': { type: 'boolean' }") && cli.includes("replaceSupervisor: !!values['replace-supervisor']"), 'and --replace-supervisor is the explicit replace flag');
    const sources = readdirSync(fileURLToPath(new URL('../src', import.meta.url)), { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.ts')).map(entry => resolve(entry.parentPath, entry.name));
    const callers = sources.filter(file => /(?<![.\w])installLoopSupervisor\(/.test(readFileSync(file, 'utf8'))).map(file => file.slice(file.indexOf('/src/') + 5));
    assert.deepEqual(callers.sort(), ['master.ts', 'supervisor.ts'], 'no other source reaches the installer');
    const supervisor_ts = source('supervisor.ts');
    const installer = supervisor_ts.slice(supervisor_ts.indexOf('export async function installLoopSupervisor('));
    assert.ok(installer.indexOf('testSuiteHomeGuard(unitDirectory);') > 0 && installer.indexOf('testSuiteHomeGuard(unitDirectory);') < installer.indexOf('await mkdir('), 'the guard runs before the installer writes, given the directory and nothing the caller built');
    assert.match(supervisor_ts, /^export function testSuiteHomeGuard\(unitDirectory: string\) \{$/m, 'the guard takes no env or argv override');
    assert.match(supervisor_ts, /^export const underTestRunner = \(\) =>/m, 'the runner mark is read from the real process only');
    assert.ok(installer.indexOf('assertCoordinatorCheckout(input.root') < installer.indexOf('await readFile('), 'and the WorkingDirectory is judged before the existing unit is read');
    assert.equal((await readdir(join(home, '.config/systemd/user'))).filter(name => name.endsWith('.tmp')).length, 0, 'no temporary unit file is left behind');
  } finally {
    process.env.HOME = previous.HOME; process.env.XDG_CONFIG_HOME = previous.XDG_CONFIG_HOME;
    if (previous.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
    await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); await rm(scratch, { recursive: true, force: true });
  }
});
