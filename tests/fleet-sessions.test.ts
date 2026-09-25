import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetRoleHealth, readFleetLaunches, reconcileFleetSessions, recordFleetLaunch, selectFleetSession, type FleetClient } from '../src/fleet.js';
import { approverSessionName, masterConfigSchema, type HerdrAgent, type MasterConfig, type MasterRun } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { chooseSession, emptyRegistry, liveSessions, launchGraceMs, type AgentRegistry, type FleetSession } from '../src/model/registry.js';
import type { Work } from '../src/model.js';

/*
 * GY-190: agent-registry sessions end when the session they record finishes, a role's concurrency
 * counts only sessions actually running, and a launch refused for capacity is retried once a seat frees.
 * No database: the registry is an in-memory fake that chooses with the control plane's own `chooseSession`.
 */
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs = 0) => new Date(clock + offsetMs).toISOString();
const hour = 3_600_000;

function registryWith(concurrency: number, sessions: FleetSession[] = []): AgentRegistry {
  return { ...emptyRegistry(), revision: 1,
    runtimes: [{ name: 'claude', launch: { kind: 'claude', args: [], environment: {}, homeVariable: null, modelFlag: null, loginFile: null, login: null } } as any],
    models: [{ name: 'claude-default', id: null, cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'strong', contextTokens: null } }],
    accounts: [{ name: 'claude-a', runtime: 'claude', model: 'claude-default', credential: { host: 'machine-a', home: null }, enabled: true, maxSessions: null,
      quota: { loggedIn: null, state: 'unknown', usage: [], resetsAt: null, reason: null, observedAt: null, observedBy: null, source: null } }],
    roles: [{ name: 'approver', accounts: ['claude-a'], concurrency }], sessions };
}
const session = (id: string, work: string, selectedAt = iso(-hour)): FleetSession => ({ id, role: 'approver', account: 'claude-a', runtime: 'claude', model: 'claude-default',
  host: 'machine-a', work, principal: 'approver-agent', selectedAt, selectedBy: 'master', reason: 'chosen', skipped: [], endedAt: null, endReason: null });

/** The control plane's three executor calls over one document, choosing with its own rules. */
function fakeRegistry(registry: AgentRegistry, now = () => clock) {
  const ended: { session: string; reason: string }[] = [];
  let next = 0;
  const client: FleetClient = {
    document: async () => structuredClone(registry),
    select: async request => {
      const choice = chooseSession(registry, request, now());
      if (!choice.account) return { selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.revision };
      const chosen: FleetSession = { ...session(`session-new-${++next}`, request.work ?? 'none', new Date(now()).toISOString()), principal: request.principal };
      registry.sessions.push(chosen);
      return { selected: true, reason: choice.reason, skipped: choice.skipped, session: chosen, account: choice.account, runtime: choice.runtime, model: choice.model, revision: registry.revision };
    },
    end: async (id, reason) => {
      const entry = registry.sessions.find(candidate => candidate.id === id)!;
      if (!entry.endedAt) { entry.endedAt = new Date(now()).toISOString(); entry.endReason = reason; ended.push({ session: id, reason }); }
    },
  };
  return { client, ended };
}

async function withConfig(body: (config: MasterConfig) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-fleet-sessions-'));
  try {
    const credentialFile = join(directory, 'coordinator.token');
    await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    await body(masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
      repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
      autoMerge: false, mergeMethod: 'merge', workers: [],
      operatorAgent: { id: 'graphyard-master-project-operator', credentialFile }, approver: { id: 'approver-agent', credentialFile },
      run: { intervalSeconds: 20 } as Partial<MasterRun> }) as MasterConfig);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** A candidate every gate passes, on a loop whose automatic merging is off: one routine merge decision. */
function mergeable(key = 'GY-101'): Work {
  const candidate = { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 101, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' };
  return {
    id: `work-${key}`, key, title: 'Approver sessions end', description: '', type: 'bug', priority: 0,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Ends', proofs: ['unit:registry-session-ends-with-session'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'merge', revision: 9, policyRevision: 1,
    createdAt: iso(-4 * hour), updatedAt: iso(), stageEnteredAt: iso(-hour), ready: true, epoch: 1,
    lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 101 }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: ['ready', 'build', 'review', 'test', 'acceptance', 'merge'].map(name => ({ name, passed: true, reasons: [] })),
    violations: [],
  } as unknown as Work;
}
const decisionId = '4cb51514-4cb5-4f21-9b0e-0f2a6c8d4e15';

function loopEffects(item: Work, herdr: () => HerdrAgent[], overrides: Partial<DaemonEffects>, decision = { state: 'requested' }): DaemonEffects {
  return {
    agents: () => herdr(), herdr: () => ({ agents: herdr(), available: true }),
    credentials: async () => ({}), snapshot: async () => ({ work: [item], now: iso() }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    merge: async () => ({ result: 'merged' }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    decide: async () => ({ id: decisionId }),
    decisions: async () => ({ decisions: [{ id: decisionId, action: 'merge', ...decision, input: { sha: item.candidate!.sha, baseSha: item.candidate!.baseSha, policyRevision: item.policyRevision }, approvedBy: null }] }),
    ...overrides,
  };
}

test('unit:registry-session-ends-with-session — the loop ends every registry session whose runtime session is gone, and an approver\'s once its decision is judged', async () => {
  await withConfig(async config => {
    // Seven finished approvers fill the role: two paired with Herdr sessions that are gone, one
    // paired and still running, and four launched before pairing, three of whose items have no
    // approver in Herdr at all and one of which does.
    const registry = registryWith(7, [session('s1', 'GY-1'), session('s2', 'GY-2'), session('s3', 'GY-3'), session('s4', 'GY-4'), session('s5', 'GY-5'), session('s6', 'GY-6'), session('s7', 'GY-7')]);
    const { client, ended } = fakeRegistry(registry);
    for (const [id, work] of [['s1', 'GY-1'], ['s2', 'GY-2'], ['s3', 'GY-3']]) await recordFleetLaunch(config, { session: id, role: 'approver', work, agentName: approverSessionName({ key: work }, `${id}decision`), at: iso(-hour) });
    const running: HerdrAgent[] = [{ name: approverSessionName({ key: 'GY-3' }, 's3decision'), pane_id: 'pane-3', agent_status: 'working' }, { name: approverSessionName({ key: 'GY-7' }, 'legacy07'), pane_id: 'pane-7', agent_status: 'working' }];
    // A session still inside its launch grace is not judged: its runtime may not be listed yet.
    registry.sessions.push(session('s8', 'GY-8', iso(-launchGraceMs / 2)));

    const first = await reconcileFleetSessions(config, running, [], { registry: client, now: () => clock });
    assert.deepEqual(first.map(entry => entry.session).sort(), ['s1', 's2', 's4', 's5', 's6']);
    assert.match(ended.find(entry => entry.session === 's1')!.reason, /runtime session graphyard-approver-gy-1-.* is gone from Herdr/);
    assert.match(ended.find(entry => entry.session === 's4')!.reason, /no approver session for GY-4 is running in Herdr/);
    assert.equal(liveSessions(registry).filter(entry => entry.role === 'approver').length, 3, 'the role\'s live count drops to the sessions still running');
    assert.deepEqual((await readFleetLaunches(config)).map(entry => entry.session), ['s3'], 'pairings of ended sessions are forgotten');

    // An approver idle at its prompt after judging is still listed; the loop names it finished.
    await reconcileFleetSessions(config, running, [{ agentName: running[0].name!, reason: 'its decision is applied' }], { registry: client, now: () => clock });
    assert.ok(registry.sessions.find(entry => entry.id === 's3')!.endedAt);
    assert.equal(registry.sessions.find(entry => entry.id === 's3')!.endReason, 'its decision is applied');
  });

  // Every cycle reconciles, whatever it has to decide: a paired session gone from Herdr is ended
  // by the loop itself, and the cycle records what it ended.
  await withConfig(async config => {
    const registry = registryWith(1, [session('s1', 'GY-1')]);
    const { client } = fakeRegistry(registry);
    await recordFleetLaunch(config, { session: 's1', role: 'approver', work: 'GY-1', agentName: 'graphyard-approver-gy-1-aaaaaaaa', at: iso(-hour) });
    const state = emptyDaemonState(config);
    const idle = loopEffects(mergeable(), () => [], { snapshot: async () => ({ work: [], now: iso() }),
      endFleetSessions: (agents, finished) => reconcileFleetSessions(config, agents, finished, { registry: client, now: () => clock }) });
    await runCycle(config, state, idle, () => clock);
    assert.equal(liveSessions(registry).length, 0, 'the cycle ended the session nothing runs');
    assert.ok(Object.values(state.actions).some(action => action.kind === 'reclaim' && /Ended 1 agent-registry session.*approver on GY-1.*gone from Herdr/.test(action.detail ?? '')));
    // An unreadable Herdr lists nothing, and is never read as every session having gone.
    const standing = registryWith(1, [session('s2', 'GY-2')]), fake = fakeRegistry(standing);
    await recordFleetLaunch(config, { session: 's2', role: 'approver', work: 'GY-2', agentName: 'graphyard-approver-gy-2-bbbbbbbb', at: iso(-hour) });
    await runCycle(config, state, { ...idle, herdr: () => ({ agents: [], available: false }),
      endFleetSessions: (agents, finished) => reconcileFleetSessions(config, agents, finished, { registry: fake.client, now: () => clock }) }, () => clock + 20_000);
    assert.equal(liveSessions(standing).length, 1);
  });

  // Through the loop: a decision the approver applied closes its session and ends its registry session.
  await withConfig(async config => {
    const item = mergeable(), name = approverSessionName(item, decisionId);
    const registry = registryWith(1, []);
    const { client } = fakeRegistry(registry);
    let herdr: HerdrAgent[] = [];
    const endFleetSessions: DaemonEffects['endFleetSessions'] = (agents, finished) => reconcileFleetSessions(config, agents, finished, { registry: client, now: () => clock });
    const approver: DaemonEffects['approver'] = async work => {
      const selected = (await selectFleetSession(config, 'approver', { name }, { registry: client, work: work.key, now: () => clock }))!;
      await selected.record(name);
      herdr = [{ name, pane_id: 'pane-1', agent_status: 'working' }];
      return { agentName: name, pane: 'pane-1' };
    };
    const state = emptyDaemonState(config);
    await runCycle(config, state, loopEffects(item, () => herdr, { approver, endFleetSessions }), () => clock);
    assert.equal(liveSessions(registry).length, 1, 'the approver holds the role\'s one seat while it judges');
    // It judged and now sits idle at its prompt: still listed in Herdr, its decision applied.
    herdr = [{ name, pane_id: 'pane-1', agent_status: 'idle' }];
    const closed: string[] = [];
    await runCycle(config, state, loopEffects(item, () => herdr, { approver, endFleetSessions, closeSession: pane => { closed.push(pane); } }, { state: 'applied' }), () => clock + 60_000);
    assert.deepEqual(closed, ['pane-1']);
    assert.equal(liveSessions(registry).length, 0, 'the judged approver\'s registry session ends with it');
    assert.match(registry.sessions[0].endReason!, /approver session .* finished: its decision is applied/);
  });
});

test('unit:concurrency-counts-live-only — a registry session with no running runtime session does not count toward the role\'s concurrency', async () => {
  await withConfig(async config => {
    const registry = registryWith(2, [session('s1', 'GY-1'), session('s2', 'GY-2')]);
    const { client } = fakeRegistry(registry);
    await recordFleetLaunch(config, { session: 's1', role: 'approver', work: 'GY-1', agentName: 'graphyard-approver-gy-1-aaaaaaaa', at: iso(-hour) });
    await recordFleetLaunch(config, { session: 's2', role: 'approver', work: 'GY-2', agentName: 'graphyard-approver-gy-2-bbbbbbbb', at: iso(-hour) });
    const agents: HerdrAgent[] = [{ name: 'graphyard-approver-gy-1-aaaaaaaa', pane_id: 'pane-1', agent_status: 'working' }];

    // Health: one of the two recorded sessions runs, so the role has a seat.
    const health = await fleetRoleHealth(config, 'approver', { registry: client, agents, now: () => clock });
    assert.equal(health!.available, true, health!.reason ?? '');
    // With both running it is full, and says so.
    const full = await fleetRoleHealth(config, 'approver', { registry: client, agents: [...agents, { name: 'graphyard-approver-gy-2-bbbbbbbb', pane_id: 'pane-2' }], now: () => clock });
    assert.equal(full!.available, false);
    assert.match(full!.reason!, /at its concurrency limit \(2 of 2 live\)/);

    // Selection: the control plane counts what is live, so the session nothing runs is ended
    // before the choice and the launch takes its seat instead of being refused.
    const selected = await selectFleetSession(config, 'approver', { name: 'graphyard-approver-gy-9-cccccccc' }, { registry: client, agents, work: 'GY-9', now: () => clock });
    assert.ok(selected?.selection.selected);
    assert.ok(registry.sessions.find(entry => entry.id === 's2')!.endedAt, 'the session whose runtime is gone was ended');
    assert.equal(registry.sessions.find(entry => entry.id === 's1')!.endedAt, null, 'the running one was not');
  });
});

test('unit:capacity-refusal-retried — an approver launch refused for role capacity is retried on the first cycle after a seat frees, without spending its launch bound', async () => {
  await withConfig(async config => {
    const item = mergeable(), name = approverSessionName(item, decisionId);
    // The one seat is held by another item's approver, still running in Herdr.
    const holder = approverSessionName({ key: 'GY-7' }, 'otherdecision');
    const registry = registryWith(1, [session('s7', 'GY-7')]);
    const { client } = fakeRegistry(registry);
    await recordFleetLaunch(config, { session: 's7', role: 'approver', work: 'GY-7', agentName: holder, at: iso(-hour) });
    let herdr: HerdrAgent[] = [{ name: holder, pane_id: 'pane-7', agent_status: 'working' }];
    const launches: string[] = [];
    const approver: DaemonEffects['approver'] = async work => {
      const selected = (await selectFleetSession(config, 'approver', { name }, { registry: client, agents: herdr, work: work.key, now: () => clock }))!;
      await selected.record(name);
      launches.push(name);
      herdr = [...herdr, { name, pane_id: 'pane-1', agent_status: 'working' }];
      return { agentName: name, pane: 'pane-1' };
    };
    const endFleetSessions: DaemonEffects['endFleetSessions'] = (agents, finished) => reconcileFleetSessions(config, agents, finished, { registry: client, now: () => clock });
    const effects = loopEffects(item, () => herdr, { approver, endFleetSessions });
    const state = emptyDaemonState(config);

    // More cycles at capacity than the decision's launch bound: none of them spends it.
    for (let cycle = 0; cycle < 5; cycle++) await runCycle(config, state, effects, () => clock + cycle * 20_000);
    assert.deepEqual(launches, []);
    const watch = Object.values(state.approvals)[0];
    assert.equal(watch.launches, 0, 'a capacity refusal is not a launch of the decision\'s approver');
    assert.equal(watch.exhaustedAt, null, 'the decision is not escalated as unjudged while it waits for a seat');
    assert.ok(Object.values(state.actions).some(action => /concurrency limit/.test(action.detail ?? '')), 'the refusal is on the record');

    // The holder finishes and leaves Herdr: the very next cycle ends its registry session and launches.
    herdr = [];
    await runCycle(config, state, effects, () => clock + 5 * 20_000);
    assert.deepEqual(launches, [name], 'launched on the first cycle after the seat freed');
    assert.equal(Object.values(state.approvals)[0].launches, 1);
    assert.equal(Object.values(state.approvals)[0].agentName, name);
  });
});
