import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';
import { masterConfigSchema, workerProfileSchema, type MasterConfig } from '../src/master.js';
import { actionableSubjects, fleetHold, fleetHoldWording, trackSilence, silenceBudgetMs } from '../src/daemon/metrics.js';
import type { DaemonAction } from '../src/daemon/state.js';
import { loopAttention } from '../src/daemon/liveness.js';
import { emptyDaemonState, runCycle, type DaemonState, type DaemonEffects } from '../src/master-daemon.js';
import { Launcher } from '../src/daemon/cycle.js';
import type { HerdrAgent } from '../src/master.js';

// GY-1890 names this file for its proof: manual:fault-class-loop. The master loop filed 3 loop-silence
// faults in 24 hours on 17 October 2026, all on dispatch subjects ("claimable and waiting for a
// worker"), all inside one continuous ~45-minute stretch (08:11–08:56Z):
//
// - GY-1886 (08:31:58.270Z): 21 minutes, 2 subjects actionable — dispatched to claude-quinary at
//   08:32:08, ten seconds after the filing, when that profile's attempt ended.
// - GY-1888 (08:52:54.081Z): 21 minutes, 4 subjects actionable — dispatched at 08:56:30.
// - GY-1889 (08:54:09.296Z): 42 minutes, 6 subjects actionable — still queued past 09:16.
//
// The shared cause: the fleet was saturated. Every launch profile was held by a live attempt while a
// queue of claimable items waited, and the loop cycled at its 30-second actionable cadence the whole
// time (cycles 17929–17956, 20–80s each, no failed cycle). The launch step that finds no free profile
// records nothing on any claimable subject, and the silence measure only resets a subject's clock on a
// successful action for it — so each queued item's clock ran past the 20-minute bound and the loop
// class was filed for a wait no cycle of the loop could end: only a worker finishing frees a slot.
// That wait is capacity's — "a role starved of slots", the class reviewer launch waits already file
// under as `concurrency-starved` — not the loop's.
//
// The fix: the measure learns what the dispatch step decided, by the step's own predicate
// (`saturatedFleet`, exported from the launch step and read back through `cycle.fleetHeld`). When
// the step stops because no launch profile could take work while some is launchable — held by an
// in-flight launch, at work, or otherwise taken — a claimable item is a capacity subject with the
// fixed fleet-hold wording (`fleetHoldWording`), and the step records the held fleet on the item
// it could not place: names only, no live reason that moves every cycle, and `work: null`, so the
// record never restarts the wait it found. A silence line over such a subject files
// `concurrency-starved` (capacity) instead of `loop-silence` (loop). A fleet that cannot launch at
// all — every credential spent, every profile cooling off — is not saturation: the step escalates
// for a working credential, and the wait stays the loop's to carry.
//
// Each instance listed on GY-1890 is replayed below as it stood when the loop filed it. Against the
// base (the measure without the fleet's answer) each reproduces: the exact loop-silence line, the
// instance's idle minutes, on the instance's subject. Against the candidate none recurs: the wait is
// the capacity class's to carry, and the loop class stays quiet through the same stretch. The bound
// itself is not weakened: a claimable item with a free profile that nothing dispatches still breaches
// as loop-silence, and a fleet-held item still breaches past the bound — as capacity.

// The instances' own instants, as the loop recorded them; every reading in this file is one of these
// fixed values or derived from one, and no wall-clock call runs beside them.
const firstSeen = Date.parse('2026-10-17T08:10:58.270Z'); // GY-1886's subject since; the stretch's start
const filedAt = {
  GY1886: '2026-10-17T08:31:58.270Z',
  GY1888: '2026-10-17T08:52:54.081Z',
  GY1889: '2026-10-17T08:54:09.296Z',
} as const;
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
/** A state with its own silence record: the schema's default object is one shared value. */
function daemonState(master: MasterConfig): DaemonState {
  const state: DaemonState = { ...emptyDaemonState(master), silence: { subjects: {}, lastActionAt: null } };
  state.lock = { pid: process.pid, host: 'machine-a', startedAt: iso(firstSeen), heartbeatAt: iso(firstSeen) } as DaemonState['lock'];
  return state;
}
const runningLiveness = (state: DaemonState) => ({ state: 'running' as const, detail: '', lagMs: 1, stalledAfterMs: 600_000, cycle: 1, lock: state.lock, restart: '', cost: null });

/** A capacity record the launch step made this cycle, whole as `record` writes it: it acts on no subject (`work: null`), so it never restarts the wait it found. */
const capacityAction = (work: string | null, at: number, detail: string): DaemonAction => ({ kind: 'capacity', work, principal: null, state: 'done', detail, attempts: 1, epoch: null, cycle: 1, at: iso(at) });
interface Filed { at: string; kind?: string; subject: string; text: string; owner: string }
/** Cycles every 30–80 seconds over the queue `workAt` holds at each instant, acting on nothing but the actions given each cycle, as the loop measured the stretch; every attention line the measure files. */
function replay(workAt: (at: number) => Work[], until: string, perCycle: (at: number) => DaemonAction[] = () => [], fleetHeld?: boolean): { silence: ReturnType<typeof trackSilence>; filed: Filed[] } {
  const master = config(), state = daemonState(master);
  const filed: Filed[] = [];
  let silence = trackSilence(state, actionableSubjects(master, workAt(firstSeen), firstSeen, { fleetHeld }), perCycle(firstSeen), firstSeen);
  for (let at = firstSeen; at <= Date.parse(until); at += 30_000 + (at % 50_000)) {
    silence = trackSilence(state, actionableSubjects(master, workAt(at), at, { fleetHeld }), perCycle(at), at);
    state.lastCycleAt = iso(at);
    for (const line of loopAttention({ liveness: runningLiveness(state), silence })) filed.push({ at: iso(at), kind: line.kind, subject: line.subject, text: line.text, owner: 'next' in line ? String((line as { next?: string }).next ?? '') : '' });
  }
  return { silence, filed };
}
const firstFiling = (filed: Filed[], subject: string, kind: string) => filed.find(entry => entry.subject === subject && entry.kind === kind);
/** The filing an instance records: the subject, at the recorded instant within a cycle, with the subject count the line named. */
const instanceFiling = (filed: Filed[], subject: string, at: string, subjects: number) => filed.find(entry => entry.subject === subject && entry.kind === 'loop-silence'
  && Math.abs(Date.parse(entry.at) - Date.parse(at)) <= 2 * minute && entry.text.includes(`while ${subjects} subject(s) were actionable`));

// The queue as the production cursor's silence record showed it, with the dispatches that ended the
// waits left in: GY-1886 was dispatched at 08:32:08 (ten seconds after its instance filed) and
// GY-1888 at 08:56:30; GY-1889 stayed queued past the stretch.
const dispatched = { GY1886: Date.parse('2026-10-17T08:32:08.085Z'), GY1888: Date.parse('2026-10-17T08:56:30.170Z') };
const stretch = () => {
  const all = [item('GY-1886', '2026-10-17T08:10:58.270Z'), item('GY-1888', '2026-10-17T08:31:54.081Z'), item('GY-1889', '2026-10-17T08:34:00.351Z')];
  return (at: number) => all.filter(entry => entry.key === 'GY-1889' || at < dispatched[entry.key === 'GY-1886' ? 'GY1886' : 'GY1888']);
};
/** One instance's own window: the subjects the filing named, each entering the claimable queue at the since its record held. */
const instance = (...entries: [key: string, since: string][]) => {
  const all = entries.map(([key, since]) => ({ work: item(key, since), from: Date.parse(since) }));
  return (at: number) => all.filter(entry => at >= entry.from).map(entry => entry.work);
};

test('manual:fault-class-loop — GY-1890: each instance is reproduced against the base, where the measure without the fleet\u2019s answer files loop-silence with the instance\u2019s own wording', () => {
  // GY-1886 (08:31:58.270Z): 21 minutes, 2 subject(s) actionable.
  const gy1886 = instanceFiling(replay(instance(['GY-1886', '2026-10-17T08:10:58.270Z'], ['GY-1888', '2026-10-17T08:31:54.081Z']), '2026-10-17T08:33:58.270Z').filed, 'GY-1886', filedAt.GY1886, 2);
  assert.ok(gy1886, 'the base filed loop-silence on GY-1886 with the instance\u2019s idle and subject count');
  assert.match(gy1886!.text, /^Nothing has acted on GY-1886 is claimable and waiting for a worker for 2[01] minutes, past the 20-minute bound/);
  // GY-1888 (08:52:54.081Z): 21 minutes, 4 subject(s) actionable.
  const gy1888 = instanceFiling(replay(instance(['GY-1888', '2026-10-17T08:31:54.081Z'], ['GY-1889', '2026-10-17T08:34:00.351Z'], ['GY-1873', '2026-10-17T08:37:55.217Z'], ['GY-1875', '2026-10-17T08:45:00.000Z']), '2026-10-17T08:54:54.081Z').filed, 'GY-1888', filedAt.GY1888, 4);
  assert.ok(gy1888, 'the base filed loop-silence on GY-1888 with the instance\u2019s idle and subject count');
  assert.match(gy1888!.text, /^Nothing has acted on GY-1888 is claimable and waiting for a worker for 2[01] minutes, past the 20-minute bound/);
  // GY-1889 (08:54:09.296Z): 20 minutes, 3 subject(s) actionable (the item's own filing text; the
  // faults row's "42 minutes" is the standing text at its last sight, 09:16, not the filing's).
  const gy1889 = instanceFiling(replay(instance(['GY-1889', '2026-10-17T08:34:00.351Z'], ['GY-1873', '2026-10-17T08:37:55.217Z'], ['GY-1875', '2026-10-17T08:45:00.000Z']), '2026-10-17T08:56:09.296Z').filed, 'GY-1889', filedAt.GY1889, 3);
  assert.ok(gy1889, 'the base filed loop-silence on GY-1889 with the instance\u2019s idle and subject count');
  assert.match(gy1889!.text, /^Nothing has acted on GY-1889 is claimable and waiting for a worker for 2[01] minutes, past the 20-minute bound/);
});

test('manual:fault-class-loop — GY-1890: against the candidate no instance recurs: the saturated stretch files no loop-silence, and the wait is the capacity class\u2019s to carry', () => {
  // The launch step records the held fleet on the item it could not place, once per unchanged cause;
  // the replay performs that record on the first saturated cycle, as the step's detail-change guard does.
  const recorded = new Set<string>();
  const capacityRecord = (at: number): DaemonAction[] => stretch()(at).flatMap(entry => {
    if (recorded.has(entry.key)) return [];
    recorded.add(entry.key);
    return [capacityAction(null, at, `Every worker profile is held: ${entry.key} ${fleetHoldWording.held}`)];
  });
  // The stretch as production lived it, dispatches included, to 08:56:30: each queued item became
  // the longest wait in turn, and under the base each turn filed the loop class.
  const { silence, filed } = replay(stretch(), '2026-10-17T08:58:30.170Z', capacityRecord, true);
  assert.deepEqual(filed.filter(entry => entry.kind === 'loop-silence'), [], 'the loop class stays quiet through the whole stretch');
  // The waits did not vanish: each dispatched item filed as capacity on its way out, the still-queued
  // one remains a measured subject, and every subject worded so passes fleetHold.
  const starved = filed.filter(entry => entry.kind === 'concurrency-starved');
  const who = new Set(starved.map(entry => entry.subject));
  for (const key of ['GY-1886', 'GY-1888', 'GY-1889']) assert.ok(who.has(key), `${key} still breached past the bound, as capacity`);
  const queued = silence.subjects.find(entry => entry.work === 'GY-1889');
  assert.ok(queued, 'the still-queued item remains a measured subject');
  assert.equal(queued!.kind, 'capacity');
  assert.ok(queued!.detail.startsWith(`GY-1889 ${fleetHoldWording.held}`), 'the subject names the held fleet');
  assert.ok(fleetHold(queued!), 'fleetHold recognizes the subject');
  for (const entry of starved) {
    assert.match(entry.text, /^Nothing has acted on GY-\d+ is claimable but no worker profile is free/);
    assert.match(entry.owner, /fleet's size is the capacity decision/, 'the remedy names capacity, not the loop');
  }
  assert.equal(silence.breached, true, 'the bound itself is not weakened: the stretch still breaches');
});

test('manual:fault-class-loop — GY-1890: a claimable item with a free profile that nothing dispatches still breaches as the loop\u2019s silence', () => {
  const work = () => [item('GY-2000', '2026-10-17T08:10:58.270Z')];
  const { filed, silence } = replay(work, '2026-10-17T09:11:58.270Z', undefined, false);
  const line = firstFiling(filed, 'GY-2000', 'loop-silence');
  assert.ok(line, 'a dispatch wait the loop can act on is still the loop\u2019s silence');
  assert.match(line!.text, /^Nothing has acted on GY-2000 is claimable and waiting for a worker for 20 minutes, past the 20-minute bound/, 'the breach files the moment the bound is crossed');
  const last = filed.filter(entry => entry.subject === 'GY-2000' && entry.kind === 'loop-silence').at(-1);
  assert.match(last!.text, /for 6[01] minutes, past the 20-minute bound/, 'the wait keeps accumulating past the bound');
  assert.equal(silence.longest?.kind, 'dispatch', 'with a free profile the subject stays the loop\u2019s dispatch subject');
});

test('manual:fault-class-loop — GY-1890: a dispatch the loop attempted and lost does not reset the subject, so a failing launch still reaches the bound', () => {
  const master = config(), state = daemonState(master), work = [item('GY-2001', '2026-10-17T08:10:58.270Z')];
  const failed: DaemonAction[] = [{ kind: 'dispatch', work: 'GY-2001', principal: null, state: 'failed', detail: 'Dispatch of GY-2001 failed: the launch was refused', attempts: 3, epoch: 0, cycle: 1, at: iso(firstSeen) }];
  let silence = trackSilence(state, actionableSubjects(master, work, firstSeen, {}), [], firstSeen);
  for (let at = firstSeen + minute; at <= firstSeen + 25 * minute; at += minute) {
    silence = trackSilence(state, actionableSubjects(master, work, at, {}), failed, at);
  }
  assert.equal(silence.breached, true, 'only a successful action ends the wait; the failed launch files at the bound');
  assert.equal(silence.longest?.work, 'GY-2001');
});

test('manual:fault-class-loop — GY-1890: a cycle over a saturated fleet records the held fleet on the item it could not place, and measures the queue as capacity subjects', async () => {
  const master = masterConfigSchema.parse({ ...config(), workers: JSON.parse(JSON.stringify(workerFleet(2))) });
  const work = [item('GY-1886', '2026-10-17T08:10:58.270Z'), item('GY-1888', '2026-10-17T08:31:54.081Z'), item('GY-1889', '2026-10-17T08:34:00.351Z')];
  const agents: HerdrAgent[] = workerFleet(2).map(profile => ({ name: profile.agentName, pane_id: `pane-${profile.name}`, agent_status: 'working' }));
  const clock = firstSeen;
  const state = emptyDaemonState(master);
  state.lock = { pid: process.pid, host: 'machine-a', startedAt: iso(clock), heartbeatAt: iso(clock) } as DaemonState['lock'];
  const effects: DaemonEffects = {
    agents: () => agents,
    herdr: async () => ({ agents, available: true }),
    credentials: async () => ({}),
    snapshot: async () => ({ work, now: iso(clock) }),
    closeSession: () => {},
    dispatch: async () => {},
    requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(clock), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
  };
  const launcher = new Launcher();
  const result = await runCycle(master, state, effects, () => clock, launcher);
  await launcher.idle();
  const held = Object.entries(state.actions).filter(([key]) => key.startsWith('capacity:work-'));
  assert.equal(held.length, 1, 'the launch step stops at the first item it cannot place and records the held fleet once');
  const [key, action] = held[0];
  assert.equal(action.state, 'done', `${key} records the finding, not a failure`);
  assert.match(action.detail, /^Every worker profile is held/);
  assert.match(action.detail, /worker-0, worker-1/, 'the record names the held profiles, and no live reason that moves every cycle');
  assert.equal(action.work, null, 'the hold acts on no subject, so it never restarts the wait it found');
  // The measure the same cycle folds: the queue is capacity subjects worded so. One cycle cannot
  // breach the 20-minute bound, so the attention is empty of silence lines; a subject aged past the
  // bound files the capacity class, never the loop's.
  assert.deepEqual(result.silence.subjects.map(entry => entry.kind), ['capacity', 'capacity', 'capacity']);
  for (const subject of result.silence.subjects) assert.ok(fleetHold(subject), `${subject.work} is a fleet-hold subject`);
  assert.deepEqual(loopAttention({ liveness: runningLiveness(state), silence: result.silence }).filter(entry => entry.kind === 'loop-silence'), [], 'no loop fault for the saturated fleet');
  const aged = { ...result.silence, subjects: result.silence.subjects.map(entry => ({ ...entry, since: iso(clock - 45 * minute), idleMs: 45 * minute })), longestIdleMs: 45 * minute, breached: true };
  const breaches = loopAttention({ liveness: runningLiveness(state), silence: aged });
  assert.deepEqual(breaches.filter(entry => entry.kind === 'loop-silence'), [], 'an aged fleet hold still files no loop fault');
  assert.ok(breaches.some(entry => entry.kind === 'concurrency-starved'), 'the aged fleet hold files as the capacity class');
  const starved = breaches.find(entry => entry.kind === 'concurrency-starved')!;
  assert.match(starved.text, /is claimable but no worker profile is free/);
  assert.match(starved.next ?? '', /fleet's size is the capacity decision/, 'the remedy names capacity, not the loop');
});

test('manual:fault-class-loop — GY-1890: a fleet whose free profiles are all held by in-flight launches is saturated: the step records the hold and the measure counts the queue under capacity, not the loop\u2019s silence', async () => {
  const master = masterConfigSchema.parse({ ...config(), workers: JSON.parse(JSON.stringify(workerFleet(2))) });
  const work = [item('GY-1886', '2026-10-17T08:10:58.270Z'), item('GY-1888', '2026-10-17T08:31:54.081Z')];
  const agents: HerdrAgent[] = [];
  const clock = firstSeen;
  const state = emptyDaemonState(master);
  state.lock = { pid: process.pid, host: 'machine-a', startedAt: iso(clock), heartbeatAt: iso(clock) } as DaemonState['lock'];
  const effects: DaemonEffects = {
    agents: () => agents,
    herdr: async () => ({ agents, available: true }),
    credentials: async () => ({}),
    snapshot: async () => ({ work, now: iso(clock) }),
    closeSession: () => {},
    dispatch: async () => {},
    requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(clock), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
  };
  const launcher = new Launcher();
  // Both profiles are healthy and free in Herdr, but a launch holds each from hand-off until it
  // settles (GY-616), across cycles. The step must treat the fleet as saturated here — exactly the
  // production shape of GY-1886/1888/1889 — and the measure must follow the step's stop.
  let release!: () => void;
  const settled = new Promise<void>(resolve => { release = resolve; });
  launcher.submit('held:gy-1886', ['worker-0'], async () => { await settled; });
  launcher.submit('held:gy-1888', ['worker-1'], async () => { await settled; });
  const result = await runCycle(master, state, effects, () => clock, launcher);
  const held = Object.entries(state.actions).filter(([key]) => key.startsWith('capacity:work-'));
  assert.equal(held.length, 1, 'the step records the held fleet on the first item it cannot place');
  assert.match(held[0][1].detail, /worker-0, worker-1/, 'the record names the profiles the in-flight launches hold');
  assert.equal(held[0][1].work, null, 'the hold acts on no subject');
  assert.deepEqual(result.silence.subjects.map(entry => entry.kind), ['capacity', 'capacity'], 'the queue is measured as capacity subjects, not dispatch');
  assert.deepEqual(loopAttention({ liveness: runningLiveness(state), silence: result.silence }).filter(entry => entry.kind === 'loop-silence'), [], 'no loop fault while the fleet\u2019s free profiles are launches in flight');
  release();
  await launcher.idle();
});

test('manual:fault-class-loop — GY-1890: a profile free in the cycle-start snapshot but occupied in the launch step’s fresh inventory read is held: saturation follows the step’s own availability, so the queue is capacity, not an escalation', async () => {
  const master = masterConfigSchema.parse({ ...config(), workers: JSON.parse(JSON.stringify(workerFleet(2))) });
  const work = [item('GY-1886', '2026-10-17T08:10:58.270Z'), item('GY-1888', '2026-10-17T08:31:54.081Z')];
  const occupying: HerdrAgent[] = workerFleet(2).map(profile => ({ name: profile.agentName, pane_id: `pane-${profile.name}`, agent_status: 'working' }));
  const clock = firstSeen;
  const state = emptyDaemonState(master);
  state.lock = { pid: process.pid, host: 'machine-a', startedAt: iso(clock), heartbeatAt: iso(clock) } as DaemonState['lock'];
  // The cycle-start reads (observe, profile health) see an empty fleet, so every profile is healthy
  // and free there, and no launcher holds one. Only the dispatch step's own fresh read finds both
  // profiles' agents at work, as when an attempt starts between the snapshot and the launch step.
  const fresh = () => /dispatchStepWithin/.test(new Error().stack ?? '');
  const effects: DaemonEffects = {
    agents: () => fresh() ? occupying : [],
    herdr: async () => ({ agents: [], available: true }),
    credentials: async () => ({}),
    snapshot: async () => ({ work, now: iso(clock) }),
    closeSession: () => {},
    dispatch: async () => { throw new Error('no profile is free: nothing may launch'); },
    requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(clock), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
  };
  const launcher = new Launcher();
  const result = await runCycle(master, state, effects, () => clock, launcher);
  await launcher.idle();
  assert.equal(state.actions['escalation:dispatch:work-GY-1886'], undefined, 'an occupied fleet is capacity, never an escalation for a working credential');
  const held = Object.entries(state.actions).filter(([key]) => key.startsWith('capacity:work-'));
  assert.equal(held.length, 1, 'the step records the held fleet on the item it could not place');
  assert.match(held[0][1].detail, /worker-0, worker-1/);
  assert.deepEqual(result.silence.subjects.map(entry => entry.kind), ['capacity', 'capacity'], 'the measure follows the step’s fresh availability, not the snapshot');
});

test('manual:fault-class-loop — GY-1890: a continuous wait keeps its age when it is reclassed between dispatch and capacity, in both directions, so repeated saturation transitions still reach the bound', () => {
  const master = config(), state = daemonState(master), work = [item('GY-2003', '2026-10-17T08:10:58.270Z')];
  const filed: Filed[] = [];
  let silence = trackSilence(state, actionableSubjects(master, work, firstSeen, { fleetHeld: false }), [], firstSeen);
  // Nineteen minutes as a dispatch subject, then the fleet saturates and frees every four minutes.
  for (let at = firstSeen + minute; at <= firstSeen + 45 * minute; at += minute) {
    const elapsed = (at - firstSeen) / minute, fleetHeld = elapsed >= 19 && Math.floor((elapsed - 19) / 4) % 2 === 0;
    silence = trackSilence(state, actionableSubjects(master, work, at, { fleetHeld }), [], at);
    assert.equal(silence.subjects.length, 1, 'one subject, never a dispatch and a capacity copy side by side');
    assert.equal(silence.longest?.since, iso(firstSeen), `the wait still runs from its first sight at minute ${elapsed}`);
    assert.equal(silence.longest?.kind, fleetHeld ? 'capacity' : 'dispatch', 'the subject carries the class it is now');
    for (const line of loopAttention({ liveness: runningLiveness(state), silence })) filed.push({ at: iso(at), kind: line.kind, subject: line.subject, text: line.text, owner: '' });
  }
  // Minute 21 is saturated (19–22), minute 23 is not (23–26): each class files the moment its own
  // stretch stands past the bound on the one continuous wait.
  assert.equal(filed[0]?.at, iso(firstSeen + 21 * minute), 'the first breach files at the bound, not twenty minutes after the reclass');
  assert.equal(filed[0]?.kind, 'concurrency-starved');
  assert.ok(filed.some(entry => entry.kind === 'loop-silence' && entry.at === iso(firstSeen + 23 * minute)), 'reclassed back to dispatch, the wait files as the loop’s at once');
  assert.match(filed.at(-1)!.text, /for 45 minutes, past the 20-minute bound/);
  // A successful action for the subject still restarts it, under whichever class it now has.
  const restarted = trackSilence(state, actionableSubjects(master, work, firstSeen + 46 * minute, { fleetHeld: true }), [{ kind: 'capacity', work: 'GY-2003', principal: null, state: 'done', detail: 'acted', attempts: 1, epoch: null, cycle: 1, at: iso(firstSeen + 46 * minute) }], firstSeen + 46 * minute);
  assert.equal(restarted.longest?.since, iso(firstSeen + 46 * minute));
});

test('manual:fault-class-loop — GY-1890: an item whose own launch is in flight is not fleet-held: when a later item finds the fleet saturated, only that later item becomes a capacity wait, so a hung launch still breaches as the loop\u2019s, exactly as it does alone', () => {
  const master = config(), state = daemonState(master);
  const work = [item('GY-2004', '2026-10-17T08:10:58.270Z'), item('GY-2005', '2026-10-17T08:11:58.270Z')];
  const launching = (entry: Work) => entry.key === 'GY-2004';
  const filed: Filed[] = [];
  let silence = trackSilence(state, actionableSubjects(master, work, firstSeen, { fleetHeld: true, launching }), [], firstSeen);
  for (let at = firstSeen + minute; at <= firstSeen + 21 * minute; at += minute) {
    silence = trackSilence(state, actionableSubjects(master, work, at, { fleetHeld: true, launching }), [], at);
    assert.deepEqual(silence.subjects.map(entry => `${entry.work}:${entry.kind}`).sort(), ['GY-2004:dispatch', 'GY-2005:capacity'], 'the in-flight item waits on its own launch, the queued one on the fleet');
    for (const line of loopAttention({ liveness: runningLiveness(state), silence })) filed.push({ at: iso(at), kind: line.kind, subject: line.subject, text: line.text, owner: '' });
  }
  assert.ok(filed.length > 0 && filed.every(entry => entry.subject === 'GY-2004' && entry.kind === 'loop-silence'), 'the hung launch files as the loop\u2019s silence, never as concurrency-starved');
});

test('manual:fault-class-loop — GY-1890: a fleet that cannot launch at all is not a held fleet: the wait stays the loop\u2019s dispatch subject, escalates for a working credential, and breaches as loop-silence, never as capacity with a false remedy', async () => {
  const master = masterConfigSchema.parse({ ...config(), workers: JSON.parse(JSON.stringify(workerFleet(2))) });
  const work = [item('GY-2002', '2026-10-17T08:10:58.270Z')];
  const agents: HerdrAgent[] = [];
  const clock = firstSeen;
  const state = emptyDaemonState(master);
  state.lock = { pid: process.pid, host: 'machine-a', startedAt: iso(clock), heartbeatAt: iso(clock) } as DaemonState['lock'];
  // Every launch credential spent, and no profile busy: nothing could take work even if it were
  // free. Dispatch escalates for a working credential; that is not a fleet held by live attempts.
  const effects: DaemonEffects = {
    agents: () => agents,
    herdr: async () => ({ agents, available: true }),
    credentials: async () => Object.fromEntries(workerFleet(2).map(profile => [profile.name, { available: false, reason: 'launch credential is spent' }])),
    snapshot: async () => ({ work, now: iso(clock) }),
    closeSession: () => {},
    dispatch: async () => {},
    requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(clock), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
  };
  const result = await runCycle(master, state, effects, () => clock, new Launcher());
  assert.equal(Object.keys(state.actions).filter(key => key.startsWith('capacity:work-')).length, 0, 'an unlaunchable fleet is never recorded as a held fleet');
  assert.ok(state.actions['escalation:dispatch:work-GY-2002'], 'the step escalates: no profile could take work even free');
  assert.deepEqual(result.silence.subjects.map(entry => entry.kind), ['dispatch'], 'the claimable item stays the loop\u2019s dispatch subject');
  const aged = { ...result.silence, subjects: result.silence.subjects.map(entry => ({ ...entry, since: iso(clock - 45 * minute), idleMs: 45 * minute })), longestIdleMs: 45 * minute, breached: true };
  const breaches = loopAttention({ liveness: runningLiveness(state), silence: aged });
  assert.ok(breaches.some(entry => entry.kind === 'loop-silence'), 'a fleet that cannot launch at all files the loop\u2019s class, with the escalation as its remedy');
  assert.deepEqual(breaches.filter(entry => entry.kind === 'concurrency-starved'), [], 'and never the capacity class with the held-fleet remedy nothing backs');
});

test('manual:fault-class-loop — GY-1890 soak: two simulated hours over a saturated fleet record the hold a bounded number of times per item, and the held queue still breaches past the bound as concurrency-starved', async () => {
  const master = masterConfigSchema.parse({ ...config(), workers: JSON.parse(JSON.stringify(workerFleet(2))) });
  const work = [item('GY-1886', '2026-10-17T08:10:58.270Z'), item('GY-1888', '2026-10-17T08:31:54.081Z'), item('GY-1889', '2026-10-17T08:34:00.351Z')];
  // The fleet stays saturated the whole run: each profile's agent is present and at work, which is
  // capacity, not a breakdown. The agents' live status flips every cycle — the volatile signal the
  // record's detail used to carry, whose every move re-recorded the hold and restarted the wait.
  const agents: HerdrAgent[] = workerFleet(2).map(profile => ({ name: profile.agentName, pane_id: `pane-${profile.name}`, agent_status: 'working' }));
  let clock = firstSeen;
  const state = emptyDaemonState(master);
  state.lock = { pid: process.pid, host: 'machine-a', startedAt: iso(firstSeen), heartbeatAt: iso(firstSeen) } as DaemonState['lock'];
  const effects: DaemonEffects = {
    agents: () => agents,
    herdr: async () => ({ agents, available: true }),
    credentials: async () => ({}),
    snapshot: async () => {
      for (const agent of agents) agent.agent_status = agent.agent_status === 'working' ? 'blocked' : 'working';
      return { work, now: iso(clock) };
    },
    closeSession: () => {},
    dispatch: async () => {},
    requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(clock), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
  };
  const launcher = new Launcher();
  let last = await runCycle(master, state, effects, () => clock, launcher);
  for (let pass = 1; pass < 120; pass++) { clock += minute; last = await runCycle(master, state, effects, () => clock, launcher); }
  // (a) Bounded writes: once, though the fleet's live signals moved on every one of the 120 cycles.
  const held = Object.entries(state.actions).filter(([key]) => key.startsWith('capacity:work-'));
  assert.equal(held.length, 1, 'the step stops at the head of the queue; the hold is that item\u2019s record');
  const [heldKey, heldAction] = held[0];
  assert.equal(heldAction.attempts, 1, `${heldKey} is written once over 120 cycles of churning agent status`);
  assert.equal(heldAction.work, null, 'the hold acts on no subject, so nothing restarts the wait it found');
  // (b) The held item still breaches past the bound, as capacity: its clock ran the whole time.
  assert.ok(last.silence.breached, `the queue breaches past the bound (longest ${last.silence.longestIdleMs}ms)`);
  assert.equal(last.silence.longest?.kind, 'capacity', 'the longest wait is a capacity subject');
  assert.ok(fleetHold(last.silence.longest!), 'the breach is a fleet hold');
  const attention = loopAttention({ liveness: runningLiveness(state), silence: last.silence });
  assert.deepEqual(attention.filter(entry => entry.kind === 'loop-silence'), [], 'the loop class stays quiet through two simulated hours of saturation');
  const starved = attention.find(entry => entry.kind === 'concurrency-starved');
  assert.ok(starved, 'the held wait files as the capacity class');
  assert.match(starved!.text, /^Nothing has acted on GY-\d+ is claimable but no worker profile is free/);
  assert.match(starved!.text, /for 1\d\d minutes, past the 20-minute bound/, 'two simulated hours of saturation reach the bound');
  assert.match(starved!.next ?? '', /fleet's size is the capacity decision/, 'the remedy names capacity, not the loop');
});

test('manual:fault-class-loop — GY-1890: the silence bound is unchanged, and only the fleet-hold wording reclasses a subject', () => {
  assert.equal(silenceBudgetMs, 1_200_000, 'the 20-minute bound stands');
  assert.equal(fleetHold({ kind: 'dispatch', detail: `GY-1 ${fleetHoldWording.held}` }), false, 'a dispatch-kind subject never reclasses');
  assert.equal(fleetHold({ kind: 'capacity', detail: 'GY-1 is claimable and waiting for a worker' }), false, 'a capacity subject without the wording does not');
});
