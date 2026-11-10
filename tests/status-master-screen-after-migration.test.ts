import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { migrateHerdr } from '../src/herdr-migration.js';
import { applyHerdrConfig } from '../src/master/config.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import { herdrScope, herdrTarget, scopeHerdr, targetHerdr, isHerdrCommand } from '../src/master/herdr.js';
import { daemonStatePath, emptyDaemonState } from '../src/daemon/state.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

test('e2e:status-master-screen-after-migration — status reads the live main-Herdr master despite an inherited private socket and reports read errors', async () => {
  const root = await temporaryDirectory('status-master-migration');
  const home = await temporaryDirectory('status-master-home');
  await defaultChildRun('git', ['init', root]);
  await mkdir(join(root, '.graphyard'));
  const file = join(root, '.graphyard/master.json');
  const instance = { configHome: join(home, 'private-herdr'), session: 'private' };
  await writeFile(file, JSON.stringify(masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example',
    credentialFile: join(home, 'coordinator.token'), cliPath: '/bin/graphyard', repository: 'fixture/status',
    baseBranch: 'main', hostId: 'fixture', masterAgentName: 'master', workers: [],
    herdrWorkspace: 'wOld', herdrInstance: instance })));
  // A private worker still drains, while the master has moved to the main server.
  await migrateHerdr(root, async (_command, args) => args[0] === '--session'
    ? JSON.stringify({ panes: [{ pane_id: 'wOld:p1' }] })
    : JSON.stringify({ workspaces: [{ workspace_id: 'wMain', label: 'graphyard-fixture-status' }] }), home);
  const config = masterConfigSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  assert.equal(config.herdrWorkspace, 'wMain');
  assert.deepEqual(config.herdrInstance, instance);
  const previousTarget = herdrTarget(), previousScope = herdrScope();
  const variables = ['HERDR_SOCKET_PATH', 'GRAPHYARD_HERDR_CONFIG_HOME', 'GRAPHYARD_HERDR_SESSION', 'XDG_CONFIG_HOME'] as const;
  const previous = Object.fromEntries(variables.map(key => [key, process.env[key]]));
  try {
    applyHerdrConfig(config);
    process.env.HERDR_SOCKET_PATH = join(instance.configHome, 'old.sock');
    delete process.env.GRAPHYARD_HERDR_CONFIG_HOME;
    delete process.env.GRAPHYARD_HERDR_SESSION;
    const state = emptyDaemonState(config);
    state.master = { ...state.master, agentName: 'master', pane: 'wOld:p2', runtime: 'claude' };
    await writeFile(daemonStatePath(config), JSON.stringify(state));
    let status = 'working', failure: string | null = null;
    const reads: string[] = [];
    const run: ChildRun = async (command, args, options) => {
      if (!isHerdrCommand(command)) return 'a'.repeat(40);
      const env = options?.env ?? process.env;
      assert.equal(env.HERDR_SOCKET_PATH, undefined, 'the main server must not inherit the old pane socket');
      assert.notEqual(args[0], '--session', 'the legacy instance is only a drain record');
      if (process.env.GRAPHYARD_HERDR_CONFIG_HOME) {
        assert.equal(env.XDG_CONFIG_HOME, join(homedir(), '.config'));
        assert.equal(env.GRAPHYARD_HERDR_CONFIG_HOME, undefined);
        assert.equal(env.GRAPHYARD_HERDR_SESSION, undefined);
      }
      if (args[0] === 'agent' && args[1] === 'list') return JSON.stringify({ agents: [{ name: 'master', pane_id: 'wMain:p2', agent_status: status }] });
      assert.deepEqual(args, ['agent', 'read', 'wMain:p2', '--source', 'recent-unwrapped', '--lines', '80']);
      reads.push(args[2]);
      if (failure) throw new Error(failure);
      return 'Coordinating fixture work';
    };
    const report = () => masterStatusReport(root, config, async () => ({ work: [], now: new Date().toISOString() }), run);
    for (const legacyEnvironment of [false, true]) {
      if (legacyEnvironment) {
        process.env.GRAPHYARD_HERDR_CONFIG_HOME = instance.configHome;
        process.env.GRAPHYARD_HERDR_SESSION = instance.session;
        process.env.XDG_CONFIG_HOME = instance.configHome;
      }
      for (status of ['working', 'idle', 'done']) {
        const result = await report();
        assert.equal(result.masterSession.state, status);
        assert.equal(result.masterSession.pane, 'wMain:p2');
        assert.equal(result.masterSession.screenError, null);
      }
      failure = 'Herdr read failed: connection reset by peer';
      const unreadable = await report();
      assert.equal(unreadable.masterSession.state, 'screen unreadable');
      assert.equal(unreadable.masterSession.screenError, failure);
      failure = null;
    }
    assert.equal(reads.length, 8);
  } finally {
    for (const key of variables) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    targetHerdr(previousTarget); scopeHerdr(previousScope);
  }
});
