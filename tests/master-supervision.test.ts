import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentRuntimeRun, agentRuntimeTimeoutMs, daemonExecutor, listHerdrAgents, masterConfigSchema, masterHarness, observeHerdrAgents, setupMaster, type MasterConfig } from '../src/master.js';
import { daemonEffects, emptyDaemonState, runDaemon, writeDaemonState } from '../src/master-daemon.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { installLoopSupervisor, loopStopTimeoutSeconds, loopSupervision, loopSupervisionAttention, loopUnitName, loopUnitText, loopWatchdogSeconds, supervisorSupport, unsupervisedInstruction } from '../src/supervisor.js';

/**
 * Each test is named for the proof it produces (GY-114): integration:setup-installs-supervisor,
 * unit:supervision-reported, unit:unsupervised-host-stated and integration:runtime-calls-bounded.
 *
 * GY-84 promised that "a supervised deployment restarts it automatically". Nothing installed that
 * supervisor and nothing checked for one, so the promise held only where somebody had copied the
 * packaged unit by hand. These cover the three halves of closing that: setup installs it, status
 * verifies it, and a host that cannot have one is told so instead of being left to find out.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const source = (name: string) => readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), 'utf8');

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
 * way the real one does — on stdout, with a non-zero exit for every state but the good one.
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
      run: (command: string, args: string[]) => {
        calls.push([command, ...args]);
        if (command === 'loginctl' && args[0] === 'show-user') return `${states.linger ?? 'yes'}\n`;
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

test('integration:setup-installs-supervisor — setup writes, enables and starts the loop unit, and a second run changes nothing', async () => {
  const root = await repository();
  const credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-supervision-credentials-'));
  const home = await mkdtemp(join(tmpdir(), 'graphyard-supervision-home-'));
  try {
    const first = hostStub();
    const setup = await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory, run: { intervalSeconds: 20 } },
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
    assert.deepEqual(first.calls.filter(call => call[0] === 'systemctl' && ['daemon-reload', 'enable'].includes(call[2])),
      [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', loopUnitName]]);
    assert.ok(first.calls.some(call => call[0] === 'loginctl' && call[1] === 'enable-linger'), 'the user manager is made to start at boot');
    assert.deepEqual({ installed: setup.supervisor!.installed, enabled: setup.supervisor!.enabled, active: setup.supervisor!.active, linger: setup.supervisor!.linger },
      { installed: true, enabled: true, active: true, linger: true });
    // It reports what it installed, in the words of the commands it ran.
    assert.ok(setup.supervisor!.performed.some(step => step.includes(unitPath)));
    assert.ok(setup.supervisor!.performed.includes(`systemctl --user enable --now ${loopUnitName}`));
    assert.deepEqual(setup.attention, [], 'a supervised installation raises nothing');

    // Re-running setup is idempotent: the same unit content is left alone and nothing is reloaded.
    const again = hostStub();
    const repeated = await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory, run: { intervalSeconds: 20 } },
      coordinatorStatus as typeof fetch, { supervisorHost: { ...again.host, home } });
    assert.equal(repeated.supervisor!.state, 'unchanged');
    assert.equal(await readFile(unitPath, 'utf8'), unit, 'the unit on disk is byte-for-byte what the first run wrote');
    assert.equal(again.calls.some(call => call[2] === 'daemon-reload'), false, 'an unchanged unit is not reloaded');
    assert.ok(again.calls.some(call => call[2] === 'enable'), 'enabling stays idempotent rather than conditional');
    assert.deepEqual({ enabled: repeated.supervisor!.enabled, active: repeated.supervisor!.active }, { enabled: true, active: true });

    // A changed interval rewrites the unit and reloads it, so the watchdog window follows the loop.
    const retuned = hostStub();
    const rewritten = await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory, run: { intervalSeconds: 120 } },
      coordinatorStatus as typeof fetch, { supervisorHost: { ...retuned.host, home } });
    assert.equal(rewritten.supervisor!.state, 'updated');
    assert.match(await readFile(unitPath, 'utf8'), new RegExp(`^WatchdogSec=${loopWatchdogSeconds(120)}$`, 'm'));
    assert.ok(retuned.calls.some(call => call[2] === 'daemon-reload'), 'a rewritten unit is reloaded before it is enabled');
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

    // Installed, enabled and running: the setup section says so and raises nothing.
    await installLoopSupervisor({ root, cliPath: launcher, repository: 'owner/project', intervalSeconds: 20 }, { ...hostStub().host, home });
    const healthy = await report({ ...hostStub().host, home });
    assert.deepEqual({ supported: healthy.setup.supervisor.supported, installed: healthy.setup.supervisor.installed, enabled: healthy.setup.supervisor.enabled, active: healthy.setup.supervisor.active },
      { supported: true, installed: true, enabled: true, active: true });
    assert.deepEqual(healthy.setup.attention, []);
    assert.equal(healthy.attentionItems.some(item => /supervis/i.test(item.text)), false, 'a supervised loop is not an attention item');

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
      const setup = await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory },
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
  for (const fragment of [loopUnitName, 'master status', 'systemctl --user enable --now', 'loginctl enable-linger']) {
    assert.ok(guide.includes(fragment), `docs/onboarding.md names ${fragment}`);
  }
  assert.match(guide, /^### The loop must be supervised$/m);
  // The unit the guide describes is the one setup writes, not a second description of it.
  const unit = loopUnitText({ root: '/path/to/coordinator-checkout', cliPath: launcher, repository: 'owner/project', intervalSeconds: 20 });
  assert.match(unit, /^Restart=always$/m);
  assert.ok(guide.includes('setup.supervisor'), 'the guide names the field an operator reads the answer from');
});
