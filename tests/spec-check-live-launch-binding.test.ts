import { test } from './helpers/loop-state.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { databaseUrl } from './helpers/postgres.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { loadMasterConfig, type HerdrAgent } from '../src/master.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { daemonStateSchema } from '../src/daemon/state.js';
import { specCheckEndedKey } from '../src/daemon/cycle.js';
import { launchSpecCheck, type SpecCheckLaunchResult } from '../src/spec-check.js';
import { postSpecCheck } from '../src/spec-check-post.js';
import type { Work } from '../src/model.js';
import { fleet } from './helpers/review-fleet.js';
import { registryFixture } from './helpers/registry-fixture.js';

test('integration:spec-check-live-launch-binding — stale panes cannot replace a registered live checker; ended, reported and expired current launches still close', async () => {
  const database = await databaseUrl('spec-check-live-launch-binding');
  const host = await fleet({ name: 'checker', agentName: 'independent-checker', kind: 'claude', agentArgs: ['--setting-sources', 'user'] }, null);
  let store: Store | undefined;
  let http: ReturnType<typeof server> | undefined;
  try {
    store = new Store(database); await store.init();
    const coordinatorToken = 'test-coordinator-'.padEnd(48, 'x');
    const engine = new Engine(store, 120, 'owner/project');
    engine.gitRunner = null;
    http = server(engine, [{ id: 'master', role: 'coordinator', token: coordinatorToken }]);
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    const configFile = join(host.root, '.graphyard/master.json');
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    config.url = url;
    await writeFile(configFile, JSON.stringify(config));
    await writeFile(config.credentialFile, coordinatorToken, { mode: 0o600 });
    const git = (...args: string[]) => execFileSync('git', ['-C', host.root, ...args], { encoding: 'utf8' }).trim();
    await writeFile(join(host.root, 'README.md'), 'Named spec file.\n');
    git('add', 'README.md');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const master = await loadMasterConfig(host.root);
    // Initial fixture only. Every launch and report below uses the real HTTP control plane.
    const now = new Date().toISOString();
    let item = { id: '7c57685d-0000-4000-8000-000000003062', key: 'GY-3062', title: 'Export from settings', description: 'Read README.md and move export to settings.', type: 'feature', priority: 1, dependencies: [],
      criteria: [{ id: 'AC-1', text: 'Export works', proofs: ['e2e:export'] }], policy: { checks: ['test'], review: true },
      stage: 'ready', revision: 1, policyRevision: 1, createdAt: now, updatedAt: now, stageEnteredAt: now, ready: true, epoch: 0, lease: null,
      workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [],
    } as unknown as Work;
    await store.pool.query('INSERT INTO work_items(id,document) VALUES($1,$2)', [item.id, JSON.stringify(item)]);
    const read = async () => (await store!.pool.query('SELECT document FROM work_items WHERE id=$1', [item.id])).rows[0].document as Work;
    const launches: SpecCheckLaunchResult[] = [];
    const bindings = new Map<string, string>();
    const returnedRegistrations = new Map<string, string>();
    const run = (command: string, args: string[]) => command === 'git' ? execFileSync(command, args, { encoding: 'utf8' }) : host.run(command, args);
    const launch = async (work: Work, observedAt = new Date().toISOString()) => {
      // GY-3030: the registry grants every checker launch; each launch takes a fresh fixture, as each one's session ends with it.
      const launched = await launchSpecCheck(host.root, work, 'checker', [], observedAt, { run, probe: registryFixture(master.hostId!, ['claude'], ['reviewer']).probe });
      // Read the authoritative registration too, so base reaches the original invalid-token failure.
      const registration = (await read()).specCheckLaunch!.id;
      returnedRegistrations.set(registration, launched.launch);
      const result = { ...launched, launch: registration };
      const tab = host.calls.filter(args => args[0] === 'tab' && args[1] === 'create').at(-1)!;
      bindings.set(result.launch, tab.find(arg => arg.startsWith('GH_CONFIG_DIR='))!.slice('GH_CONFIG_DIR='.length));
      launches.push(result);
      return result;
    };
    const state = emptyDaemonState(master);
    const closed: string[] = [];
    const screens = new Map<string, string>();
    const inspected: string[] = [];
    const effects: DaemonEffects = {
      agents: () => [...host.agents] as HerdrAgent[], credentials: async () => ({}),
      snapshot: async () => ({ work: [await read()], now: new Date().toISOString() }),
      dispatch: async () => { throw new Error('No worker is configured'); },
      closeSession: pane => { closed.push(pane); host.run('herdr', ['pane', 'close', pane]); },
      sessionScreen: session => {
        inspected.push(session.pane!);
        return screens.get(session.pane!) ?? '';
      },
      launchSpecCheck: work => launch(work),
      persist: async () => {},
    };
    const cycle = async () => { await runCycle(master, state, effects); };
    // Use the binding directory the canonical launch actually handed its Herdr session.
    const report = (launched: SpecCheckLaunchResult) => postSpecCheck({
      verdict: 'gaps', paraphrase: 'Move export to settings; exercise export in AC-1.', gaps: ['Specify which export button starts the flow.'], cliPath: master.cliPath,
      environment: { GH_CONFIG_DIR: bindings.get(launched.launch)!, GRAPHYARD_URL: url, GRAPHYARD_SPEC_CHECK: item.key },
    });
    await cycle();
    const prior = launches[0];
    assert.ok(prior?.launch, JSON.stringify(state.actions));
    const priorBinding = Object.values(state.actions).find(action => action.pane === prior.pane)?.specCheckLaunch;
    // A separate canonical launch replaces the prior one without updating the daemon's action.
    const current = await launch(await read());
    host.run('herdr', ['pane', 'close', prior.pane!]);
    // A pre-upgrade cursor also has no binding: it must never be inferred from today's item.
    state.actions['spec-check:legacy'] = { ...Object.values(state.actions).find(action => action.pane === prior.pane)!, specCheckLaunch: undefined, pane: 'legacy-absent' };
    const restored = daemonStateSchema.parse(JSON.parse(JSON.stringify(state)));
    Object.assign(state, restored);
    inspected.length = 0;
    await cycle();
    // On base this cycle records current as ended, replaces its token, and report(current) fails "valid bearer token".
    const standing = (await read()).specCheckLaunch?.id;
    const endedRecord = state.actions[specCheckEndedKey(await read())];
    // Repeated snapshots cannot turn an untracked current launch into an ended one.
    await cycle(); await cycle();
    assert.ok(!inspected.includes(prior.pane!), 'stale actions never supply current liveness');
    await assert.rejects(report(prior), /valid Graphyard bearer token/, 'superseded credentials stay refused');
    // Track the independently launched current pane using exactly its returned registration.
    state.actions['spec-check:independent'] = { ...state.actions['spec-check:legacy'], pane: current.pane!, specCheckLaunch: current.launch };
    await cycle();
    assert.match(await report(current), /Spec check recorded/, 'the retained live launch accepts its bound report');
    assert.equal(returnedRegistrations.get(prior.launch), prior.launch, 'the launcher returns its control-plane registration');
    assert.equal(priorBinding, prior.launch, 'the daemon persists the exact registration returned by its launch');
    assert.equal(standing, current.launch, 'stale absent panes retain the current registered launch');
    assert.equal(endedRecord, undefined, 'a stale pane records no current end');
    assert.equal(launches.length, 2, 'no token replacement');
    assert.ok(!closed.includes(current.pane!), 'the bound live current pane stays open');
    await assert.rejects(report(current), /valid Graphyard bearer token/, 'one verdict per launch');
    await cycle();
    assert.ok(closed.includes(current.pane!), 'reported independent pane closes');
    assert.equal(launches.length, 2, 'reported check does not relaunch');
    // A second initial feature exercises current-session exit and expiry with the same real machinery.
    item = { ...item, id: '7c57685d-0000-4000-8000-000000003063', key: 'GY-3063' };
    await store.pool.query('INSERT INTO work_items(id,document) VALUES($1,$2)', [item.id, JSON.stringify(item)]);
    await cycle();
    const ended = launches[2];
    host.run('herdr', ['pane', 'close', ended.pane!]);
    await cycle();
    assert.ok(state.actions[`spec-check-ended:${item.id}:${ended.launch}`]);
    assert.equal(launches.length, 4);
    await assert.rejects(report(ended), /valid Graphyard bearer token/);
    const retry = launches[3];
    screens.set(retry.pane!, 'BLOCKED: the spec checker cannot read the named file');
    await cycle();
    assert.ok(closed.includes(retry.pane!), 'a genuinely blocked current pane closes');
    assert.match(state.actions[`spec-check-ended:${item.id}:${retry.launch}`].detail, /BLOCKED: the spec checker cannot read/);
    assert.equal(launches.length, 5, 'blocked current launch retries exactly once');
    await assert.rejects(report(retry), /valid Graphyard bearer token/);
    const afterBlocked = launches[4];
    await cycle();
    assert.equal(launches.length, 5, 'the ended record does not end its live successor');
    // Expiry uses the real registration path, without editing authoritative launch state.
    const expired = await launch(await read(), new Date(Date.now() - 3_600_001).toISOString());
    state.actions['spec-check:expired'] = { ...state.actions['spec-check:independent'], work: item.key, pane: expired.pane!, specCheckLaunch: expired.launch };
    await cycle();
    assert.ok(closed.includes(expired.pane!), 'expired current pane closes');
    assert.equal(launches.length, 7, 'expired launch retries');
    await assert.rejects(report(expired), /valid Graphyard bearer token/);
    await assert.rejects(report(retry), /valid Graphyard bearer token/);
    await assert.rejects(report(afterBlocked), /valid Graphyard bearer token/);
    const final = launches[6];
    assert.match(await report(final), /Spec check recorded/, 'the bound current independent reviewer can post its report');
    await assert.rejects(report(final), /valid Graphyard bearer token/, 'one verdict per launch');
    await cycle();
    assert.ok(closed.includes(final.pane!), 'reported current pane closes');
    assert.equal(launches.length, 7, 'reported check does not relaunch');
    assert.equal((await read()).specCheck?.verdict, 'gaps');
    assert.equal((await read()).candidate, null, 'no approval or merge gate is fabricated');
  } finally {
    if (http) await new Promise<void>((resolve, reject) => http!.close(error => error ? reject(error) : resolve()));
    if (store) await store.close();
    await host.cleanup();
  }
});
