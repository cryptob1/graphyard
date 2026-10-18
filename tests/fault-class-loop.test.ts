import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';
import { masterConfigSchema, workerProfileSchema, type MasterConfig } from '../src/master.js';
import { actionableSubjects } from '../src/daemon/metrics.js';
import { emptyDaemonState, runCycle, type DaemonState, type DaemonEffects } from '../src/master-daemon.js';
import { Launcher } from '../src/daemon/cycle.js';
import type { HerdrAgent } from '../src/master.js';

// GY-1890 named this file for its proof: manual:fault-class-loop. The master loop had filed
// loop-silence faults on dispatch subjects through one saturated-fleet stretch, because the
// per-subject silence measure reset a wait only on a successful action and the loop could not act:
// only a worker finishing frees a slot. The fix made the measure learn what the dispatch step
// decided (`saturatedFleet`, read back through `cycle.fleetHeld`): a claimable item under a held
// fleet is a capacity subject with the fixed hold wording, and the step records the held fleet on
// the item it could not place — names only, no live reason, `work: null` — so the record never
// restarts the wait it found. A fleet that cannot launch at all is not saturation: the step
// escalates for a working credential and the item stays a dispatch subject.
//
// GY-1980 removed the silence measure itself: there is no bound to breach and no class to file,
// and whether the whole pipeline has gone still is the progress watchdog's judgement. What
// survives here is that classification and its record: the tests pin the subject kinds, the fixed
// wording and the bounded `capacity:` record the master session's wake reads.

// The stretch's own instants, as the loop recorded them; every reading in this file is one of
// these fixed values or derived from one, and no wall-clock call runs anywhere in this file.
const firstSeen = Date.parse('2026-10-17T08:10:58.270Z'); // the stretch's start
const minute = 60_000;
const iso = (at: number) => new Date(at).toISOString();

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [], run: { proofWorkflow: 'acceptance.yml' } });
}
/** A worker fleet of `count` launch profiles: the installation ran ten; the replay holds every one. */
function workerFleet(count: number) {
  return Array.from({ length: count }, (_, index) => workerProfileSchema.parse({
    name: `worker-${index}`, principal: `graphyard-worker-${index}`, agentName: `graphyard-worker-${index}`, mode: 'launch', kind: 'claude',
    credentialFile: '/outside/worker.token',
  }));
}
const gate = (name: string, passed: boolean, reasons: string[] | string = []) => ({ name, passed, reasons: passed ? [] : Array.isArray(reasons) ? reasons : [reasons] });
function item(key: string, since: string): Work {
  return {
    id: `work-${key}`, key, title: `Item ${key}`, description: '', type: 'bug', priority: 1, dependencies: [], criteria: [],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/'], stage: 'build', revision: 1, policyRevision: 1,
    createdAt: iso(Date.parse(since) - 30 * minute), updatedAt: iso(Date.parse(since)), stageEnteredAt: iso(Date.parse(since) - 5 * minute),
    ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [gate('ready', false, `${key} is ready and unassigned: no worker holds it`)], violations: [],
  } as unknown as Work;
}
function daemonState(master: MasterConfig): DaemonState {
  return emptyDaemonState(master);
}
/** The hold the launch step records: names only, no live reason that moves every cycle, and `work: null`. */
const holdWording = 'is claimable but no worker profile is free; it starts when one frees';
const heldFleet = (fleet: number) => Array.from({ length: fleet }, (_, index) => `worker-${index}`).join(', ');
const effectsOver = (work: Work[], agents: HerdrAgent[], clock: number, credentials: DaemonEffects['credentials'] = async () => ({})): DaemonEffects => ({
  agents: () => agents,
  herdr: async () => ({ agents, available: true }),
  credentials,
  snapshot: async () => ({ work, now: iso(clock) }),
  closeSession: () => {},
  dispatch: async () => {},
  requestProof: () => {},
  observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(clock), reason: 'not configured', deployed: [], pending: [] }),
  recordDeployment: async () => {},
  requestSmoke: () => {},
  persist: async () => {},
});
const capacityRecords = (state: DaemonState) => Object.entries(state.actions).filter(([key]) => key.startsWith('capacity:work-'));

test('manual:fault-class-loop — GY-1890: a cycle over a saturated fleet records the held fleet on the item it could not place, once, and the queue measures as capacity subjects', async () => {
  const master = masterConfigSchema.parse({ ...config(), workers: JSON.parse(JSON.stringify(workerFleet(2))) });
  const work = [item('GY-1886', '2026-10-17T08:10:58.270Z'), item('GY-1888', '2026-10-17T08:31:54.081Z'), item('GY-1889', '2026-10-17T08:34:00.351Z')];
  const agents: HerdrAgent[] = workerFleet(2).map(profile => ({ name: profile.agentName, pane_id: `pane-${profile.name}`, agent_status: 'working' }));
  const clock = firstSeen;
  const state = daemonState(master);
  state.lock = { pid: process.pid, host: 'machine-a', startedAt: iso(clock), heartbeatAt: iso(clock) } as DaemonState['lock'];
  const launcher = new Launcher();
  const result = await runCycle(master, state, effectsOver(work, agents, clock), () => clock, launcher);
  await launcher.idle();
  const held = capacityRecords(state);
  assert.equal(held.length, 1, 'the launch step stops at the first item it cannot place and records the held fleet once');
  const [key, action] = held[0];
  assert.equal(action.state, 'done', `${key} records the finding, not a failure`);
  assert.match(action.detail, /^Every worker profile is held/);
  assert.match(action.detail, /worker-0, worker-1/, 'the record names the held profiles, and no live reason that moves every cycle');
  assert.equal(action.work, null, 'the hold acts on no subject, so it never restarts the wait it found');
  // The measure folds the same facts: with the step's own saturation stop, the queue is capacity
  // subjects worded so; without it, dispatch subjects. The kinds are the master wake's to read.
  const subjects = actionableSubjects(master, work, clock, { fleetHeld: true });
  assert.deepEqual(subjects.map(entry => entry.kind), ['capacity', 'capacity', 'capacity']);
  for (const subject of subjects) assert.ok(subject.detail.startsWith(`${subject.work} ${holdWording}`), `${subject.work} names the held fleet`);
  assert.deepEqual(actionableSubjects(master, work, clock).map(entry => entry.kind), ['dispatch', 'dispatch', 'dispatch'], 'without the step\u2019s stop the same queue reads as dispatch');
  assert.equal(result.metrics.actionable, 3, 'the cycle still records what it could act on');
});

test('manual:fault-class-loop — GY-1890: a fleet whose free profiles are all held by in-flight launches is saturated: the step records the hold and the queue measures as capacity', async () => {
  const master = masterConfigSchema.parse({ ...config(), workers: JSON.parse(JSON.stringify(workerFleet(2))) });
  const work = [item('GY-1886', '2026-10-17T08:10:58.270Z'), item('GY-1888', '2026-10-17T08:31:54.081Z')];
  const agents: HerdrAgent[] = [];
  const clock = firstSeen;
  const state = daemonState(master);
  state.lock = { pid: process.pid, host: 'machine-a', startedAt: iso(clock), heartbeatAt: iso(clock) } as DaemonState['lock'];
  const launcher = new Launcher();
  // Both profiles are healthy and free in Herdr, but a launch holds each from hand-off until it
  // settles (GY-616), across cycles. The step must treat the fleet as saturated here — exactly the
  // production shape of GY-1886/1888/1889 — and the master wake must read capacity, not dispatch.
  let release!: () => void;
  const settled = new Promise<void>(resolve => { release = resolve; });
  launcher.submit('held:gy-1886', ['worker-0'], async () => { await settled; });
  launcher.submit('held:gy-1888', ['worker-1'], async () => { await settled; });
  await runCycle(master, state, effectsOver(work, agents, clock), () => clock, launcher);
  const held = capacityRecords(state);
  assert.equal(held.length, 1, 'the step records the held fleet on the first item it cannot place');
  assert.match(held[0][1].detail, /worker-0, worker-1/, 'the record names the profiles the in-flight launches hold');
  assert.equal(held[0][1].work, null, 'the hold acts on no subject');
  assert.deepEqual(actionableSubjects(master, work, clock, { fleetHeld: true }).map(entry => entry.kind), ['capacity', 'capacity'], 'the queue is capacity subjects, not dispatch');
  release();
  await launcher.idle();
});

test('manual:fault-class-loop — GY-1890: a profile free in the cycle-start snapshot but occupied in the launch step’s fresh inventory read is held: saturation follows the step’s own availability', async () => {
  const master = masterConfigSchema.parse({ ...config(), workers: JSON.parse(JSON.stringify(workerFleet(2))) });
  const work = [item('GY-1886', '2026-10-17T08:10:58.270Z'), item('GY-1888', '2026-10-17T08:31:54.081Z')];
  const occupying: HerdrAgent[] = workerFleet(2).map(profile => ({ name: profile.agentName, pane_id: `pane-${profile.name}`, agent_status: 'working' }));
  const clock = firstSeen;
  const state = daemonState(master);
  state.lock = { pid: process.pid, host: 'machine-a', startedAt: iso(clock), heartbeatAt: iso(clock) } as DaemonState['lock'];
  // The cycle-start reads (observe, profile health) see an empty fleet, so every profile is healthy
  // and free there, and no launcher holds one. Only the dispatch step's own fresh read finds both
  // profiles' agents at work, as when an attempt starts between the snapshot and the launch step.
  const fresh = () => /dispatchStepWithin/.test(new Error().stack ?? '');
  const effects = effectsOver(work, [], clock);
  effects.agents = () => fresh() ? occupying : [];
  effects.dispatch = async () => { throw new Error('no profile is free: nothing may launch'); };
  const launcher = new Launcher();
  await runCycle(master, state, effects, () => clock, launcher);
  await launcher.idle();
  assert.equal(state.actions['escalation:dispatch:work-GY-1886'], undefined, 'an occupied fleet is capacity, never an escalation for a working credential');
  const held = capacityRecords(state);
  assert.equal(held.length, 1, 'the step records the held fleet on the item it could not place');
  assert.match(held[0][1].detail, /worker-0, worker-1/);
  assert.deepEqual(actionableSubjects(master, work, clock, { fleetHeld: true }).map(entry => entry.kind), ['capacity', 'capacity'], 'the wake follows the step’s fresh availability, not the snapshot');
});

test('manual:fault-class-loop — GY-1890: an item whose own launch is in flight is not fleet-held: when a later item finds the fleet saturated, only that later item is a capacity subject', () => {
  const master = config();
  const work = [item('GY-2004', '2026-10-17T08:10:58.270Z'), item('GY-2005', '2026-10-17T08:11:58.270Z')];
  const launching = (entry: Work) => entry.key === 'GY-2004';
  const subjects = actionableSubjects(master, work, firstSeen, { fleetHeld: true, launching });
  assert.deepEqual(subjects.map(entry => `${entry.work}:${entry.kind}`).sort(), ['GY-2004:dispatch', 'GY-2005:capacity'], 'the in-flight item waits on its own launch, the queued one on the fleet');
  assert.match(subjects.find(entry => entry.work === 'GY-2005')!.detail, /GY-2005 is claimable but no worker profile is free; it starts when one frees/);
});

test('manual:fault-class-loop — GY-1890: a fleet that cannot launch at all is not a held fleet: the wait stays the loop’s dispatch subject, and the step escalates for a working credential', async () => {
  const master = masterConfigSchema.parse({ ...config(), workers: JSON.parse(JSON.stringify(workerFleet(2))) });
  const work = [item('GY-2002', '2026-10-17T08:10:58.270Z')];
  const agents: HerdrAgent[] = [];
  const clock = firstSeen;
  const state = daemonState(master);
  state.lock = { pid: process.pid, host: 'machine-a', startedAt: iso(clock), heartbeatAt: iso(clock) } as DaemonState['lock'];
  // Every launch credential spent, and no profile busy: nothing could take work even if it were
  // free. Dispatch escalates for a working credential; that is not a fleet held by live attempts.
  const credentials = async () => Object.fromEntries(workerFleet(2).map(profile => [profile.name, { available: false, reason: 'launch credential is spent' }]));
  const result = await runCycle(master, state, effectsOver(work, agents, clock, credentials), () => clock, new Launcher());
  assert.equal(capacityRecords(state).length, 0, 'an unlaunchable fleet is never recorded as a held fleet');
  assert.ok(state.actions['escalation:dispatch:work-GY-2002'], 'the step escalates: no profile could take work even free');
  assert.deepEqual(actionableSubjects(master, work, clock).map(entry => entry.kind), ['dispatch'], 'the claimable item stays the loop’s dispatch subject');
  assert.deepEqual(actionableSubjects(master, work, clock, { fleetHeld: true }).map(entry => entry.kind), ['capacity'], 'only the step’s own stop ever reclasses it');
  assert.equal(result.metrics.actionable, 1);
});

test('manual:fault-class-loop — GY-1890 soak: two simulated hours over a saturated fleet record the hold a bounded number of times per item, though the fleet’s live signals churn every cycle', async () => {
  const master = masterConfigSchema.parse({ ...config(), workers: JSON.parse(JSON.stringify(workerFleet(2))) });
  const work = [item('GY-1886', '2026-10-17T08:10:58.270Z'), item('GY-1888', '2026-10-17T08:31:54.081Z'), item('GY-1889', '2026-10-17T08:34:00.351Z')];
  // The fleet stays saturated the whole run: each profile's agent is present and at work, which is
  // capacity, not a breakdown. The agents' live status flips every cycle — the volatile signal the
  // record's detail used to carry, whose every move re-recorded the hold.
  const agents: HerdrAgent[] = workerFleet(2).map(profile => ({ name: profile.agentName, pane_id: `pane-${profile.name}`, agent_status: 'working' }));
  let clock = firstSeen;
  const state = daemonState(master);
  state.lock = { pid: process.pid, host: 'machine-a', startedAt: iso(firstSeen), heartbeatAt: iso(firstSeen) } as DaemonState['lock'];
  const effects = effectsOver(work, agents, clock);
  effects.snapshot = async () => {
    for (const agent of agents) agent.agent_status = agent.agent_status === 'working' ? 'blocked' : 'working';
    return { work, now: iso(clock) };
  };
  const launcher = new Launcher();
  await runCycle(master, state, effects, () => clock, launcher);
  for (let pass = 1; pass < 120; pass++) { clock += minute; await runCycle(master, state, effects, () => clock, launcher); }
  // Bounded writes: once, though the fleet's live signals moved on every one of the 120 cycles.
  const held = capacityRecords(state);
  assert.equal(held.length, 1, 'the step stops at the head of the queue; the hold is that item’s record');
  const [heldKey, heldAction] = held[0];
  assert.equal(heldAction.attempts, 1, `${heldKey} is written once over 120 cycles of churning agent status`);
  assert.equal(heldAction.work, null, 'the hold acts on no subject, so nothing restarts the wait it found');
  assert.match(heldAction.detail, /Every worker profile is held while GY-1886 is claimable \(worker-0, worker-1\)/, 'the record carries its fixed wording, and no live reason that moves every cycle');
});
