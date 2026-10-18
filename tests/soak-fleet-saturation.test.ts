import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';
import { masterConfigSchema, workerProfileSchema, type HerdrAgent, type MasterConfig } from '../src/master.js';
import { actionableSubjects } from '../src/daemon/metrics.js';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { Launcher } from '../src/daemon/cycle.js';
import { systemInvariants } from '../src/model/invariants.js';

/**
 * GY-1890: a saturated worker fleet over simulated days of the real loop. The classification of a
 * claimable item between the loop's `dispatch` subject and the fleet's `capacity` subject repeats
 * per cycle and per item, so it lives in a soak suite: `runCycle` with one `Launcher` carried
 * across its cycles, as `runDaemon` does, over a world whose two worker profiles take queued items,
 * work them for varying stretches and finish, so the fleet's occupancy changes all day. Twice a day
 * every launch credential is spent for a while: the fleet cannot launch at all, the queue's waits
 * are the loop's (dispatch subjects, escalated for a working credential), and when the credentials
 * return to a fleet that fills at once the same waits become capacity subjects; credentials spent
 * over a busy fleet reclass them back as attempts finish. Across every transition the held fleet is
 * recorded a bounded number of times, the master session's wake reads the subject kind the step's
 * own stop decided, and every system invariant (docs/master-agent.md#system-invariants) holds after
 * every cycle. (GY-1980 removed the silence measure these subjects used to feed; the kinds now feed
 * the master wake, and stillness is the progress watchdog's judgement.)
 */

const minute = 60_000, hour = 60 * minute, day = 24 * hour;
const dayStart = Date.parse('2026-10-17T00:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();
const releaseEveryMs = 30 * minute;
const workMs = (n: number) => (45 + (n * 17) % 40) * minute;
/** The windows, per simulated day, in which every launch credential is spent. */
const outages = [{ from: 6 * hour, to: 6 * hour + 40 * minute }, { from: 18 * hour, to: 18 * hour + 35 * minute }];
const spentAt = (at: number) => outages.some(window => (at - dayStart) % day >= window.from && (at - dayStart) % day < window.to);

const profiles = ['one', 'two'].map(name => workerProfileSchema.parse({ name: `worker-${name}`, principal: `graphyard-worker-${name}`, agentName: `graphyard-worker-${name}`, mode: 'launch', kind: 'claude', credentialFile: '/outside/worker.token' }));
function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: JSON.parse(JSON.stringify(profiles)), run: { proofWorkflow: 'acceptance.yml' } });
}
const gate = (name: string, passed: boolean, reason = '') => ({ name, passed, reasons: passed ? [] : [reason] });
function item(n: number, released: number): Work {
  const key = `GY-${3000 + n}`;
  return {
    id: `work-${key}`, key, title: `Item ${key}`, description: '', type: 'bug', priority: 1, dependencies: [], criteria: [],
    policy: { checks: ['test'], review: true }, plannedFiles: [`src/item-${n}.ts`], stage: 'build', revision: 1, policyRevision: 1,
    createdAt: iso(released - 30 * minute), updatedAt: iso(released), stageEnteredAt: iso(released),
    ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [gate('ready', false, `${key} is ready and unassigned: no worker holds it`)], violations: [],
  } as unknown as Work;
}

/** The world: released items, the attempt each profile runs, and what the measure must agree with. */
function world(days: number) {
  let clock = dayStart;
  const items: Work[] = [], attempts = new Map<string, { item: Work; profile: string; endsAt: number }>(), agents: HerdrAgent[] = [];
  let released = 0;
  const advance = (to: number) => {
    clock = to;
    while (released * releaseEveryMs <= clock - dayStart && released < days * day / releaseEveryMs) items.push(item(released + 1, dayStart + released++ * releaseEveryMs));
    for (const [name, attempt] of attempts) {
      if (attempt.endsAt > clock) { attempt.item.lease = { ...attempt.item.lease!, expiresAt: iso(clock + hour) }; continue; }
      Object.assign(attempt.item, { stage: 'done', lease: null, updatedAt: iso(clock), gates: [] });
      attempts.delete(name);
      agents.splice(agents.findIndex(agent => agent.name === profiles.find(profile => profile.name === name)!.agentName), 1);
    }
  };
  const effects: DaemonEffects = {
    agents: () => agents.map(agent => ({ ...agent })),
    herdr: async () => ({ agents: agents.map(agent => ({ ...agent })), available: true }),
    credentials: async () => spentAt(clock) ? Object.fromEntries(profiles.map(profile => [profile.name, { available: false, reason: 'launch credential is spent' }])) : {},
    snapshot: async () => ({ work: items.map(entry => structuredClone(entry)), now: iso(clock) }),
    closeSession: () => {},
    dispatch: async (work, profile) => {
      const live = items.find(entry => entry.id === work.id)!;
      assert.ok(!attempts.has(profile.name), `${profile.name} was dispatched while its attempt on ${attempts.get(profile.name)?.item.key} runs`);
      Object.assign(live, { epoch: live.epoch + 1, lease: { epoch: live.epoch + 1, owner: profile.principal, expiresAt: iso(clock + hour) }, updatedAt: iso(clock),
        gates: [gate('ready', true), gate('build', false, 'Worker has not submitted implementation for this attempt')] });
      attempts.set(profile.name, { item: live, profile: profile.name, endsAt: clock + workMs(Number(live.key.slice(3)) - 3000) });
      agents.push({ name: profile.agentName, pane_id: `pane-${profile.name}-${live.key}`, agent_status: 'working' });
      return { pane: `pane-${profile.name}-${live.key}`, agentName: profile.agentName, principal: profile.principal, epoch: live.epoch };
    },
    requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(clock), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
  };
  return { effects, advance, now: () => clock, items, attempts };
}

test('unit:soak-invariants-hold — GY-1890: two simulated days over a fleet that saturates, drains and loses its credentials keep every subject the class its step’s own stop decided, record the held fleet a bounded number of times, and every system invariant holds', { timeout: 600_000 }, async () => {
  const days = 2, master = config(), state: DaemonState = emptyDaemonState(master);
  state.lock = { pid: process.pid, host: 'machine-a', startedAt: iso(dayStart), heartbeatAt: iso(dayStart) } as DaemonState['lock'];
  const sim = world(days), launcher = new Launcher();
  const violations: string[] = [], reclassed = new Set<string>(), kinds = new Map<string, string>();
  for (let at = dayStart; at < dayStart + days * day; at += minute) {
    sim.advance(at);
    const busy = sim.attempts.size, spent = spentAt(at);
    await runCycle(master, state, sim.effects, sim.now, launcher);
    await launcher.idle();
    const into = `+${Math.round((at - dayStart) / minute)} min`;
    // Every system invariant, after every cycle.
    if (state.invariants.report.length !== systemInvariants.length) violations.push(`${into}: ${state.invariants.report.length} invariants judged`);
    for (const check of state.invariants.report.filter(entry => !entry.holds)) violations.push(`${into}: ${check.line}`);
    // The subjects the wake reads, under the step's own stop: a fleet whose profiles all run
    // attempts holds the queue as capacity (the step's saturated-fleet stop); one that cannot
    // launch at all is not a held fleet, and the queue stays the loop's dispatch subjects.
    const fleetHeld = busy === profiles.length && !spent;
    for (const subject of actionableSubjects(master, sim.items.filter(entry => entry.stage !== 'done'), at, { fleetHeld })) {
      const work = subject.work!;
      if (subject.kind !== 'dispatch' && subject.kind !== 'capacity') continue;
      if (kinds.has(work) && kinds.get(work) !== subject.kind) reclassed.add(`${work} ${kinds.get(work)}→${subject.kind}`);
      kinds.set(work, subject.kind);
      if (busy === profiles.length && !spent && subject.kind !== 'capacity') violations.push(`${into}: ${work} is a ${subject.kind} subject while every profile runs an attempt`);
      if (busy === 0 && spent && subject.kind !== 'dispatch') violations.push(`${into}: ${work} is a ${subject.kind} subject while no profile can launch`);
      if (subject.kind === 'capacity' && !subject.detail.includes('no worker profile is free')) violations.push(`${into}: ${work}'s capacity subject lacks the fleet-hold wording`);
    }
  }
  assert.deepEqual(violations, [], 'every invariant, subject kind and wording holds across two simulated days');
  // The day really exercised what it claims: both reclass directions happened.
  assert.ok([...reclassed].some(entry => entry.endsWith('dispatch→capacity')), `a queued wait was reclassed from dispatch to capacity: ${[...reclassed].join(', ')}`);
  assert.ok([...reclassed].some(entry => entry.endsWith('capacity→dispatch')), `and from capacity back to dispatch: ${[...reclassed].join(', ')}`);
  // Bounded capacity records: one per held item at most, each written once (its detail names no moving signal).
  const held = Object.entries(state.actions).filter(([key]) => key.startsWith('capacity:work-'));
  assert.ok(held.length > 0, 'the step recorded the held fleet');
  assert.ok(held.length <= sim.items.length, `${held.length} capacity records for ${sim.items.length} items`);
  for (const [key, action] of held) {
    assert.equal(action.attempts, 1, `${key} was written once`);
    assert.equal(action.work, null, `${key} acts on no subject`);
    assert.ok(action.detail.includes('worker-one, worker-two'), `${key} names the held profiles`);
  }
  assert.ok(sim.items.filter(entry => entry.stage === 'done').length >= sim.items.length - 12, 'the fleet kept delivering through the days');
});
