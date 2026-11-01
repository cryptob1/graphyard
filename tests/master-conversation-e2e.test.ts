import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildRun } from '../src/child-runner.js';
import { emptyRegistry, proposedRuntimes, unobservedQuota, type AgentRegistry, type FleetSession } from '../src/model/registry.js';
import type { FleetClient } from '../src/fleet.js';
import { launchMasterSession, masterSessionEffects } from '../src/master/master-session.js';
import { captureConversation } from '../src/master/conversation.js';
import { emptyDaemonState, readDaemonState, writeDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/** The Herdr transport launches real confined fixture processes; it does not simulate native state. */
async function fixture() {
  const scratch = await temporaryDirectory('master-conversation-e2e');
  const root = await temporaryDirectory('checkout', scratch), homes = await temporaryDirectory('accounts', scratch);
  const credentials = await temporaryDirectory('coordinator', scratch);
  execFileSync('git', ['init', '-q', root]);
  const binary = join(root, 'bin'); await mkdir(binary);
  const runtime = fileURLToPath(new URL('fixtures/master-runtime.mjs', import.meta.url));
  for (const kind of ['claude', 'codex']) await writeFile(join(binary, kind), `#!/bin/sh\nexec '${process.execPath}' '${runtime}' "$@"\n`, { mode: 0o700 });
  const accounts = await Promise.all(['claude-a', 'claude-b', 'codex-c'].map(async name => {
    const home = await temporaryDirectory(name, homes);
    await writeFile(join(home, 'login-marker'), name);
    return { name, runtime: name.split('-')[0], model: 'test', credential: { host: 'test-host', home }, enabled: true, maxSessions: null, quota: { ...unobservedQuota } };
  }));
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', repository: 'owner/repo', baseBranch: 'main', hostId: 'test-host', credentialFile: join(credentials, 'coordinator.token'), cliPath: '/bin/graphyard', githubAppId: 1, workers: [], masterAgentName: 'test-master', run: { launchStartSeconds: 10 } });
  const registry: AgentRegistry = { ...emptyRegistry(), accounts, runtimes: proposedRuntimes.filter(runtime => ['claude', 'codex'].includes(runtime.name)).map(runtime => ({ ...runtime, launch: { ...runtime.launch, environment: { PATH: `${binary}:${process.env.PATH}`, GY_RUNTIME: runtime.name } } })),
    models: [{ name: 'test', id: null, cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'strong', contextTokens: null } }], roles: [{ name: 'master', accounts: accounts.map(account => account.name), concurrency: 1 }] };
  let accountIndex = 0, allocation = 0, paneId = 0, stallPrompt = false;
  const ended: string[] = [];
  const client: FleetClient = { document: async () => registry, end: async id => { ended.push(id); }, select: async () => {
    const account = accounts[accountIndex], runtime = registry.runtimes.find(runtime => runtime.name === account.runtime)!;
    const session: FleetSession = { id: `allocation-${++allocation}`, role: 'master', account: account.name, runtime: runtime.name, model: 'test', host: 'test-host', work: null, principal: 'master', selectedAt: new Date().toISOString(), selectedBy: 'master', reason: 'fixture account', skipped: [], endedAt: null, endReason: null };
    return { selected: true, reason: 'fixture account', skipped: [], session, account, runtime, model: registry.models[0], revision: 1 };
  } };
  const panes = new Map<string, { env: NodeJS.ProcessEnv; child?: ChildProcessWithoutNullStreams; next?: () => Promise<void>; output: string; error: string }>();
  const resultFile = (pane: string) => join(root, '.graphyard', `${pane}.result.json`);
  const run: ChildRun = async (_command, args) => {
    const json = (result: unknown) => JSON.stringify({ result });
    if (args[0] === 'tab' && args[1] === 'create') {
      const pane = `pane-${++paneId}`;
      const env: NodeJS.ProcessEnv = { ...process.env, GY_RESULT: resultFile(pane), GY_OTHER_HOME: accounts[accountIndex === 0 ? 1 : 0].credential.home };
      for (let index = 0; index < args.length; index++) if (args[index] === '--env') { const value = args[++index], at = value.indexOf('='); env[value.slice(0, at)] = value.slice(at + 1); }
      panes.set(pane, { env, output: '', error: '' });
      return json({ pane_id: pane, tab_id: `tab-${paneId}` });
    }
    if (args[0] === 'pane' && args[1] === 'run') {
      const pane = panes.get(args[2])!;
      const own = accounts[accountIndex].credential.home;
      // Deny every other login directory even though the host owns them. The real launch wrapper
      // then mounts its managed transcript record read-only inside this outer confinement.
      const child = spawn('bwrap', ['--dev-bind', '/', '/', '--tmpfs', homes, '--bind', own, own, '--', 'bash', '-c', args[3]], { cwd: root, env: pane.env });
      pane.child = child;
      let waiting: (() => void) | null = null, queued = 0;
      pane.next = () => queued ? (queued--, Promise.resolve()) : new Promise<void>((resolve, reject) => {
        waiting = resolve;
        child.once('exit', code => reject(new Error(`runtime exited ${code}: ${pane.error}`)));
      });
      child.stderr.on('data', data => { pane.error += data; });
      child.stdout.on('data', data => {
        pane.output += data;
        for (const _line of String(data).trim().split('\n')) { if (waiting) { const resolve = waiting; waiting = null; resolve(); } else queued++; }
      });
      await pane.next();
      return json({});
    }
    if (args[0] === 'agent' && args[1] === 'get') {
      const pane = panes.get(args[2])!;
      return json({ agent: { agent: pane.env.GY_RUNTIME, agent_status: pane.child?.exitCode === null ? 'working' : 'exited' } });
    }
    if (args[0] === 'agent' && args[1] === 'rename') return json({});
    if (args[0] === 'agent' && args[1] === 'prompt') {
      const pane = panes.get(args[2])!;
      pane.child!.stdin.write(JSON.stringify({ input: args[3], partial: true }) + '\n'); await pane.next!();
      if (stallPrompt) { stallPrompt = false; throw Object.assign(new Error('agent_prompt_stalled'), { herdrCode: 'agent_prompt_stalled' }); }
      return json({});
    }
    if (args[0] === 'agent' && args[1] === 'wait') throw Object.assign(new Error('timeout'), { herdrCode: 'timeout' });
    if (args[0] === 'agent' && args[1] === 'read') return 'fixture runtime ready';
    if (args[0] === 'pane' && args[1] === 'read') return json({ text: 'fixture runtime ready' });
    if (args[0] === 'pane' && args[1] === 'list') return json({ panes: [] });
    if (args[0] === 'pane' && args[1] === 'close') { await stop(args[2]); return json({}); }
    throw new Error(`Unexpected fixture Herdr command ${args.join(' ')}`);
  };
  const stop = async (pane: string) => {
    const child = panes.get(pane)?.child;
    if (child && child.exitCode === null) { child.stdin.end(); const [code] = await once(child, 'exit'); assert.equal(code, 0, panes.get(pane)!.error); }
  };
  let state = emptyDaemonState(config);
  const effects: DaemonEffects = {
    snapshot: async () => ({ work: [], now: new Date().toISOString() }), agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}), closeSession: stop,
    dispatch: async () => { throw new Error('No workers in the continuity fixture'); }, persist: state => writeDaemonState(config, state),
    masterSession: { ...masterSessionEffects(root, () => config, run), initialize: undefined, pendingCauses: async () => [], end: client.end,
      launch: async (handover, previous) => {
        const { delivery: _, ...launched } = await launchMasterSession(root, config, { agents: [], available: true }, handover, run, { registry: client, quota: false, smoke: async () => ({ ok: true, error: null }) }, previous);
        return launched;
      } },
  };
  return { root, config, accounts, ended, get state() { return state; }, select: (index: number) => { accountIndex = index; },
    fail: (value: boolean) => { for (const runtime of registry.runtimes) runtime.launch.environment.GY_FAIL_RESUME = value ? '1' : '0'; },
    launch: async () => { await runCycle(config, state, effects); assert.equal(state.actions['master:launch']?.state, 'done', state.actions['master:launch']?.detail); return state.master; },
    failedLaunch: () => runCycle(config, state, effects),
    result: async () => JSON.parse(await readFile(resultFile(state.master.pane!), 'utf8')),
    emit: async (command: object) => { const pane = panes.get(state.master.pane!)!; pane.child!.stdin.write(JSON.stringify(command) + '\n'); await pane.next!(); },
    wake: async () => { stallPrompt = true; await effects.masterSession!.wake!(state.master.pane!, 'Automated wake must not replace the person', state.master.continuity); },
    stop: () => stop(state.master.pane!), reload: async () => { state = await readDaemonState(root, config); },
    dispose: async () => { for (const pane of panes.keys()) await stop(pane); },
  };
}

test('e2e:master-session-resumes — actual master end/relaunch reopens the authoritative native id on every supported runtime', async () => {
  const f = await fixture();
  try {
    for (const index of [0, 2]) {
      f.select(index); await f.launch();
      const first = await f.result(), allocation = f.state.master.session;
      await f.emit({ input: `Durable context on ${f.accounts[index].runtime}`, partial: true });
      await f.stop(); await f.reload(); await f.launch();
      const next = await f.result();
      assert.equal(next.id, first.id, 'the second process really reopened the native conversation');
      assert.match(next.prior, /Durable context/);
      assert.match(next.request, /Last unanswered person message: "Durable context/);
      assert.notEqual(f.state.master.session, allocation, 'the registry allocation is independent');
      assert.equal(next.recordWritable, false);
      await f.emit({ final: true });
      assert.equal(await captureConversation(f.state.master.continuity!.current), null, 'the resumed response completes the carried input batch');
      await f.stop();
    }
  } finally { await f.dispose(); }
});

test('e2e:master-continues-after-failover — cross-account/runtime, A-to-B-to-A, partial, tools, automated wakes and explicit none', async () => {
  const f = await fixture();
  try {
    await f.launch(); const a = f.state.master.continuity!.current;
    await f.emit({ input: 'What happened to my exact question?\nPlease carry this line.', partial: true, tool: true });
    await f.wake();
    await f.stop(); await f.reload(); f.select(1); await f.launch();
    const b = f.state.master.continuity!.current, resultB = await f.result();
    assert.notEqual(b.nativeId, a.nativeId);
    assert.match(resultB.request, new RegExp(a.nativeId));
    assert.match(resultB.request, /Last unanswered person message: "What happened to my exact question\?\\nPlease carry this line\."/);
    assert.match(resultB.predecessor, /What happened to my exact question/);
    assert.equal(resultB.recordWritable, false); assert.equal(resultB.otherHomeReadable, false);
    assert.equal(f.state.master.continuity!.predecessor!.supersededBy, b.launch);
    await f.emit({ input: 'B owns the newest decision', partial: true });
    await f.stop(); await f.reload(); f.select(0); await f.launch();
    const returned = await f.result();
    assert.notEqual(returned.id, a.nativeId, 'A must not resume the stale A conversation');
    assert.match(returned.request, new RegExp(b.nativeId));
    assert.match(returned.request, /Last unanswered person message: "B owns the newest decision"/);
    assert.match(returned.predecessor, /B owns the newest decision/);
    await f.emit({ input: 'Cross-runtime question', partial: true, tool: true });
    await f.stop(); await f.reload(); f.select(2); await f.launch();
    const codex = await f.result();
    assert.match(codex.request, /Last unanswered person message: "Cross-runtime question"/);
    assert.match(codex.predecessor, /Cross-runtime question/);
    assert.equal(codex.otherHomeReadable, false); assert.equal(codex.recordWritable, false);
    await f.emit({ input: 'This one is answered', final: true });
    assert.equal(await captureConversation(f.state.master.continuity!.current), null);
    await f.stop(); await f.reload(); f.select(1); await f.launch();
    const none = await f.result();
    assert.match(none.request, /Last unanswered person message: none$/);
    assert.match(none.predecessor, /This one is answered/);
    const before = structuredClone(f.state.master.continuity);
    await f.stop(); f.fail(true); await f.failedLaunch(); await f.reload();
    assert.equal(f.state.actions['master:launch'].state, 'failed');
    assert.match(f.state.actions['master:launch'].detail, /Fixture refuses native resume/);
    assert.deepEqual(f.state.master.continuity, before, 'failure must not supersede the authoritative predecessor');
    assert.equal(f.ended.at(-1), 'allocation-6', 'the refused resume returns its registry allocation');
    f.fail(false); await f.launch();
    assert.equal((await f.result()).id, before!.current.nativeId, 'retry resumes the retained conversation');
  } finally { await f.dispose(); }
});

test('e2e:master-continues-after-failover — another failover before the inherited question is answered preserves its original input', async () => {
  const f = await fixture();
  try {
    await f.launch();
    await f.emit({ input: 'This original question still needs an answer', partial: true });
    const original = f.state.master.continuity!.current;
    await f.stop(); f.select(1); await f.launch();
    await f.emit({ partial: true });
    await f.stop(); await f.reload(); f.select(2); await f.launch();
    const inherited = await f.result();
    assert.match(inherited.request, /Last unanswered person message: "This original question still needs an answer"/);
    assert.equal(f.state.master.continuity!.current.inherited!.record, original.record, 'only the original native input reference is carried, without a summary');
    await f.emit({ final: true });
    await f.stop(); await f.reload(); f.select(0); await f.launch();
    assert.match((await f.result()).request, /Last unanswered person message: none$/);
  } finally { await f.dispose(); }
});
