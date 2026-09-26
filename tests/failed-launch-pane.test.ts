import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assessContainment, closeFailedLaunch, defaultLaunchStartSeconds, dispatchWork, launchStartMs, masterConfigSchema, setupMaster, startAgentSession, SessionStartError, withLaunchClose,
  type ContainmentAssessment, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { stopLaunchSupervisor } from '../src/master/containment.js';
import { loadMasterConfig } from '../src/master/config.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { probeSupervisorAbsence } from '../src/containment-probe.js';
import { annotatePaneShell, closablePane, containmentSettlementRefusals, isHerdrServer, type ContainmentVerification } from '../src/quarantine.js';
import type { Work } from '../src/model.js';

// GY-413: dispatching GY-393 failed with 'the claude runtime never started within 30 s … (command
// still echoing)'. The pane it created stayed open, its bash shell idled in the worktree, and
// containment — which matched any process there — refused to settle forever.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const workerToken = 'worker-token-'.padEnd(40, 'x');

function work(key: string, overrides: Partial<Work> = {}): Work {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  return {
    id: `id-${key}`, key, title: key, description: '', type: 'bug', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:x'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'ready', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at,
    ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [], ...overrides,
  } as Work;
}
const launchProfile = (credentialFile: string): WorkerProfile => ({ name: 'one', principal: 'one-principal', agentName: 'agent-one', mode: 'launch', kind: 'codex', credentialFile, agentArgs: [], approvals: 'auto', environment: {} });

/**
 * A Herdr whose runtime never starts: the tab is created, the command line is typed, and from then
 * on the pane shows only the command still echoing and Herdr names no agent under it — or, with
 * `startsAt`, the runtime comes up idle once the virtual clock reaches it. Every call lands on the
 * shared timeline, so a test can order the pane close against the claim's release.
 */
function fakeHerdr(timeline: string[], clock: { now: number }, options: { startsAt?: number } = {}) {
  const calls: string[][] = [], closed: string[] = [];
  let typed = '';
  const run = (_command: string, args: string[]) => {
    calls.push(args);
    const json = (result: unknown) => JSON.stringify({ result });
    const started = options.startsAt !== undefined && clock.now >= options.startsAt;
    if (args[0] === 'tab' && args[1] === 'create') { timeline.push('create pane-1'); return json({ type: 'tab_created', root_pane: { pane_id: 'pane-1', tab_id: 'tab-1' }, tab: { tab_id: 'tab-1' } }); }
    if (args[0] === 'pane' && args[1] === 'run') { typed = args[3]; timeline.push(`run ${args[2]}`); return ''; }
    if (args[0] === 'pane' && args[1] === 'read') return started ? 'OpenAI Codex\n' : `$ ${typed}\n`;
    if (args[0] === 'agent' && args[1] === 'get') return started ? json({ agent: { agent: 'codex', agent_status: 'idle', pane_id: args[2] } }) : json({ agent: null });
    if (args[0] === 'agent' && args[1] === 'rename') return json({ agent: { agent: 'codex', agent_status: 'idle', name: args[3] } });
    if (args[0] === 'agent' && args[1] === 'list') return json({ agents: [] });
    if (args[0] === 'pane' && args[1] === 'close') { closed.push(args[2]); timeline.push(`close ${args[2]}`); return json({}); }
    if (args[0] === 'pane' && args[1] === 'list') return json({ panes: [] });
    return json({});
  };
  return { run, calls, closed };
}
function fakeClaims(root: string, timeline: string[]) {
  const released: string[] = [];
  const prepare = async (_root: string, key: string) => ({ epoch: 1, path: join(root, `assigned-${key}`), base: 'c'.repeat(40) });
  const release = async (_root: string, key: string, epoch: number) => { released.push(`${key}@${epoch}`); timeline.push(`release ${key}@${epoch}`); };
  return { released, prepare, release };
}
/** A virtual start clock: each poll pause advances it, so a sixty-second bound takes no real time. */
const virtualStart = (clock: { now: number }, lines: string[] = []) => ({ pollMs: 1_000, clock: () => clock.now, wait: (ms: number) => { clock.now += ms; }, log: (line: string) => { lines.push(line); } });

async function installation(run: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-failed-launch-')); const credentials = await mkdtemp(join(tmpdir(), 'graphyard-failed-launch-credentials-'));
  execFileSync('git', ['init', '-q', root]); execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const credential = join(credentials, 'worker.token'); await writeFile(credential, workerToken, { mode: 0o600 });
  await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials }, (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
  if (Object.keys(run).length) {
    const file = join(root, '.graphyard', 'master.json');
    const config = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...config, run: { ...config.run, ...run } }), { mode: 0o600 });
  }
  return { root, credential, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); } };
}
const failedDispatch = (fixture: Awaited<ReturnType<typeof installation>>, herdr: ReturnType<typeof fakeHerdr>, claims: ReturnType<typeof fakeClaims>, start: object, options: object = {}) =>
  dispatchWork(fixture.root, work('GY-1'), launchProfile(fixture.credential), [], herdr.run, [work('GY-1')], claims.prepare, claims.release, undefined, new Date().toISOString(), { start, ...options }).then(() => null, failure => failure as Error);

test('unit:failed-launch-closes-pane — a worker whose runtime never starts has the pane it created closed through the loop\'s close path, recorded in the failure, before its claim is released', async () => {
  const fixture = await installation();
  try {
    const timeline: string[] = [], clock = { now: 0 };
    const herdr = fakeHerdr(timeline, clock), claims = fakeClaims(fixture.root, timeline);
    const error = await failedDispatch(fixture, herdr, claims, virtualStart(clock), { supervisor: () => false });
    assert.ok(error instanceof SessionStartError, `the launch fails as a start that never happened: ${error?.message}`);
    assert.match(error.message, /the codex runtime never started within 60 s .*command still echoing/);
    assert.match(error.message, /command still echoing\); the pane last showed: .*; its Herdr pane pane-1 was closed before epoch 1 was released$/, 'the failure records the close');
    assert.deepEqual(herdr.closed, ['pane-1'], 'the created pane is closed');
    assert.ok(herdr.calls.some(args => args[0] === 'pane' && args[1] === 'list'), 'the close is confirmed against Herdr\'s inventory, as the loop confirms its own');
    assert.deepEqual(claims.released, ['GY-1@1'], 'the claim is released');
    assert.deepEqual(timeline, ['create pane-1', 'run pane-1', 'close pane-1', 'release GY-1@1'], 'the pane is closed before the claim is released');
  } finally { await fixture.cleanup(); }
});

test('unit:failed-launch-closes-pane — a runtime that never started under a running supervisor has the supervisor stopped first, then its pane closed, then the claim released', async () => {
  const fixture = await installation();
  try {
    const timeline: string[] = [], clock = { now: 0 };
    const herdr = fakeHerdr(timeline, clock), claims = fakeClaims(fixture.root, timeline);
    const stopped: string[] = [];
    const error = await failedDispatch(fixture, herdr, claims, virtualStart(clock), {
      supervisor: () => true, stopSupervisor: ({ key, epoch }: { key: string; epoch: number }) => { stopped.push(`${key}@${epoch}`); timeline.push('stop supervisor'); return true; } });
    assert.deepEqual(stopped, ['GY-1@1']);
    assert.match(error!.message, /its watch supervisor for epoch 1 was stopped and its Herdr pane pane-1 was closed before epoch 1 was released$/);
    assert.deepEqual(timeline, ['create pane-1', 'run pane-1', 'stop supervisor', 'close pane-1', 'release GY-1@1']);

    // A supervisor that will not stop keeps its pane (GY-273): it stops on the released lease itself.
    const kept: string[] = [], keptClock = { now: 0 };
    const stubborn = fakeHerdr(kept, keptClock), keptClaims = fakeClaims(fixture.root, kept);
    const refused = await failedDispatch(fixture, stubborn, keptClaims, virtualStart(keptClock), { supervisor: () => true, stopSupervisor: () => false });
    assert.deepEqual(stubborn.closed, []);
    assert.match(refused!.message, /pane pane-1 was left to its running supervisor/);
    assert.deepEqual(keptClaims.released, ['GY-1@1']);
  } finally { await fixture.cleanup(); }
});

test('unit:failed-launch-closes-pane — every launcher closes through closeFailedLaunch, which names the pane or tab it closed, and the supervisor stop signals only the assignment\'s own watch process', async () => {
  const calls: string[][] = [];
  const run = (_command: string, args: string[]) => { calls.push(args); return JSON.stringify({ result: args[1] === 'list' ? { panes: [], tabs: [] } : {} }); };
  assert.equal(await closeFailedLaunch('w1V:p7', 'w1V:t7', run), 'its Herdr pane w1V:p7 was closed');
  assert.deepEqual(calls.slice(0, 2), [['pane', 'close', 'w1V:p7'], ['pane', 'list']]);
  assert.equal(await closeFailedLaunch(undefined, 'w1V:t8', run), 'its Herdr tab w1V:t8 was closed');
  const failure = new SessionStartError('never started', 'w1V:p7', '', 60_000, 'the claude runtime never started');
  assert.equal(withLaunchClose(failure, 'its Herdr pane w1V:p7 was closed'), failure, 'the error keeps its class');
  assert.equal(failure.message, 'the claude runtime never started; its Herdr pane w1V:p7 was closed');
  for (const file of ['src/reviewer.ts', 'src/producer.ts', 'src/master/autonomy.ts', 'src/master/dispatch.ts'])
    assert.match(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'), /closeFailedLaunch\(/, `${file} closes a failed launch's pane and records it`);

  // The process table: 10 is GY-1's supervisor (and its wrapper 9), 11 another epoch's, 12 unrelated.
  const table: Record<number, string[]> = { 9: ['node', 'bin/graphyard.mjs', 'watch', 'GY-1', '1', '--', 'claude'], 10: ['node', 'src/cli.ts', 'watch', 'GY-1', '1', '--', 'claude'], 11: ['node', 'cli', 'watch', 'GY-1', '2', '--', 'claude'], 12: ['vim', 'watch'] };
  const signalled: number[] = [];
  const deps = { list: () => Object.keys(table), readCommand: (pid: number) => { if (!table[pid]) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return table[pid].join('\0'); },
    kill: (pid: number) => { signalled.push(pid); delete table[pid]; }, pollMs: 1 };
  assert.equal(await stopLaunchSupervisor({ key: 'GY-1', epoch: 1 }, deps), true);
  assert.deepEqual(signalled, [9, 10]);
  assert.equal(await stopLaunchSupervisor({ key: 'GY-1', epoch: 2 }, { ...deps, kill: pid => { signalled.push(pid); }, boundMs: 5 }), false, 'a supervisor still running at the bound is reported, never assumed gone');
});

// --- AC-2: the pane's idle shell is not a worker ---------------------------------------------

const observedAt = '2030-01-01T12:00:00.000Z';
const at = (offsetMs: number) => new Date(Date.parse(observedAt) + offsetMs).toISOString();
const workspace = { host: 'coordinator-host', path: '/srv/worktrees/GY-393-1', branch: 'graphyard/gy-393-1', epoch: 1, owner: 'worker-a' };
const pane = 'w1V:p4BK', shellPid = 1095269, herdrServer = 800;
/** A failed launch's quarantine, lapsed ten minutes ago, with no recorded scope and no recorded session pane. */
function stranded(overrides: Partial<Work> = {}) {
  const launchAt = at(-600_000);
  return work('GY-393', { stage: 'build', epoch: 1, workspaces: [workspace], sessions: [],
    containmentQuarantine: { owner: 'worker-a', epoch: 1, at: launchAt, settlementHash: 'a'.repeat(64), launchAcknowledgedAt: launchAt, launchExpiresAt: launchAt, leaseExpiresAt: launchAt }, ...overrides } as Partial<Work>);
}
type Row = { argv: string[]; cwd: string; ppid: number; stdin?: string };
/** The host as the probe reads it: Herdr's server, the pane's bash in the worktree, and whatever `extra` adds. */
function host(extra: Record<number, Row> = {}) {
  const table: Record<number, Row> = { [herdrServer]: { argv: ['/home/vish/.local/bin/herdr', 'server'], cwd: '/home/vish', ppid: 1 }, [shellPid]: { argv: ['/usr/bin/bash'], cwd: workspace.path, ppid: herdrServer, stdin: '/dev/pts/18' }, ...extra };
  const present = (pid: number) => { const entry = table[pid]; if (!entry) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return entry; };
  const deps = { listProcesses: () => Object.keys(table), readParent: (pid: number) => present(pid).ppid, readCommand: (pid: number) => present(pid).argv.join('\0'), readStdin: (pid: number) => present(pid).stdin ?? '/dev/null' };
  const probe = async () => {
    const probed = await probeSupervisorAbsence({ key: 'GY-393', epoch: 1, workspacePath: workspace.path, scope: null }, {
      platform: 'linux', uid: 1000, resolvePath: value => value, listProcesses: deps.listProcesses, readCommand: deps.readCommand, processOwner: () => 1000, readCwd: pid => present(pid).cwd, readParent: deps.readParent, readCgroup: () => '',
      run: (_command, args) => args.includes('show-environment') ? 'LANG=C\n' : '' });
    const asked: string[] = [];
    const annotated = await annotatePaneShell(probed, stranded(), async paneId => { asked.push(paneId); return { process_info: { pane_id: paneId, shell_pid: shellPid, foreground_process_group_id: shellPid } }; }, deps,
      async () => ({ panes: [{ pane_id: 'w3:p2', cwd: '/home/vish/code/dr' }, { pane_id: pane, cwd: workspace.path }] }));
    return { verification: { ...annotated, host: 'coordinator-host', observedAt, clockOffset: { min: 0, max: 1 } } as ContainmentVerification, asked };
  };
  return { table, probe };
}
const refusals = (item: Work, verification: ContainmentVerification) => containmentSettlementRefusals(item, verification, { now: Date.parse(observedAt) });

async function loop(item: Work, containment: DaemonEffects['containment']) {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-failed-launch-shell-'));
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, coordinatorToken, { mode: 0o600 });
  const profile = { name: 'claude-1', principal: 'worker-a', agentName: 'graphyard-claude-1', mode: 'launch', kind: 'claude', credentialFile: join(directory, 'worker.token'), agentArgs: [], environment: {} } as unknown as WorkerProfile;
  const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: '/srv/graphyard/bin/graphyard.mjs',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'coordinator-host', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [profile] });
  const state = emptyDaemonState(config), closed: string[] = [], settled: ContainmentAssessment[] = [];
  const effects: DaemonEffects = {
    agents: () => [], credentials: async profiles => Object.fromEntries(profiles.map(entry => [entry.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: [item], now: observedAt }),
    closeSession: paneId => { closed.push(paneId); }, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: observedAt, reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    settleContainment: async (_item, assessment) => { settled.push(assessment); }, containment,
  };
  try { await runCycle(config, state, effects, () => Date.parse(observedAt)); }
  finally { await rm(directory, { recursive: true, force: true }); }
  return { closed, settled, state };
}
const assessed = (verification: () => Promise<ContainmentVerification>): DaemonEffects['containment'] => async (items, observed) => {
  const current = await verification();
  return assessContainment(items, { hostId: 'coordinator-host', observedAt: observed.now, clockOffset: { min: 0, max: 1 }, localNow: new Date(observed.now), probe: () => current } as any);
};
const still = new RegExp(`Process ${shellPid} of the contained worker is still present on coordinator-host \\(matched by assigned workspace\\)`);

test('unit:idle-pane-shell-not-a-worker — the interactive shell of a Herdr pane, a child of `herdr server` with no runtime under it, is no worker: the loop closes its pane and then settles', async () => {
  const idle = host();
  const { verification, asked } = await idle.probe();
  assert.equal(isHerdrServer('/home/vish/.local/bin/herdr server'), true);
  for (const command of ['herdr', 'herdr agent list', 'node herdr server', 'tmux', undefined]) assert.equal(isHerdrServer(command), false, String(command));
  assert.deepEqual(asked, [pane], 'Herdr is asked only about the pane whose working directory is the shell\'s');
  assert.deepEqual(verification.paneShell, { pane, pid: shellPid, foregroundGroup: shellPid }, 'the pane is found in Herdr\'s own inventory, though the ledger recorded none');
  assert.equal(verification.held.find(entry => entry.pid === shellPid)?.parent, '/home/vish/.local/bin/herdr server');
  assert.deepEqual(refusals(stranded(), verification), [], 'the idle pane shell holds no fence');
  assert.equal(closablePane(stranded(), verification), pane);

  // One cycle: the pane is closed through the loop's close path, re-probed with the shell gone, and settled.
  let probes = 0;
  const { closed, settled, state } = await loop(stranded(), assessed(async () => { probes += 1; if (probes > 1) delete idle.table[shellPid]; return (await idle.probe()).verification; }));
  assert.deepEqual(closed, [pane], 'the pane is closed');
  assert.match(state.actions[`close:ended-scope:id-GY-393:1:${pane}`]?.detail ?? '', /Closed pane w1V:p4BK of GY-393 epoch 1: its launch recorded no supervisor scope and its pane shell runs nothing/);
  assert.equal(settled.length, 1, 'and then the quarantine is settled');
  assert.deepEqual(settled[0].refusals, []);
  assert.ok(probes >= 2, 'the settlement comes from a probe taken after the close');
  assert.equal(state.actions['settle:id-GY-393:1']?.state, 'done');
});

test('unit:idle-pane-shell-not-a-worker — a pane shell with a live runtime child, a running supervisor, or a parent that is not Herdr still blocks settlement', async () => {
  const withRuntime = host({ 1095300: { argv: ['/home/vish/.local/share/mise/installs/claude/latest/claude', '--dangerously-skip-permissions'], cwd: workspace.path, ppid: shellPid } });
  const busy = (await withRuntime.probe()).verification;
  assert.equal(busy.held.find(entry => entry.pid === shellPid)?.children, 1);
  assert.match(refusals(stranded(), busy).join('\n'), still, 'a shell with the runtime under it is the worker\'s');
  assert.match(refusals(stranded(), busy).join('\n'), /Process 1095300 of the contained worker is still present/, 'and the runtime itself holds the fence');
  assert.equal(closablePane(stranded(), busy), null);
  const blocked = await loop(stranded(), assessed(async () => (await withRuntime.probe()).verification));
  assert.deepEqual(blocked.closed, [], 'its pane is never closed');
  assert.deepEqual(blocked.settled, [], 'nor is the quarantine settled');
  assert.match(blocked.state.actions['escalation:containment:id-GY-393:1']?.detail ?? '', still);

  const supervised = host({ 900: { argv: ['node', '/srv/graphyard/bin/graphyard.mjs', 'watch', 'GY-393', '1', '--', 'claude'], cwd: '/srv', ppid: 1 } });
  assert.match(refusals(stranded(), (await supervised.probe()).verification).join('\n'), still, 'a live supervisor of the assignment keeps the shell fenced');

  const tmux = host({ [herdrServer]: { argv: ['/usr/bin/tmux'], cwd: '/home/vish', ppid: 1 } });
  const foreign = (await tmux.probe()).verification;
  assert.equal('paneShell' in foreign, false, 'a shell that is not a Herdr pane\'s is not looked up');
  assert.match(refusals(stranded(), foreign).join('\n'), still, 'and still holds the fence');

  // A recorded scope that is still live keeps every shell fenced, as before GY-413.
  const scoped = stranded({ containmentQuarantine: { ...stranded().containmentQuarantine!, scope: { unit: 'graphyard-watch-900-abc.scope', pid: 900 } } } as Partial<Work>);
  const idle = (await host().probe()).verification;
  assert.match(refusals(scoped, { ...idle, recordedScope: { unit: 'graphyard-watch-900-abc.scope', pid: 900, activeState: 'active' } }).join('\n'), still);
  assert.deepEqual(refusals(scoped, { ...idle, recordedScope: { unit: 'graphyard-watch-900-abc.scope', pid: 900, activeState: 'not-found' } }), [], 'an ended scope beside the idle pane shell settles');
});

// --- AC-3: the start bound is configurable ------------------------------------------------

test('unit:launch-start-timeout-configurable — run.launchStartSeconds (default 60) bounds the runtime start, and every start logs how long it took', async () => {
  assert.equal(defaultLaunchStartSeconds, 60);
  const base = { version: 1, url: 'https://graphyard.example', credentialFile: '/srv/c.token', cliPath: '/srv/graphyard/bin/graphyard.mjs', repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'h', masterAgentName: 'graphyard-master-project', workers: [] };
  assert.equal(launchStartMs(masterConfigSchema.parse(base)), 60_000);
  assert.equal(launchStartMs(masterConfigSchema.parse({ ...base, run: { launchStartSeconds: 150 } })), 150_000);
  for (const launchStartSeconds of [5, 601, 1.5]) assert.throws(() => masterConfigSchema.parse({ ...base, run: { launchStartSeconds } }), `launchStartSeconds ${launchStartSeconds} is refused`);

  // The configured bound is the one a worker launch honours: never started at 150 s, not 60.
  const fixture = await installation({ launchStartSeconds: 150 });
  try {
    assert.equal((await loadMasterConfig(fixture.root)).run.launchStartSeconds, 150);
    const timeline: string[] = [], clock = { now: 0 }, lines: string[] = [];
    const herdr = fakeHerdr(timeline, clock), claims = fakeClaims(fixture.root, timeline);
    const error = await failedDispatch(fixture, herdr, claims, virtualStart(clock, lines), { supervisor: () => false });
    assert.ok(error instanceof SessionStartError);
    assert.match(error.message, /never started within 150 s in pane pane-1/);
    assert.ok(error.waitedMs >= 150_000 && error.waitedMs < 152_000, `the start was given the configured 150 s: ${error.waitedMs}`);
    assert.deepEqual(lines, ['graphyard: agent-one (codex) in pane pane-1: start failed after 150.0 s (never started; bound 150 s)']);
  } finally { await fixture.cleanup(); }

  // A slow start inside the bound is a start, logged with how long it took.
  const clock = { now: 0 }, lines: string[] = [];
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-slow-start-'));
  try {
    const slow = fakeHerdr([], clock, { startsAt: 45_000 });
    const started = await startAgentSession('graphyard-claude-9', 'codex', 'pane-1', [], 'Implement GY-9', slow.run, { directory, ...virtualStart(clock, lines), timeoutMs: 60_000 });
    assert.equal(started.started.state, 'started');
    assert.equal(started.started.waitedMs, 45_000);
    assert.deepEqual(lines, ['graphyard: graphyard-claude-9 (codex) in pane pane-1: runtime started after 45.0 s (bound 60 s)']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
