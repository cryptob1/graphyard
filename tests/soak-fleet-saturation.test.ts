import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';
import { masterConfigSchema, workerProfileSchema, type HerdrAgent, type MasterConfig } from '../src/master.js';
import { fleetHold, fleetHoldWording, silenceBudgetMs } from '../src/daemon/metrics.js';
import { loopAttention } from '../src/daemon/liveness.js';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { Launcher } from '../src/daemon/cycle.js';
import { systemInvariants } from '../src/model/invariants.js';

/**
 * GY-1890: a saturated worker fleet over simulated days of the real loop. The silence measure's
 * reclassing of a claimable item between the loop's `dispatch` subject and the fleet's `capacity`
 * subject repeats per cycle and per item, so it lives in a soak suite: `runCycle` with one
 * `Launcher` carried across its cycles, as `runDaemon` does, over a world whose two worker profiles
 * take queued items, work them for varying stretches and finish, so the fleet's occupancy changes
 * all day. Twice a day every launch credential is spent for a while: the fleet cannot launch at
 * all, the queue's waits are the loop's (dispatch subjects, escalated for a working credential),
 * and when the credentials return to a fleet that fills at once the same waits become capacity
 * subjects; credentials spent over a busy fleet reclass them back as attempts finish. Across every
 * transition each queued item's wait runs from the first cycle that saw it claimable, the held
 * fleet is recorded a bounded number of times, a silence breach files `concurrency-starved` while
 * the fleet is held and `loop-silence` only while it cannot launch, and every system invariant
 * (docs/master-agent.md#system-invariants) holds after every cycle.
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

test('unit:soak-invariants-hold — GY-1890: two simulated days over a fleet that saturates, drains and loses its credentials keep each queued item’s wait age across every dispatch/capacity reclass, record the held fleet a bounded number of times, file concurrency-starved while the fleet is held and loop-silence only while it cannot launch, and every system invariant holds', { timeout: 600_000 }, async () => {
  const days = 2, master = config(), state: DaemonState = emptyDaemonState(master);
  state.lock = { pid: process.pid, host: 'machine-a', startedAt: iso(dayStart), heartbeatAt: iso(dayStart) } as DaemonState['lock'];
  const sim = world(days), launcher = new Launcher();
  const firstClaimable = new Map<string, string>();
  const violations: string[] = [], reclassed = new Set<string>(), kinds = new Map<string, string>();
  const filed = { starved: 0, loop: 0, starvedSubjects: new Set<string>() };
  for (let at = dayStart; at < dayStart + days * day; at += minute) {
    sim.advance(at);
    // What the cycle's snapshot shows claimable: the queue whose wait ages the measure must keep.
    for (const entry of sim.items) if (entry.stage !== 'done' && !entry.lease && !firstClaimable.has(entry.key)) firstClaimable.set(entry.key, iso(at));
    const busy = sim.attempts.size, spent = spentAt(at);
    const result = await runCycle(master, state, sim.effects, sim.now, launcher);
    await launcher.idle();
    const into = `+${Math.round((at - dayStart) / minute)} min`;
    // Every system invariant, after every cycle.
    if (state.invariants.report.length !== systemInvariants.length) violations.push(`${into}: ${state.invariants.report.length} invariants judged`);
    for (const check of state.invariants.report.filter(entry => !entry.holds)) violations.push(`${into}: ${check.line}`);
    for (const subject of result.silence.subjects.filter(entry => entry.kind === 'dispatch' || entry.kind === 'capacity')) {
      const work = subject.work!;
      // The wait runs from the first cycle that saw the item claimable, whatever class it holds now.
      if (subject.since !== firstClaimable.get(work)) violations.push(`${into}: ${work}'s ${subject.kind} wait runs from ${subject.since}, not ${firstClaimable.get(work)}`);
      if (kinds.has(work) && kinds.get(work) !== subject.kind) reclassed.add(`${work} ${kinds.get(work)}→${subject.kind}`);
      kinds.set(work, subject.kind);
      // A fleet whose profiles all run attempts holds the queue as capacity; one that cannot launch leaves it the loop's.
      if (busy === profiles.length && !spent && subject.kind !== 'capacity') violations.push(`${into}: ${work} is a ${subject.kind} subject while every profile runs an attempt`);
      if (busy === 0 && spent && subject.kind !== 'dispatch') violations.push(`${into}: ${work} is a ${subject.kind} subject while no profile can launch`);
      if (subject.kind === 'capacity' && !fleetHold(subject)) violations.push(`${into}: ${work}'s capacity subject lacks the fleet-hold wording`);
    }
    for (const line of loopAttention({ liveness: { state: 'running', detail: '', lagMs: 1, stalledAfterMs: 600_000, cycle: 1, lock: state.lock, restart: '', cost: null }, silence: result.silence })) {
      if (line.kind === 'concurrency-starved') { filed.starved++; filed.starvedSubjects.add(line.subject); }
      if (line.kind === 'loop-silence') { filed.loop++; if (busy === profiles.length && !spent) violations.push(`${into}: loop-silence filed on ${line.subject} while every profile runs an attempt: ${line.text}`); }
    }
    if (result.silence.subjects.length >= 20) violations.push(`${into}: the queue outgrew the measure's 20-subject report`);
  }
  assert.deepEqual(violations, [], 'every invariant, wait age and fault class holds across two simulated days');
  // The day really exercised what it claims: both reclass directions, held queues past the bound, and outage breaches.
  assert.ok([...reclassed].some(entry => entry.endsWith('dispatch→capacity')), `a queued wait was reclassed from dispatch to capacity: ${[...reclassed].join(', ')}`);
  assert.ok([...reclassed].some(entry => entry.endsWith('capacity→dispatch')), `and from capacity back to dispatch: ${[...reclassed].join(', ')}`);
  assert.ok(filed.starved > 0, 'a held queue breached past the bound as concurrency-starved');
  assert.ok(filed.loop > 0, 'a fleet that could not launch for longer than the bound filed the loop’s silence');
  assert.equal(silenceBudgetMs, 20 * minute, 'the bound is unchanged');
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
  assert.ok(fleetHoldWording.held.length > 0);
});
