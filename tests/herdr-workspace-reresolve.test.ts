import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { herdrWorkspaceHealth, liveMasterConfig, loadMasterConfig, masterConfigSchema, type MasterConfig } from '../src/master.js';
import { reresolveHerdrWorkspace } from '../src/master/config.js';
import { herdrJson, herdrWorkspaceRefused, liveHerdrWorkspace } from '../src/master/herdr.js';
import { emptyDaemonState, noteConfigReload } from '../src/master-daemon.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Each test is named for the proof it produces (GY-2600): unit:herdr-workspace-reconfigured-when-gone,
// unit:workspace-not-found-triggers-reconfigure and unit:herdr-workspace-switch-on-ledger.

const at = '2030-01-01T12:00:00.000Z';
const refusal = '{"error":{"code":"workspace_not_found","message":"workspace w1V not found"},"id":"cli:tab:create"}';

/** A Herdr that lists WORKSPACES and runs the master agent in w4F. */
const herdr = (workspaces: string[]) => async (_command: string, args: string[]) => {
  const call = args[0] === '--session' ? args.slice(2) : args;
  if (call[0] === 'workspace') return JSON.stringify({ result: { workspaces: workspaces.map(workspace_id => ({ workspace_id })) } });
  if (call[0] === 'agent') return JSON.stringify({ result: { agents: [{ name: 'other', workspace_id: 'w2A' }, { name: 'graphyard-master-project', workspace_id: 'w4F' }] } });
  throw new Error(`unexpected herdr ${call.join(' ')}`);
};

/** A checkout whose .graphyard/master.json names the Herdr workspace WORKSPACE. */
async function installed(workspace: string) {
  const root = await temporaryDirectory('herdr-workspace'), credentials = await temporaryDirectory('herdr-workspace-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const credentialFile = join(credentials, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  await mkdir(join(root, '.graphyard'), { recursive: true });
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)), repository: 'owner/project', baseBranch: 'main',
    githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', herdrWorkspace: workspace, workers: [] });
  await writeFile(join(root, '.graphyard/master.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
  return root;
}
const stored = async (root: string) => JSON.parse(await readFile(join(root, '.graphyard/master.json'), 'utf8')).herdrWorkspace;
const reresolvingOn = (workspaces: string[]) => (root: string, config: MasterConfig) => reresolveHerdrWorkspace(root, config, current => liveHerdrWorkspace(current, herdr(workspaces)));

test('unit:herdr-workspace-reconfigured-when-gone — the cycle reload replaces a workspace Herdr no longer lists with the master agent\'s live one, and leaves a live one alone', async () => {
  const root = await installed('w1V');
  const live = liveMasterConfig(root, await loadMasterConfig(root), loadMasterConfig, () => Date.parse(at), reresolvingOn(['w2A', 'w4F']));
  const reload = await live.reload(true);
  assert.deepEqual([reload.workspace?.from, reload.workspace?.to], ['w1V', 'w4F'], 'the workspace the master agent runs in is adopted');
  assert.match(reload.workspace!.reason, /Herdr no longer lists workspace w1V \(it lists w2A, w4F\).*adopted w4F, where the master agent graphyard-master-project runs/);
  assert.deepEqual(reload.changed, ['herdrWorkspace']);
  assert.equal(live.current.herdrWorkspace, 'w4F', 'the loop launches into the new workspace from this cycle on');
  assert.equal(await stored(root), 'w4F', 'master.json records the switch');
  assert.equal((await live.reload(true)).workspace, null, 'a live workspace is left as it is');
  // With no master agent in any workspace, the first Herdr lists is taken.
  assert.equal((await liveHerdrWorkspace({ herdrWorkspace: 'w1V', masterAgentName: 'absent' }, herdr(['w2A', 'w4F'])))?.to, 'w2A');
  assert.equal(await liveHerdrWorkspace({ herdrWorkspace: 'w1V', masterAgentName: 'absent' }, herdr([])), null, 'nothing to adopt when Herdr lists no workspace');
});

test('unit:workspace-not-found-triggers-reconfigure — a launch refused with workspace_not_found re-resolves the workspace', async () => {
  const root = await installed('w1V');
  const live = liveMasterConfig(root, await loadMasterConfig(root), loadMasterConfig, () => Date.parse(at), reresolvingOn(['w4F']));
  assert.equal((await live.reload()).workspace, null, 'a dispatcher reload checks nothing before a refusal');
  assert.equal(await stored(root), 'w1V');
  // The tab create exits non-zero with Herdr's refusal on its output, as on GY-2517 and GY-2518.
  await assert.rejects(herdrJson(['tab', 'create', '--workspace', 'w1V'], async () => { throw Object.assign(new Error(`Command failed: herdr tab create --workspace w1V\n${refusal}`), { stdout: refusal }); }));
  assert.equal(herdrWorkspaceRefused(), true);
  await live.reload();
  assert.equal(live.current.herdrWorkspace, 'w4F', 'the refusal re-resolved the workspace at the next reload');
  assert.equal(herdrWorkspaceRefused(), false);
});

test('unit:herdr-workspace-switch-on-ledger — the switch is recorded on the loop\'s ledger with its reason, and the setup fault clears in the new workspace', async () => {
  const root = await installed('w1V');
  const live = liveMasterConfig(root, await loadMasterConfig(root), loadMasterConfig, () => Date.parse(at), reresolvingOn(['w4F']));
  assert.equal((await herdrWorkspaceHealth(live.current, herdr(['w4F']))).exists, false, 'the dead workspace is the standing setup fault');
  const state = emptyDaemonState(live.current);
  const noted = await noteConfigReload(state, await live.reload(true), async () => {});
  const switched = state.actions[`config:herdr-workspace:${at}`];
  assert.equal(switched?.kind, 'config');
  assert.equal(switched.state, 'done');
  assert.match(switched.detail, /^Switched herdrWorkspace from w1V to w4F: Herdr no longer lists workspace w1V/);
  assert.ok(noted.some(action => action.detail === switched.detail), 'the loop logs the switch it recorded');
  const health = await herdrWorkspaceHealth(live.current, herdr(['w4F']));
  assert.deepEqual([health.exists, health.reason], [true, null], 'launches go to a workspace Herdr lists, so the setup fault is gone');
});
