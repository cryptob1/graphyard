import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { launchAppearanceMs } from '../src/daemon/effects.js';
import { harnessDecision } from '../src/harness.js';
import * as herdrModule from '../src/master/herdr.js';
import { closeHerdrPane, listHerdrAgents, listHerdrPanes, observeHerdrAgents, stopCreatedHerdrTab } from '../src/master/herdr.js';
import { liveMasterConfig, loadMasterConfig, masterConfigSchema, masterHarness, setupMaster, type MasterConfig } from '../src/master.js';
import { executorUnitTemplate, installExecutorSupervision, type SystemctlRunner } from '../src/repository-setup.js';
import * as supervisorModule from '../src/supervisor.js';
import { installLoopSupervisor, loopUnitText } from '../src/supervisor.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1441: several installations on one host. The greenfield pilot (2026-10-07) ran a second
 * install on the host that serves production and found three ways it could disrupt the first: a
 * shared executor unit its setup rewrote and restarted, Herdr sweeps that acted on every pane on
 * the host, and a fixed master unit the new install's harness let its master restart. Each test is
 * named for the proof it produces: unit:per-install-units, unit:herdr-scope-per-install and
 * unit:harness-own-units-only.
 */

// What GY-1441 adds is read when a test runs, never at load: a checkout without it fails each test, not the file.
const units = () => import('../src/install/units.js');
const loopUnitOf = (root: string) => (supervisorModule as unknown as { loopUnitOf: (root: string) => string }).loopUnitOf(root);
const scope = herdrModule as unknown as { scopeHerdr: (workspace: string | null) => void; herdrScope: () => string | null };
const legacyLoopUnit = 'graphyard-master.service';
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const template = await readFile(fileURLToPath(new URL(`../examples/master/${executorUnitTemplate}`, import.meta.url)), 'utf8');

/** A coordinator checkout of REPOSITORY: a git repository holding the master configuration both installers read. */
async function checkout(label: string, repository: string) {
  const root = await temporaryDirectory(label);
  execFileSync('git', ['init', '-q', root]);
  await mkdir(join(root, '.graphyard'), { recursive: true });
  await writeFile(join(root, '.graphyard/master.json'), JSON.stringify({ repository }));
  return root;
}
/** The host's user manager, shared by every install: it records each command and knows every instance any install enabled. */
function userManager() {
  const calls: string[][] = [];
  const enabled = new Set<string>();
  const run: SystemctlRunner = args => {
    calls.push(args);
    if (args[0] === 'enable') for (const unit of args.slice(2)) enabled.add(unit);
    if (args[0] === 'disable') for (const unit of args.slice(2)) enabled.delete(unit);
    if (args[0] === 'list-units' || args[0] === 'list-unit-files') {
      const pattern = new RegExp(`^${args.at(-1)!.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
      return [...enabled].filter(unit => pattern.test(unit)).map(unit => `${unit} loaded active running`).join('\n');
    }
    if (args[0] === 'is-active') return 'active';
    return '';
  };
  const loopHost = (home: string) => ({ platform: 'linux' as NodeJS.Platform, home, temporaryDirectories: [] as string[], run: (command: string, args: string[]) => { if (command === 'systemctl') { run(args.slice(1)); } return args.includes('is-enabled') ? 'enabled' : args.includes('is-active') ? 'active' : ''; } });
  return { calls, enabled, run, loopHost };
}
const naming = (calls: string[][], unit: string) => calls.filter(args => args.some(arg => arg === unit || arg.startsWith(unit.replace('@.service', '@'))));
const mutating = (calls: string[][]) => calls.filter(args => ['enable', 'disable', 'restart', 'start', 'stop'].includes(args[0]));

test('unit:per-install-units — two installs on one host write, enable and restart only their own per-install units; a unit another checkout runs is refused by name; a legacy host keeps its names through a recorded alias', async () => {
  const { ForeignUnitRefusal, installUnitsFile, perInstallUnits, readInstallUnits, resolveInstallUnits } = await units();
  const home = await temporaryDirectory('multi-install-home');
  const unitDirectory = join(home, '.config/systemd/user');
  const host = userManager();
  const alpha = await checkout('install-alpha', 'cryptob1/graphyard');
  const beta = await checkout('install-beta', 'cryptob1/graphyard-game-pilot');
  const alphaUnits = perInstallUnits('cryptob1/graphyard'), betaUnits = perInstallUnits('cryptob1/graphyard-game-pilot');
  assert.equal(alphaUnits.master, 'graphyard-master-cryptob1-graphyard.service');
  assert.equal(betaUnits.executorTemplate, 'graphyard-executor-cryptob1-graphyard-game-pilot@.service');

  // The first install: its loop and two executor slots, under its own names, recorded beside its configuration.
  const alphaLoop = await installLoopSupervisor({ root: alpha, cliPath: launcher, repository: 'cryptob1/graphyard', intervalSeconds: 20 }, host.loopHost(home));
  assert.equal(alphaLoop.unit, alphaUnits.master);
  assert.equal(alphaLoop.unitPath, join(unitDirectory, alphaUnits.master));
  assert.deepEqual(readInstallUnits(alpha), alphaUnits, 'the names are recorded in .graphyard/units.json');
  assert.equal(loopUnitOf(alpha), alphaUnits.master, 'every reader of the loop unit names the recorded one');
  const alphaExecutors = await installExecutorSupervision(alpha, { count: 2, run: host.run, unitDirectory, template, node: process.execPath, loop: null });
  assert.equal(alphaExecutors.unitFile, join(unitDirectory, alphaUnits.executorTemplate));
  assert.deepEqual(alphaExecutors.units.map(slot => slot.unit), ['graphyard-executor-cryptob1-graphyard@1.service', 'graphyard-executor-cryptob1-graphyard@2.service']);
  const alphaFiles = { loop: await readFile(alphaLoop.unitPath!, 'utf8'), executor: await readFile(alphaExecutors.unitFile!, 'utf8') };

  // The second install's whole setup pass, with one slot: it writes and starts its own units, and
  // neither rewrites, restarts, disables nor otherwise names the first install's.
  const before = host.calls.length;
  const betaLoop = await installLoopSupervisor({ root: beta, cliPath: launcher, repository: 'cryptob1/graphyard-game-pilot', intervalSeconds: 20 }, host.loopHost(home));
  const betaExecutors = await installExecutorSupervision(beta, { count: 1, run: host.run, unitDirectory, template, node: process.execPath, loop: null });
  const betaCalls = host.calls.slice(before);
  assert.equal(betaLoop.unit, betaUnits.master);
  assert.equal(betaLoop.wrote, 'created');
  assert.deepEqual(betaExecutors.units.map(slot => slot.unit), ['graphyard-executor-cryptob1-graphyard-game-pilot@1.service']);
  assert.deepEqual(betaExecutors.disabled, [], 'the first install\'s slot 2 is not the second install\'s to disable');
  assert.deepEqual(naming(betaCalls, alphaUnits.master), [], 'the second install never names the first install\'s loop');
  assert.deepEqual(betaCalls.filter(args => args.some(arg => arg.startsWith('graphyard-executor-cryptob1-graphyard@'))), [], 'nor its executors');
  assert.ok(host.enabled.has('graphyard-executor-cryptob1-graphyard@2.service'), 'the first install\'s slot 2 stays enabled');
  assert.equal(await readFile(alphaLoop.unitPath!, 'utf8'), alphaFiles.loop, 'the first install\'s loop unit is untouched');
  assert.equal(await readFile(alphaExecutors.unitFile!, 'utf8'), alphaFiles.executor, 'and its executor template too');

  // A re-run of the first install's setup at a lower count disables its own surplus slot and nothing of the second's.
  const rerun = host.calls.length;
  const shrunk = await installExecutorSupervision(alpha, { count: 1, run: host.run, unitDirectory, template, node: process.execPath, loop: null });
  assert.deepEqual(shrunk.disabled, ['graphyard-executor-cryptob1-graphyard@2.service']);
  assert.deepEqual(mutating(host.calls.slice(rerun)).flat().filter(arg => arg.includes('game-pilot')), [], 'the first install never touches the second\'s units');

  // A checkout whose units collide with another checkout's (the same repository cloned again) is
  // refused by name: nothing is rewritten, enabled or restarted.
  const clone = await checkout('install-clone', 'cryptob1/graphyard');
  const cloneCalls = host.calls.length;
  await assert.rejects(installExecutorSupervision(clone, { count: 1, run: host.run, unitDirectory, template, node: process.execPath, loop: null }),
    (error: unknown) => error instanceof ForeignUnitRefusal && error.message.includes(alpha) && error.message.includes(alphaUnits.executorTemplate));
  const cloneLoop = await installLoopSupervisor({ root: clone, cliPath: launcher, repository: 'cryptob1/graphyard', intervalSeconds: 20 }, host.loopHost(home));
  assert.equal(cloneLoop.wrote, 'refused');
  assert.match(cloneLoop.refused!, new RegExp(`already runs a different loop \\(WorkingDirectory=${alpha}`));
  assert.deepEqual(mutating(host.calls.slice(cloneCalls)), [], 'a refused install enables, restarts and disables nothing');
  assert.equal(await readFile(alphaLoop.unitPath!, 'utf8'), alphaFiles.loop);

  // An existing single-install host: its legacy unit runs this checkout, so the install records the
  // legacy names as its alias and keeps writing and restarting exactly the unit it always had.
  const legacyHome = await temporaryDirectory('multi-install-legacy-home');
  const legacyDirectory = join(legacyHome, '.config/systemd/user');
  const production = await checkout('install-production', 'cryptob1/graphyard');
  await mkdir(legacyDirectory, { recursive: true });
  await writeFile(join(legacyDirectory, legacyLoopUnit), loopUnitText({ root: production, cliPath: launcher, repository: 'cryptob1/graphyard', intervalSeconds: 20 }));
  const legacy = userManager();
  const kept = await installLoopSupervisor({ root: production, cliPath: launcher, repository: 'cryptob1/graphyard', intervalSeconds: 20 }, legacy.loopHost(legacyHome));
  assert.equal(kept.unit, legacyLoopUnit);
  assert.equal(kept.wrote, 'unchanged');
  assert.deepEqual(JSON.parse(await readFile(join(production, installUnitsFile), 'utf8')), { version: 1, slug: null, master: legacyLoopUnit, executorTemplate: 'graphyard-executor@.service', alias: true });
  const keptExecutors = await installExecutorSupervision(production, { count: 1, run: legacy.run, unitDirectory: legacyDirectory, template, node: process.execPath, loop: null });
  assert.deepEqual(keptExecutors.units.map(slot => slot.unit), ['graphyard-executor@1.service'], 'the aliased install keeps its legacy executor names');
  // The pilot on that host: the legacy unit is production's, so the pilot takes its own names.
  const pilot = await checkout('install-pilot', 'cryptob1/graphyard-game-pilot');
  assert.deepEqual(await resolveInstallUnits(pilot, 'cryptob1/graphyard-game-pilot', legacyDirectory, legacyHome), betaUnits);
  const pilotCalls = legacy.calls.length;
  await installLoopSupervisor({ root: pilot, cliPath: launcher, repository: 'cryptob1/graphyard-game-pilot', intervalSeconds: 20 }, legacy.loopHost(legacyHome));
  await installExecutorSupervision(pilot, { count: 1, run: legacy.run, unitDirectory: legacyDirectory, template, node: process.execPath, loop: null });
  assert.deepEqual(legacy.calls.slice(pilotCalls).filter(args => args.some(arg => arg === legacyLoopUnit || arg.startsWith('graphyard-executor@'))), [], 'the pilot never names production\'s legacy units');
  // An install written before GY-1441 has no record at all: its readers keep the legacy names.
  const unrecorded = await checkout('install-unrecorded', 'owner/project');
  assert.equal(loopUnitOf(unrecorded), legacyLoopUnit);
});

// ---- Herdr scope ------------------------------------------------------------------------------

const clockStart = Date.parse('2030-01-01T00:00:00Z');
const worktree = '/repo/.graphyard/worktrees/GY-20-1';
/** One Herdr server two installs share: identical names and worktree paths in workspace wA (ours) and wB (another install's). */
function sharedHerdr() {
  const panes = new Map<string, { workspace: string; name?: string; cwd: string; agent: string | null }>([
    ['wA:p1', { workspace: 'wA', cwd: worktree, agent: null }],
    ['wB:p1', { workspace: 'wB', cwd: worktree, agent: null }],
    ['wA:p2', { workspace: 'wA', name: 'graphyard-claude-1', cwd: worktree, agent: 'claude' }],
    ['wB:p2', { workspace: 'wB', name: 'graphyard-claude-1', cwd: worktree, agent: 'claude' }],
  ]);
  const commands: string[][] = [];
  const run = async (_command: string, args: string[]) => {
    commands.push(args);
    const ok = (result: unknown) => JSON.stringify({ result });
    const entries = () => [...panes].map(([pane_id, pane]) => ({ pane_id, tab_id: pane_id.replace(':p', ':t'), workspace_id: pane.workspace, name: pane.name, cwd: pane.cwd, agent: pane.agent, agent_status: pane.agent ? 'idle' : 'unknown' }));
    if (args[0] === 'agent' && args[1] === 'list') return ok({ agents: entries() });
    if (args[0] === 'pane' && args[1] === 'list') return ok({ panes: entries() });
    if (args[0] === 'pane' && args[1] === 'close') { panes.delete(args[2]); return ok({}); }
    if (args[0] === 'tab' && args[1] === 'close') { panes.delete(args[2].replace(':t', ':p')); return ok({}); }
    if (args[0] === 'tab' && args[1] === 'list') return ok({ tabs: entries().map(entry => ({ tab_id: entry.tab_id })) });
    throw new Error(`the simulated Herdr has no ${args.slice(0, 2).join(' ')}`);
  };
  return { panes, commands, run };
}
const sweepConfig = (workspace: string): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], herdrWorkspace: workspace });
const unleased = { id: 'work-GY-20', key: 'GY-20', title: 'A pane', description: '', type: 'bug', priority: 0, dependencies: [], criteria: [], policy: { checks: ['test'], review: true }, plannedFiles: [],
  stage: 'build', revision: 1, policyRevision: 1, createdAt: new Date(clockStart).toISOString(), updatedAt: new Date(clockStart).toISOString(), stageEnteredAt: new Date(clockStart).toISOString(),
  ready: true, epoch: 1, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [], sessions: [] } as unknown as Work;

test('unit:herdr-scope-per-install — the install\'s workspace scopes every inventory and close, and the pane sweep leaves another install\'s matching panes untouched', async () => {
  // Loading the master configuration scopes this process to its install's workspace.
  const root = await temporaryDirectory('herdr-scope'), credentials = await temporaryDirectory('herdr-scope-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const status = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'wA' }, status as typeof fetch);
  scope.scopeHerdr(null);
  await loadMasterConfig(root);
  assert.equal(scope.herdrScope(), 'wA');

  // The inventories every sweep reads list only the install's own panes, though names and paths match.
  const herdr = sharedHerdr();
  assert.deepEqual((await listHerdrAgents(herdr.run)).map(agent => agent.pane_id), ['wA:p1', 'wA:p2']);
  assert.deepEqual((await listHerdrPanes(herdr.run)).map(pane => pane.pane_id), ['wA:p1', 'wA:p2']);
  assert.deepEqual((await observeHerdrAgents(herdr.run)).agents.map(agent => agent.pane_id), ['wA:p1', 'wA:p2']);
  assert.deepEqual((await listHerdrAgents(herdr.run, 'wB')).map(agent => agent.pane_id), ['wB:p1', 'wB:p2'], 'the other install sees only its own');
  assert.equal((await listHerdrAgents(herdr.run, null)).length, 4, 'an install with no workspace is unscoped');

  // A close or tab cleanup of another install's pane is refused before Herdr is asked.
  await assert.rejects(closeHerdrPane('wB:p2', herdr.run), /belongs to workspace wB, not this installation's workspace wA/);
  await assert.rejects(stopCreatedHerdrTab(undefined, 'wB:t1', herdr.run), /belongs to workspace wB/);
  assert.ok(!herdr.commands.some(args => args[1] === 'close'), 'nothing was closed');

  // The loop's pane sweep (GY-842, GY-980) over that inventory: the agentless shell in an unleased
  // worktree is closed in the install's own workspace, and the identical one in wB never is.
  const config = sweepConfig('wA');
  const state = emptyDaemonState(config);
  const effects = (at: number) => ({
    agents: () => listHerdrAgents(herdr.run), credentials: async () => ({}),
    snapshot: async () => ({ work: [{ ...unleased }], now: new Date(at).toISOString() }),
    closeSession: (pane: string) => closeHerdrPane(pane, herdr.run),
    herdr: () => observeHerdrAgents(herdr.run),
    panes: async () => ({ panes: await listHerdrPanes(herdr.run), available: true }),
    persist: async () => {}, recordSession: async () => {}, dispatch: async () => {}, requestProof: () => {},
    merge: async () => ({ result: 'merged', merged: true }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(at).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
  }) as unknown as DaemonEffects;
  await runCycle(config, state, effects(clockStart), () => clockStart);
  const later = clockStart + launchAppearanceMs + 60_000;
  await runCycle(config, state, effects(later), () => later);
  assert.ok(!herdr.panes.has('wA:p1'), 'the install\'s own leftover shell is closed');
  assert.ok(herdr.panes.has('wB:p1') && herdr.panes.has('wB:p2'), 'another install\'s matching panes are untouched');
  assert.ok(!herdr.commands.some(args => args.some(arg => arg.startsWith('wB:'))), 'no command ever named a pane in wB');

  // A live reload the loop refuses keeps its scope: an edit that moves the workspace together with a
  // setting the loop is bound to leaves every sweep in wA, and only an accepted reload moves it.
  const live = liveMasterConfig(root, await loadMasterConfig(root));
  const stored = JSON.parse(await readFile(join(root, '.graphyard/master.json'), 'utf8'));
  await writeFile(join(root, '.graphyard/master.json'), JSON.stringify({ ...stored, herdrWorkspace: 'wB', baseBranch: 'release' }));
  const refused = await live.reload();
  assert.match(refused.refused ?? '', /baseBranch/);
  assert.equal(scope.herdrScope(), 'wA', 'a refused reload never moves the Herdr scope');
  assert.deepEqual((await listHerdrPanes(herdr.run)).map(pane => pane.pane_id), ['wA:p2']);
  await writeFile(join(root, '.graphyard/master.json'), JSON.stringify({ ...stored, herdrWorkspace: 'wB' }));
  assert.equal((await live.reload()).refused, null);
  assert.equal(scope.herdrScope(), 'wB', 'an accepted reload adopts the new workspace');
  await writeFile(join(root, '.graphyard/master.json'), '{');
  assert.match((await live.reload()).refused ?? '', /could not be reloaded/);
  assert.equal(scope.herdrScope(), 'wB');
  scope.scopeHerdr(null);
});

// ---- The master harness ------------------------------------------------------------------------

test('unit:harness-own-units-only — the generated master harness allows restarting its own install\'s loop unit and denies every other install\'s Graphyard units', async () => {
  const home = await temporaryDirectory('harness-units-home');
  const unitDirectory = join(home, '.config/systemd/user');
  const host = userManager();
  const pilot = await checkout('harness-pilot', 'cryptob1/graphyard-game-pilot');
  const production = await checkout('harness-production', 'cryptob1/graphyard');
  // Production is an aliased legacy install; the pilot and a third install have per-install names.
  await mkdir(unitDirectory, { recursive: true });
  await writeFile(join(unitDirectory, legacyLoopUnit), loopUnitText({ root: production, cliPath: launcher, repository: 'cryptob1/graphyard', intervalSeconds: 20 }));
  await installLoopSupervisor({ root: production, cliPath: launcher, repository: 'cryptob1/graphyard', intervalSeconds: 20 }, host.loopHost(home));
  await installLoopSupervisor({ root: pilot, cliPath: launcher, repository: 'cryptob1/graphyard-game-pilot', intervalSeconds: 20 }, host.loopHost(home));
  const third = await checkout('harness-third', 'cryptob1/graphyard-game');
  await installLoopSupervisor({ root: third, cliPath: launcher, repository: 'cryptob1/graphyard-game', intervalSeconds: 20 }, host.loopHost(home));
  await installExecutorSupervision(third, { count: 1, run: host.run, unitDirectory, template, node: process.execPath, loop: null });

  const config = (repository: string) => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(home, 'credentials/master/coordinator.token'), cliPath: launcher,
    repository, baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master', autoMerge: true, mergeMethod: 'merge', workers: [] });
  const decide = (plan: ReturnType<typeof masterHarness>, command: string) => harnessDecision(plan, command).decision;

  // The pilot's master: its own loop, and nothing else.
  const pilotPlan = masterHarness(pilot, config('cryptob1/graphyard-game-pilot'), 'claude', { unitDirectory });
  for (const verb of ['restart', 'start', 'stop', 'status', 'enable --now']) assert.equal(decide(pilotPlan, `systemctl --user ${verb} graphyard-master-cryptob1-graphyard-game-pilot.service`), 'allow', verb);
  for (const command of [
    'systemctl --user restart graphyard-master.service', 'systemctl --user restart graphyard-master', 'systemctl --user stop graphyard-master.service',
    'systemctl --user restart graphyard-executor@1.service', 'systemctl --user disable --now graphyard-executor@2.service',
    'systemctl --user restart graphyard-master-cryptob1-graphyard-game.service', 'systemctl --user restart graphyard-executor-cryptob1-graphyard-game@1.service',
  ]) assert.equal(decide(pilotPlan, command), 'deny', command);

  // Production's master (the legacy alias): its own legacy unit, never the per-install units beside it.
  const productionPlan = masterHarness(production, config('cryptob1/graphyard'), 'claude', { unitDirectory });
  assert.equal(decide(productionPlan, 'systemctl --user restart graphyard-master.service'), 'allow');
  for (const command of ['systemctl --user restart graphyard-master-cryptob1-graphyard-game-pilot.service', 'systemctl --user stop graphyard-executor-cryptob1-graphyard-game@1.service'])
    assert.equal(decide(productionPlan, command), 'deny', command);

  // A name that extends another install's (graphyard-game vs graphyard-game-pilot) never denies the longer one's own unit.
  const thirdPlan = masterHarness(third, config('cryptob1/graphyard-game'), 'claude', { unitDirectory });
  assert.equal(decide(thirdPlan, 'systemctl --user restart graphyard-master-cryptob1-graphyard-game.service'), 'allow');
  assert.equal(decide(thirdPlan, 'systemctl --user restart graphyard-master-cryptob1-graphyard-game-pilot.service'), 'deny');
  assert.equal(decide(pilotPlan, 'systemctl --user restart graphyard-master-cryptob1-graphyard-game-pilot.service'), 'allow');
});

test('unit:per-install-units — re-applying the self-contained host installer to a host installed before per-install names enables and reports the legacy unit master init recorded, never a per-install unit that was not written', async () => {
  const { applyInstall, buildPlan, prepareInstall } = await import('../src/install/index.js');
  const { harness } = await import('./install-harness.js');
  const { legacyInstallUnits } = await units();
  const inputs = { repository: 'owner/project', provider: 'host' as const, selfContained: true, sshHost: '203.0.113.20', sshUser: 'root', domain: 'graphyard.example.test' };
  const legacyHost = await harness({ provider: 'host', serverUrl: 'https://graphyard.example.test' });
  try {
    // The host's loop already runs as the legacy unit for this checkout (an install from before GY-1441).
    legacyHost.hostFiles.set(`/home/graphyard/.config/systemd/user/${legacyLoopUnit}`, { content: 'WorkingDirectory=/home/graphyard/code/owner-project\n', mode: 0o644 });
    const session = await prepareInstall(legacyHost.root, inputs, legacyHost.deps);
    const summary = await applyInstall(session, await buildPlan(session));
    const lines = [...legacyHost.remotes.values()][0].commands.map(command => [command.program, ...command.args].join(' '));
    assert.ok(lines.some(line => line.includes(`systemctl --user enable --now ${legacyLoopUnit}`)), 'the recorded alias is the unit enabled');
    assert.ok(!lines.some(line => line.includes('graphyard-master-owner-project.service')), 'a per-install unit that was never written is never named');
    const reported = summary.host!.units.map(unit => unit.name);
    assert.ok(reported.includes(legacyLoopUnit) && reported.includes('graphyard-executor@1.service'), reported.join(', '));
    assert.match(summary.profiles!.master.detail, new RegExp(`runs as ${legacyLoopUnit.replace('.', '\\.')}`));
    assert.deepEqual(JSON.parse(legacyHost.hostFiles.get(`/home/graphyard/code/owner-project/.graphyard/units.json`)!.content), legacyInstallUnits);
  } finally { await legacyHost.cleanup(); }

  const freshHost = await harness({ provider: 'host', serverUrl: 'https://graphyard.example.test' });
  try {
    const session = await prepareInstall(freshHost.root, inputs, freshHost.deps);
    const summary = await applyInstall(session, await buildPlan(session));
    assert.ok(summary.host!.units.some(unit => unit.name === 'graphyard-master-owner-project.service'), 'a fresh host runs its per-install loop unit');
    assert.ok(!summary.host!.units.some(unit => unit.name === legacyLoopUnit));
  } finally { await freshHost.cleanup(); }
});

test('unit:per-install-units — repositories whose names differ only in punctuation get distinct units, and a record that exists but cannot be read fails closed instead of claiming the legacy units', async () => {
  const { installSlug, perInstallUnits, readInstallUnits, resolveInstallUnits, installUnitsFile } = await units();
  assert.equal(installSlug('cryptob1/graphyard'), 'cryptob1-graphyard', 'a plain OWNER/NAME keeps its readable slug');
  const masters = ['owner/foo.bar', 'owner/foo_bar', 'owner/foo-bar', 'owner/Foo..bar'].map(repository => perInstallUnits(repository).master);
  assert.equal(new Set(masters).size, masters.length, masters.join(', '));
  const long = perInstallUnits(`owner/${'x'.repeat(120)}`).master, longer = perInstallUnits(`owner/${'x'.repeat(121)}`).master;
  assert.notEqual(long, longer, 'truncation never merges two repositories');
  assert.ok(long.length < 120);

  const root = await checkout('corrupt-record', 'owner/project');
  const unitDirectory = await temporaryDirectory('corrupt-units');
  await writeFile(join(root, installUnitsFile), '{"version":2}');
  assert.throws(() => readInstallUnits(root), /does not record this install's units/);
  assert.throws(() => loopUnitOf(root), /does not record this install's units/);
  await assert.rejects(resolveInstallUnits(root, 'owner/project', unitDirectory), /does not record this install's units/);
  assert.equal(await readFile(join(root, installUnitsFile), 'utf8'), '{"version":2}', 'the unreadable record is left for the operator, not overwritten');
});

test('unit:per-install-units — install --migrate stops the units the managed checkout recorded, even when the installer\'s CLI lies outside that checkout, and never another install\'s legacy units', async () => {
  const { applyInstall, buildPlan, prepareInstall } = await import('../src/install/index.js');
  const { MIGRATE_SOURCE_VARIABLE } = await import('../src/install/host.js');
  const { harness } = await import('./install-harness.js');
  const { installUnitsFile, perInstallUnits } = await units();
  const fixture = await harness({ provider: 'host', serverUrl: 'https://graphyard.example.test',
    extraResponses: [
      { match: 'is-active graphyard-master-owner-project.service', result: { stdout: 'inactive\n', stderr: '', code: 3 } },
      { match: 'db backup', result: { stdout: '', stderr: 'db backup: stopped here, after the freeze', code: 1 } },
    ] });
  try {
    // master init recorded per-install names in the managed checkout; the CLI is an installed launcher elsewhere.
    const recorded = perInstallUnits('owner/project');
    await mkdir(join(fixture.root, '.graphyard'), { recursive: true });
    await writeFile(join(fixture.root, installUnitsFile), JSON.stringify(recorded));
    const outside = await temporaryDirectory('installed-launcher');
    const deps = { ...fixture.deps, cliPath: join(outside, 'bin/graphyard.mjs'), environment: { [MIGRATE_SOURCE_VARIABLE]: 'postgres://graphyard:old-password-0123456789@old.example.test:5432/graphyard' } };
    const session = await prepareInstall(fixture.root, { repository: 'owner/project', provider: 'host' as const, selfContained: true, sshHost: '203.0.113.20', sshUser: 'root', domain: 'graphyard.example.test', migrate: true }, deps);
    await assert.rejects(applyInstall(session, await buildPlan(session)), /stopped here, after the freeze/);
    const local = fixture.commandLines();
    assert.ok(local.includes(`systemctl --user disable --now ${recorded.master}`), local.join('\n'));
    assert.ok(local.includes('systemctl --user stop graphyard-executor-owner-project@*.service'), local.join('\n'));
    assert.ok(!local.some(line => line.includes(legacyLoopUnit) || line.includes('graphyard-executor@')), 'another install\'s legacy units are never stopped');
  } finally { await fixture.cleanup(); }
});
