import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { profileHealth } from '../src/daemon/sessions.js';
import { masterConfigSchema, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import type { Work } from '../src/model.js';

// GY-894 AC-2: with every worker profile held by ended sessions, the next dispatch tick claims
// and launches work instead of recording stalled actions. A session whose attempt ended but whose
// runtime still runs keeps its Herdr agent name listed, so profileHealth holds every profile and
// dispatch stops — the ten-ended-sessions jam. When the ended attempts' supervisors have stopped
// their runtimes (unit:ended-attempt-frees-slot), the names leave Herdr, every profile reads
// healthy again, and the very next tick dispatches without a hand and without a stalled action:
// a busy profile is capacity, never a fault to escalate or a failed action to record.

const observedAt = '2030-01-01T12:00:00.000Z';
const at = (offsetMs: number) => new Date(Date.parse(observedAt) + offsetMs).toISOString();
const jamSize = 10;
const profile = (index: number): WorkerProfile => ({
  name: `worker-${index}`, principal: `principal-${index}`, agentName: `graphyard-worker-${index}`,
  mode: 'launch', kind: 'claude', credentialFile: `/srv/credentials/worker-${index}.token`, agentArgs: [], approvals: 'auto', environment: {},
} as unknown as WorkerProfile);
const profiles = Array.from({ length: jamSize }, (_, index) => profile(index));
/**
 * The Herdr inventory of the jam: every profile's session, attempt ended, runtime still running.
 * A runtime that is idle or done instead no longer holds its profile (GY-1322): the dispatch
 * closes it, so only a session Herdr still reports working jams the fleet.
 */
const jamAgents = (): HerdrAgent[] => profiles.map(({ agentName }) => ({ name: agentName, pane_id: `pane-${agentName}`, agent_status: 'working' }));

function item(key: string, overrides: Partial<Work> = {}): Work {
  return {
    id: `work-${key}`, key, title: `Item ${key}`, description: '', type: 'bug', priority: 0,
    dependencies: [], criteria: [], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage: 'build', revision: 1, policyRevision: 1,
    createdAt: at(-7_200_000), updatedAt: observedAt, stageEnteredAt: at(-600_000),
    ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null,
    reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [], containmentQuarantine: null,
    ...overrides,
  } as unknown as Work;
}
/** Ten attempts the server ended (submitted, awaiting an operator's rework decision): they hold no lease, yet their sessions still hold every profile. */
const jamItems = () => Array.from({ length: jamSize }, (_, index) => item(`GY-${100 + index}`, { ready: false, submission: { pr: 400 + index, epoch: 1 } as Work['submission'] }));
/** The item a freed slot must reach: ready, unassigned, never submitted. */
const waiting = () => item('GY-110');

function daemon(overrides: Partial<DaemonEffects> = {}) {
  const config: MasterConfig = masterConfigSchema.parse({
    version: 1, url: 'https://graphyard.example', credentialFile: '/srv/graphyard/coordinator.token', cliPath: '/srv/graphyard/bin/graphyard.mjs',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'coordinator-host',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: profiles,
  });
  const state: DaemonState = emptyDaemonState(config);
  const dispatched: { key: string; profile: string }[] = [];
  const effects: DaemonEffects = {
    agents: () => Promise.resolve(herdr()),
    herdr: () => ({ agents: herdr(), available: true }),
    stopSupervisor: () => {},
    credentials: async configured => Object.fromEntries(configured.map(entry => [entry.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: [...jamItems(), waiting()], now: observedAt }),
    closeSession: () => {},
    dispatch: async (item, chosen) => { dispatched.push({ key: item.key, profile: chosen.name }); return {}; },
    requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: observedAt, reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
    ...overrides,
  };
  let herdr = jamAgents;
  return {
    config, state, effects, dispatched,
    /** The ended attempts' supervisors stop their runtimes: the names leave Herdr (AC-1). */
    endTheSessions: () => { herdr = () => []; },
    run: () => runCycle(config, state, effects, () => Date.parse(observedAt)),
  };
}

test('unit:dispatch-recovers-from-jam — every profile held by an ended session stalls dispatch without a fault; once the runtimes stop, the next tick claims and launches', async () => {
  const harness = daemon();

  // The jam: every worker profile is held by an ended session, so the tick cannot claim GY-110.
  await harness.run();
  assert.deepEqual(harness.dispatched, [], 'a tick under the jam launches nothing');
  const jamActions = Object.values(harness.state.actions);
  assert.deepEqual(jamActions.filter(action => action.work === 'GY-110' && action.state === 'failed'), [],
    'a profile held by an ended session is capacity, so the tick records no failed dispatch for the item it could not claim');
  assert.deepEqual(jamActions.filter(action => /No worker profile can take/.test(action.detail ?? '')), [],
    'and no stalled-action escalation either: a busy profile is a wait for a slot, not a fault');

  // The recovery: the ended attempts' runtimes are stopped, the names leave Herdr, and the very
  // next tick claims and launches the waiting item — no hand, no master, no recorded stall.
  harness.endTheSessions();
  await harness.run();
  assert.deepEqual(harness.dispatched, [{ key: 'GY-110', profile: 'worker-0' }],
    'the next dispatch tick claims the waiting item and launches it on the profile the ended session freed');
  const dispatch = Object.values(harness.state.actions).find(action => action.work === 'GY-110' && action.kind === 'dispatch');
  assert.equal(dispatch?.state, 'done', `the launch is recorded done, not stalled: ${dispatch?.detail ?? 'no dispatch action recorded'}`);
  assert.match(dispatch!.detail!, /Dispatched GY-110 to worker-0/);
  assert.deepEqual(Object.values(harness.state.actions).filter(action => action.work === 'GY-110' && action.state === 'failed'), []);
});

test('unit:dispatch-recovers-from-jam — the launcher gate names every ended-session hold, and frees every profile once the names leave Herdr', () => {
  const credentials = Object.fromEntries(profiles.map(entry => [entry.name, { available: true, reason: null }]));
  const health = (agents: HerdrAgent[]) => profileHealth(profiles, credentials, agents, emptyDaemonState(masterConfigSchema.parse({
    version: 1, url: 'https://graphyard.example', credentialFile: '/srv/coordinator.token', cliPath: '/srv/bin/graphyard.mjs',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1, hostId: 'host', masterAgentName: 'm', workers: [],
  })), Date.parse(observedAt));

  // The jam at the seam both the loop and the executor read (profileHealth): every profile is
  // held by an ended session, so the launcher's refusal is exactly the stalled action recorded.
  const held = health(jamAgents());
  assert.deepEqual(held.map(entry => entry.healthy), profiles.map(() => false), 'no profile can take work while its ended session still holds its name');
  const refusal = `no worker profile can take GY-894: ${held.map(entry => `${entry.profile.name} (${entry.reason})`).join('; ')}`;
  assert.match(refusal, /^no worker profile can take GY-894: worker-0 \(Herdr agent graphyard-worker-0 is working\)/);
  for (const entry of profiles) assert.match(refusal, new RegExp(`${entry.name} \\(Herdr agent ${entry.agentName} is working\\)`));

  // The recovery: the same gate, once the ended sessions' names have left Herdr.
  const freed = health([]);
  assert.deepEqual(freed.map(entry => entry.healthy), profiles.map(() => true), 'every profile is dispatchable once the ended sessions stopped');
  const taken = new Set<string>();
  const pick = freed.find(entry => entry.healthy && !taken.has(entry.profile.name));
  assert.equal(pick?.profile.name, 'worker-0', 'the tick claims and launches on the first freed profile');
});
