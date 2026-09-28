import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import type { MasterConfig, HerdrAgent } from '../src/master.js';
import type { Work } from '../src/model.js';

// GY-898: the loop launches, adopts, wakes and rotates its own master session. One case per proof:
// unit:master-session-supervised-and-rotated, unit:master-wake-on-event.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock0 = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs = 0) => new Date(clock0 + offsetMs).toISOString();

function item(key: string): Work {
  return {
    id: `work-${key}`, key, title: `Master session ${key}`, description: '', type: 'feature', priority: 0, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Done', proofs: ['manual:x'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage: 'build', revision: 1, policyRevision: 1, createdAt: iso(-7_200_000), updatedAt: iso(), stageEnteredAt: iso(-3_600_000), ready: true, epoch: 0,
    lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }], violations: [],
  } as unknown as Work;
}

const config = (run: Partial<MasterConfig['run']> = {}): MasterConfig => ({ hostId: 'machine-a', autoMerge: true, mergeMethod: 'merge', workers: [], reviewers: [], producers: [],
  repository: 'owner/project', baseBranch: 'main', url: 'https://graphyard.example', credentialFile: '/dev/null', cliPath: launcher, githubAppId: 1234,
  masterAgentName: 'graphyard-master-test', run: { intervalSeconds: 20, ...run } } as unknown as MasterConfig);

interface Harness {
  agents: HerdrAgent[];
  launches: string[];
  wakes: string[];
  closed: string[];
  ended: [string, string][];
  held: [string, { reason: string; role: string; profile: string }][];
  outputs: Record<string, string>;
}

function effects(config: MasterConfig, state: { master: Harness }, work: Work[], at: { value: number }, extra: Partial<DaemonEffects> = {}): DaemonEffects {
  return {
    agents: () => state.master.agents,
    herdr: () => ({ agents: state.master.agents, available: true }),
    credentials: async () => ({}),
    snapshot: async () => ({ work, now: new Date(at.value).toISOString() }),
    closeSession: pane => { state.master.closed.push(pane); state.master.agents = state.master.agents.filter(agent => agent.pane_id !== pane); },
    dispatch: async () => {},
    requestProof: () => {},
    merge: async () => ({ result: 'merged', merged: true }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(at.value).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    sessionOutput: async (agent: HerdrAgent) => state.master.outputs[agent.name ?? ''] ?? '',
    promptSession: async (agent: HerdrAgent, text: string) => { state.master.wakes.push(text); },
    endRegistrySession: async (session: string, reason: string) => { state.master.ended.push([session, reason]); },
    holdAccount: async (account: string, observed: { reason: string; role: string; profile: string }) => { state.master.held.push([account, observed]); },
    masterSession: { launch: async handover => {
      state.master.launches.push(handover);
      return { agentName: config.masterAgentName!, pane: `pane-${state.master.launches.length}`, runtime: 'claude', account: 'claude-a', session: `reg-${state.master.launches.length}` };
    } },
    persist: async () => {},
    ...extra,
  };
}

const sessionAgent = (config: MasterConfig, pane: string, status = 'idle'): HerdrAgent => ({ name: config.masterAgentName, pane_id: pane, agent: 'claude', agent_status: status });

test('unit:master-session-supervised-and-rotated — the loop launches its master session from a durable handover, adopts at most one, restarts it when it exits, fails it over on a limit notice, rotates it at its budget (deferred while a merge is in flight), and never launches a second', async () => {
  const cfg = config({ masterSessionMinutes: 30, masterHeartbeatMinutes: 30 });
  const state = emptyDaemonState(cfg);
  const harness: Harness = { agents: [], launches: [], wakes: [], closed: [], ended: [], held: [], outputs: {} };
  const work = [item('GY-1')];
  const at = { value: clock0 };
  const loop = effects(cfg, { master: harness }, work, at);
  const cycle = (offsetMs: number) => { at.value = clock0 + offsetMs; return runCycle(cfg, state, loop, () => at.value); };

  // Cycle 1: nothing holds the role, so the handover is composed from the snapshot and one session launched.
  await cycle(0);
  assert.equal(harness.launches.length, 1, 'exactly one master session is launched');
  assert.match(harness.launches[0], /Durable handover/);
  assert.match(harness.launches[0], /dispatch:GY-1/, 'the handover names the standing subjects');
  assert.equal(state.master.agentName, cfg.masterAgentName);
  assert.equal(state.master.pane, 'pane-1');
  assert.equal(state.master.account, 'claude-a');
  assert.equal(state.master.session, 'reg-1');
  assert.equal(state.master.rotations, 1);
  assert.deepEqual(harness.wakes, [], 'a replacement is not woken for the subjects its handover named');

  // Cycle 2: the session is live; nothing new, so no second launch and no wake.
  harness.agents = [sessionAgent(cfg, 'pane-1')];
  await cycle(20_000);
  assert.equal(harness.launches.length, 1, 'at most one master session runs');
  assert.deepEqual(harness.wakes, []);

  // Cycle 3: a second dispatchable item appears — exactly one wake, naming the changed subject.
  work.push(item('GY-2'));
  await cycle(40_000);
  assert.equal(harness.wakes.length, 1);
  assert.match(harness.wakes[0], /dispatch:GY-2/, 'the wake names its cause');
  assert.match(harness.wakes[0], /not untrusted text/);
  assert.deepEqual(state.master.lastWake, { at: iso(40_000), causes: ['dispatch:GY-2'], heartbeat: false });

  // Cycle 4: nothing changed, so nothing wakes again.
  await cycle(60_000);
  assert.equal(harness.wakes.length, 1, 'an unchanged cause never wakes twice');

  // Cycle 5: the pane is working, so the wake for GY-3 waits; cycle 6 delivers it.
  work.push(item('GY-3'));
  harness.agents = [sessionAgent(cfg, 'pane-1', 'working')];
  await cycle(80_000);
  assert.equal(harness.wakes.length, 1, 'a wake is not typed into a working pane');
  harness.agents = [sessionAgent(cfg, 'pane-1')];
  await cycle(100_000);
  assert.equal(harness.wakes.length, 2);
  assert.match(harness.wakes[1], /dispatch:GY-3/);

  // Exit: the session is gone from Herdr. One miss waits; the second rotates and relaunches.
  harness.agents = [];
  await cycle(300_000);
  assert.equal(harness.launches.length, 1, 'the first miss launches nothing');
  assert.deepEqual(harness.ended, [], 'the first miss ends nothing');
  await cycle(320_000);
  assert.deepEqual(harness.ended.map(entry => entry[0]), ['reg-1'], 'the rotation ends the registry session');
  assert.match(harness.ended[0][1], /exited/);
  assert.equal(harness.launches.length, 2, 'the role relaunches from the durable handover');
  assert.equal(state.master.rotations, 2);
  assert.equal(state.master.lastEnd?.cause, 'exited');
  assert.match(state.master.lastEnd!.detail, /gone from Herdr on two consecutive readings/);

  // Quota: the relaunched session stops on its provider's limit notice — account held, pane closed, relaunched.
  harness.agents = [sessionAgent(cfg, 'pane-2')];
  harness.outputs[cfg.masterAgentName!] = 'Error: usage limit has been reached. Your limit resets at 4pm';
  await cycle(340_000);
  assert.equal(state.master.lastEnd?.cause, 'exhausted');
  assert.deepEqual(harness.closed, ['pane-1', 'pane-2'], 'the spent session pane is closed (the exited pane was closed with it)');
  assert.deepEqual(harness.held.map(([account]) => account), ['claude-a'], 'the account it spent is held');
  assert.equal(harness.held[0][1].role, 'master');
  assert.equal(harness.held[0][1].profile, 'master');
  assert.match(harness.held[0][1].reason, /usage limit/);
  assert.equal(harness.launches.length, 3);
  assert.equal(state.master.rotations, 3);
  harness.outputs = {};

  // Budget: the session is live but past its 30-minute budget. A guarded merge in flight defers the
  // rotation one cycle; once none is, the rotation closes the pane and relaunches.
  harness.agents = [sessionAgent(cfg, 'pane-3')];
  const mergeKey = 'merge:work-GY-1';
  // A guarded merge GitHub has not performed yet is recorded waiting, and that is what defers the rotation.
  state.actions[mergeKey] = { kind: 'merge', work: 'GY-1', principal: null, state: 'waiting', detail: 'Guarded merge pending for GY-1', attempts: 1, cycle: state.cycle, at: iso(), epoch: null };
  await cycle(340_000 + 31 * 60_000);
  assert.equal(harness.launches.length, 3, 'the rotation defers while a guarded merge is in flight');
  assert.equal(state.master.lastEnd?.cause, 'exhausted');
  delete state.actions[mergeKey];
  await cycle(340_000 + 32 * 60_000);
  assert.equal(state.master.lastEnd?.cause, 'budget');
  assert.match(state.master.lastEnd!.detail, /past its 30-minute session budget/);
  assert.deepEqual(harness.closed, ['pane-1', 'pane-2', 'pane-3']);
  assert.equal(harness.launches.length, 4, 'the role relaunches after the deferred rotation');
  assert.equal(state.master.rotations, 4);
  assert.equal(state.master.pane, 'pane-4');

  // Adoption: with the record cleared and a session the loop did not launch visible under the
  // configured name, the loop adopts it — never a second.
  state.master = { ...state.master, agentName: null, pane: null, startedAt: null };
  harness.agents = [sessionAgent(cfg, 'pane-human')];
  const adopted = await cycle(340_000 + 33 * 60_000);
  assert.equal(harness.launches.length, 4, 'no second master session is launched');
  assert.equal(state.master.agentName, cfg.masterAgentName);
  assert.equal(state.master.adopted, true);
  assert.equal(state.master.pane, 'pane-human');
  assert.ok(adopted.actions.some(action => action.kind === 'session' && /Adopted master session/.test(action.detail)));

  // Exit in place: the adopted session's runtime has left its pane — Herdr still lists the pane,
  // with no agent in it and status unknown. That reads as a miss, never as a live pane: one miss
  // waits, the second rotates, the pane it left is closed so the name frees, and the role
  // relaunches from the durable handover.
  harness.agents = [{ name: cfg.masterAgentName, pane_id: 'pane-human', agent: null, agent_status: 'unknown' }];
  await cycle(340_000 + 33 * 60_000 + 130_000);
  assert.equal(harness.launches.length, 4, 'the first reading of a runtime-less pane launches nothing');
  await cycle(340_000 + 33 * 60_000 + 260_000);
  assert.equal(state.master.lastEnd?.cause, 'exited');
  assert.match(state.master.lastEnd!.detail, /runtime has left pane pane-human/);
  assert.ok(harness.closed.includes('pane-human'), 'the pane the runtime left is closed so the relaunch can take the name');
  assert.equal(harness.launches.length, 5, 'the role relaunches from the durable handover');
  assert.equal(state.master.rotations, 5);
  assert.equal(state.master.pane, 'pane-5');
});

test('unit:master-wake-on-event — a material event produces exactly one wake naming its cause, an unchanged cycle none, a changed state one more, and the heartbeat is only the silence fallback', async () => {
  const cfg = config({ masterHeartbeatMinutes: 5 });
  const state = emptyDaemonState(cfg);
  const harness: Harness = { agents: [], launches: [], wakes: [], closed: [], ended: [], held: [], outputs: {} };
  const work = [item('GY-1')];
  const at = { value: clock0 };
  const loop = effects(cfg, { master: harness }, work, at);
  const cycle = (offsetMs: number) => { at.value = clock0 + offsetMs; return runCycle(cfg, state, loop, () => at.value); };

  // The session is launched with a handover that already names the standing subjects.
  await cycle(0);
  assert.equal(harness.launches.length, 1);
  harness.agents = [sessionAgent(cfg, 'pane-1')];

  // Unchanged cycle: no wake at all.
  await cycle(20_000);
  assert.equal(harness.wakes.length, 0, 'an unchanged cycle produces no wake');

  // The event: a second claimable item. Exactly one wake, recorded on the cursor, naming the cause.
  work.push(item('GY-2'));
  const woken = await cycle(40_000);
  const wakes = woken.actions.filter(action => action.kind === 'wake');
  assert.equal(wakes.length, 1, 'exactly one wake action is recorded');
  assert.match(wakes[0].detail, /dispatch:GY-2/, 'the recorded wake names its cause');
  assert.equal(harness.wakes.length, 1);
  assert.deepEqual(state.master.lastWake, { at: iso(40_000), causes: ['dispatch:GY-2'], heartbeat: false });

  // Unchanged again: still exactly one.
  await cycle(60_000);
  assert.equal(harness.wakes.length, 1);
  assert.equal(woken.actions.filter(action => action.kind === 'wake').length >= 0, true);

  // Heartbeat: silence past the configured window produces the one fallback wake, then the clock resets.
  await cycle(40_000 + 6 * 60_000);
  assert.equal(harness.wakes.length, 2, 'the heartbeat is the fallback after the quiet window');
  assert.match(harness.wakes[1], /heartbeat/);
  assert.equal(state.master.lastWake?.heartbeat, true);
  assert.deepEqual(state.master.lastWake?.causes, []);
  await cycle(40_000 + 6 * 60_000 + 20_000);
  assert.equal(harness.wakes.length, 2, 'the heartbeat clock resets, so silence does not wake every cycle');
});
