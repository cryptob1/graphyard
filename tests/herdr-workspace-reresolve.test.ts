import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { herdrWorkspaceHealth, liveMasterConfig, loadMasterConfig, masterConfigSchema, type MasterConfig } from '../src/master.js';
import { reresolveHerdrWorkspace } from '../src/master/config.js';
import { herdrJson, herdrWorkspaceRefused, liveHerdrWorkspace } from '../src/master/herdr.js';
import { emptyDaemonState, noteConfigReload, type DaemonEffects } from '../src/master-daemon.js';
import { requeueWorkspaceRefusals } from '../src/daemon/remedies.js';
import { Launcher, type Cycle } from '../src/daemon/cycle.js';
import { Timings } from '../src/master/timings.js';
import { emptyHeldDecisions } from '../src/daemon/decision-reads.js';
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

function item(overrides: Partial<Work>): Work {
  return { id: 'id-GY-2517', key: 'GY-2517', title: 'Item', description: '', type: 'bug', priority: 1, dependencies: [], criteria: [], policy: { checks: ['test'], review: true }, 
    stage: 'build', revision: 7, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 4, lease: null, workspaces: [], candidate: null, submission: null,
    reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [], ...overrides } as Work;
}
function cycle(config: MasterConfig, work: Work[], unblock: DaemonEffects['unblock']): Cycle {
  const clock = Date.parse(at);
  return { config, state: emptyDaemonState(config), effects: { persist: async () => {}, unblock } as unknown as DaemonEffects, now: () => clock, snapshot: { work, now: at }, clock, clockOffset: { min: 0, max: 0 },
    performed: [], agents: [], credentials: {}, open: work, owns: () => false, heldBy: () => null, timings: new Timings(() => clock), launcher: new Launcher(Number.POSITIVE_INFINITY),
    launch: () => false, detached: false, heldDecisions: emptyHeldDecisions(), isolate: async (_kind: string, _item: Work, _name: string, body: () => Promise<unknown>) => await body() } as unknown as Cycle;
}

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

test('unit:workspace-not-found-triggers-reconfigure — a launch refused with workspace_not_found re-resolves the workspace and re-queues the items the loop stopped dispatching', async () => {
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
  const state = emptyDaemonState(live.current);
  state.dispatchFailures['id-GY-2517'] = { key: 'GY-2517', cause: refusal, count: 2, epoch: 4, firstAt: at, lastAt: at };
  state.dispatchFailures['id-GY-9'] = { key: 'GY-9', cause: 'a worktree held its branch', count: 2, epoch: 1, firstAt: at, lastAt: at };
  await noteConfigReload(state, await live.reload(true), async () => {});
  assert.deepEqual(Object.keys(state.dispatchFailures), ['id-GY-9'], 'the failure run the dead workspace caused is forgotten; any other stands');
  // The items already blocked on that cause are unblocked, at the revision read, once.
  const blocked = item({ blocker: `Dispatch failed 3 consecutive times with the same cause since ${at}, so the master loop stopped redispatching GY-2517: ${refusal}` });
  const current = item({ id: 'id-GY-2518', key: 'GY-2518', blocker: `Dispatch failed 3 consecutive times with the same cause since ${at}, so the master loop stopped redispatching GY-2518: ${refusal.replaceAll('w1V', 'w4F')}` });
  const unblocked: string[] = [];
  const remedy = cycle(live.current, [blocked, current], async (target, reason) => { unblocked.push(`${target.key}@${target.revision}: ${reason}`); return { ...target, blocker: null }; });
  await requeueWorkspaceRefusals(remedy);
  await requeueWorkspaceRefusals(remedy);
  assert.equal(unblocked.length, 1, 'only the item blocked on the dead workspace is re-queued, once');
  assert.match(unblocked[0], /^GY-2517@7: The loop re-queued GY-2517: .*workspace w1V no longer exists, and the loop now launches into w4F/);
  assert.ok(remedy.performed.some(action => action.work === 'GY-2517' && action.state === 'done' && /Re-queued GY-2517/.test(action.detail)));
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
