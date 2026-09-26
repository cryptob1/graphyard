import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetRoleHealth, reconcileFleetSessions, selectFleetSession, type FleetClient, type FleetSelection } from '../src/fleet.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { approverSessionName, masterConfigSchema, type HerdrAgent, type MasterConfig } from '../src/master.js';
import type { Observation, Work } from '../src/model.js';
import { applyRegistryMutation, chooseSession, emptyRegistry, liveSessions, proposedRuntimes, supersededByRequest, type AgentRegistry, type FleetSession } from '../src/model/registry.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-190: on 2026-09-24 a rework approver could not launch because the approver role was "at its
 * concurrency limit (7 of 7 live)" while none of those seven approvers was running: each had judged
 * its decision and exited, and nothing ended the registry session it had been launched on. A
 * registry session now ends with the session it records, the role counts only sessions that run,
 * and a launch refused for the role's capacity waits for a slot instead of being spent.
 */

const HOST = 'machine-a';
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const minute = 60_000;
const reviewed = 'a'.repeat(40), base = 'b'.repeat(40);
const decisionId = '5d8a8b9e-0000-4000-8000-000000000190';
const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

async function config(): Promise<MasterConfig> {
  const directory = await temporaryDirectory('fleet-sessions'); directories.push(directory);
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(directory, 'coordinator.token'), cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: HOST, masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [] });
}

/**
 * The control plane's registry, in memory: selection supersedes, counts and chooses exactly as the
 * server does (the same pure functions), and `end` records the end with its reason.
 */
function memoryRegistry(concurrency: number) {
  let registry: AgentRegistry = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [proposedRuntimes.find(runtime => runtime.name === 'claude')!], models: [{ name: 'opus', id: null }],
    accounts: [{ name: 'claude-b', runtime: 'claude', model: 'opus', credential: { host: HOST, home: null } }],
    roles: [{ name: 'approver', accounts: ['claude-b'], concurrency }], reason: 'fixture',
  }, { actor: 'operator', at: iso(-60 * minute) }).registry;
  let time = clock;
  const record = (work: string, selectedAt: string): FleetSession => {
    const session: FleetSession = { id: randomUUID(), role: 'approver', account: 'claude-b', runtime: 'claude', model: 'opus', host: HOST, work, principal: 'approver-agent',
      selectedAt, selectedBy: 'coordinator', reason: 'recorded', skipped: [], endedAt: null, endReason: null };
    registry.sessions.push(session);
    return session;
  };
  const client: FleetClient = {
    document: async () => structuredClone(registry),
    select: async request => {
      const at = new Date(time).toISOString();
      for (const superseded of supersededByRequest(registry, request)) Object.assign(superseded, { endedAt: at, endReason: 'superseded' });
      const choice = chooseSession(registry, request, time);
      if (!choice.account) return { selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.revision } satisfies FleetSelection;
      const session = record(request.work!, at);
      return { selected: true, reason: choice.reason, skipped: choice.skipped, session, account: choice.account, runtime: choice.runtime, model: choice.model, revision: registry.revision };
    },
    end: async (id, reason) => { const session = registry.sessions.find(entry => entry.id === id); if (session && !session.endedAt) Object.assign(session, { endedAt: new Date(time).toISOString(), endReason: reason }); },
  };
  return { client, record, at: (now: number) => { time = now; }, live: () => liveSessions(registry).filter(session => session.role === 'approver'), all: () => registry.sessions };
}

/** A submitted item whose fresh observation carries a changes-requested review: the loop asks an approver for its rework. */
function verdictItem(key: string, observedAt: string): Work {
  const observation = {
    clockOffset: { min: 0, max: 0 }, candidate: { sha: reviewed, baseSha: base, pr: 42, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'independent-reviewer', sha: reviewed, state: 'CHANGES_REQUESTED' }],
    protected: true, mergeable: true, merged: false, mergeSha: null, files: ['src/loop.ts'], scopeFiles: [], at: observedAt,
  } as Observation;
  return {
    id: `work-${key}`, key, title: 'Rework through the registry', description: '', type: 'bug', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:loop'] }], policy: { checks: ['test'], review: true },
    plannedFiles: ['src/loop.ts'], stage: 'review', revision: 5, policyRevision: 1, createdAt: iso(-4 * 60 * minute), updatedAt: iso(0),
    stageEnteredAt: iso(-30 * minute), ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: 42 },
    candidate: { sha: reviewed, baseSha: base, pr: 42, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation, blocker: null, violations: [],
    gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }],
  } as Work;
}

/**
 * A loop wired to the in-memory registry: its approver launches through `selectFleetSession` against
 * what Herdr lists, and a launched approver appears in Herdr; its reconciliation is the real one.
 */
function wiring(cfg: MasterConfig, fleet: ReturnType<typeof memoryRegistry>, herdr: HerdrAgent[], decision: () => { state: string } | null, now: () => number) {
  const launched: { work: string; decision: string; account: string }[] = [];
  const effects: DaemonEffects = {
    agents: () => herdr, herdr: () => ({ agents: [...herdr], available: true }),
    credentials: async () => ({}),
    snapshot: async () => ({ work: [verdictItem('GY-42', new Date(now() - 30_000).toISOString())], now: new Date(now()).toISOString(), jobs: [] }),
    closeSession: pane => { const at = herdr.findIndex(agent => agent.pane_id === pane); if (at >= 0) herdr.splice(at, 1); },
    dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(now()).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async () => ({ id: decisionId }),
    decisions: async () => { const judged = decision(); return { decisions: judged ? [{ id: decisionId, action: 'rework', state: judged.state, input: {}, approvedBy: judged.state === 'applied' ? 'approver-agent' : null }] : [] }; },
    approver: async (work, id) => {
      fleet.at(now());
      const name = approverSessionName(work, id);
      const selected = (await selectFleetSession(cfg, 'approver', { name, principal: 'approver-agent' }, { registry: fleet.client, work: work.key, runtime: { agents: [...herdr], available: true }, now }))!;
      herdr.push({ name, pane_id: `pane-${herdr.length + 1}`, agent_status: 'working' } as HerdrAgent);
      launched.push({ work: work.key, decision: id, account: selected.account.name });
      return { agentName: name, pane: `pane-${herdr.length}`, session: selected.account.fleet.session };
    },
    reconcileSessions: (runtime, finished) => { fleet.at(now()); return reconcileFleetSessions(cfg, runtime, finished, { registry: fleet.client, now }); },
    persist: async () => {},
  };
  return { effects, launched };
}

test('unit:registry-session-ends-with-session — the loop ends the registry session of an approver whose decision is judged and whose Herdr session is gone, and one whose runtime session is gone, each with its reason; the role\'s live count drops', async () => {
  const cfg = await config(), fleet = memoryRegistry(7), herdr: HerdrAgent[] = [];
  // An approver launched earlier for another item, by hand, whose session has since exited.
  const orphan = fleet.record('GY-7', iso(-10 * minute));
  let decision: { state: string } | null = null, time = clock;
  const { effects, launched } = wiring(cfg, fleet, herdr, () => decision, () => time);
  herdr.push({ name: approverSessionName({ key: 'GY-7' }, 'c'.repeat(8)), pane_id: 'pane-gy-7', agent_status: 'working' } as HerdrAgent);

  // Cycle 1: the verdict is decided on and its approver launched through the registry.
  const state = emptyDaemonState(cfg);
  await runCycle(cfg, state, effects, () => time);
  assert.deepEqual(launched.map(entry => entry.work), ['GY-42'], 'the approver is launched through the registry');
  const watch = Object.values(state.approvals)[0];
  assert.ok(watch.session, 'the watch keeps the registry session the approver runs on');
  assert.equal(fleet.live().length, 2, 'both approver sessions are live while both run');

  // The approver judges its decision and exits; the hand-launched one is gone from Herdr too.
  decision = { state: 'applied' };
  herdr.length = 0;
  time = clock + 2 * minute;
  const cycle = await runCycle(cfg, state, effects, () => time);
  const ended = fleet.all().find(session => session.id === watch.session || session.work === 'GY-42')!;
  assert.ok(ended.endedAt, 'the judged approver\'s registry session is ended');
  assert.equal(ended.endReason, `approver decision ${decisionId} on GY-42 is judged`);
  const gone = fleet.all().find(session => session.id === orphan.id)!;
  assert.ok(gone.endedAt, 'the registry session whose runtime session is gone is ended');
  assert.match(gone.endReason!, /approver session for GY-7 is gone from Herdr on machine-a/);
  assert.equal(fleet.live().length, 0, 'the role\'s live count drops to the sessions that run');
  assert.ok(cycle.actions.some(action => action.kind === 'close' && action.detail.includes(`Ended the approver registry session ${ended.id}`) && /is judged/.test(action.detail)), 'the cycle records the end and why');
  const health = await fleetRoleHealth(cfg, 'approver', { registry: fleet.client, now: () => time });
  assert.equal(health?.available, true, 'the role is available again');

  // A registry session selected moments ago is left alone: its launch may still be making the tab.
  const fresh = fleet.record('GY-8', new Date(time).toISOString());
  await runCycle(cfg, state, effects, () => time);
  assert.equal(fleet.all().find(session => session.id === fresh.id)!.endedAt, null, 'a session inside its launch grace is not ended');
});

test('unit:concurrency-counts-live-only — with 7 recorded approver sessions and none running, the role is available and a launch selects an account', async () => {
  const cfg = await config(), fleet = memoryRegistry(7);
  const works = ['GY-1', 'GY-2', 'GY-3', 'GY-4', 'GY-5', 'GY-6', 'GY-7'];
  for (const key of works) fleet.record(key, iso(-10 * minute));
  fleet.at(clock);
  const probe = { registry: fleet.client, now: () => clock };
  const none = { agents: [] as HerdrAgent[], available: true };

  // What the registry records alone reads the role as full; what runs says otherwise.
  assert.match((await fleetRoleHealth(cfg, 'approver', probe))!.reason!, /at its concurrency limit \(7 of 7 live\)/);
  const health = await fleetRoleHealth(cfg, 'approver', { ...probe, runtime: none });
  assert.equal(health?.available, true, 'no session runs, so the role is available');
  assert.equal(health?.reason, null);
  // Sessions that do run still count, and an unreadable Herdr proves nothing gone.
  const running = { agents: works.map(key => ({ name: approverSessionName({ key }, 'e'.repeat(8)) }) as HerdrAgent), available: true };
  assert.equal((await fleetRoleHealth(cfg, 'approver', { ...probe, runtime: running }))?.available, false, 'seven running approvers fill the role');
  assert.equal((await fleetRoleHealth(cfg, 'approver', { ...probe, runtime: { agents: [], available: false } }))?.available, false, 'an unreadable inventory does not free a slot');

  const selected = await selectFleetSession(cfg, 'approver', { name: 'graphyard-approver-gy-9-abcdef12', principal: 'approver-agent' }, { ...probe, work: 'GY-9', runtime: none });
  assert.equal(selected?.account.name, 'claude-b', 'a launch selects an account');
  assert.deepEqual(fleet.live().map(session => session.work), ['GY-9'], 'the seven sessions that no longer run were ended before the choice');
  assert.ok(fleet.all().filter(session => works.includes(session.work!)).every(session => /is gone from Herdr/.test(session.endReason ?? '')), 'each with the reason it ended');
});

test('unit:capacity-refusal-retried — an approver launch refused for the role\'s capacity stays pending and is launched on the first cycle after a slot frees', async () => {
  const cfg = await config(), fleet = memoryRegistry(1), herdr: HerdrAgent[] = [];
  // The approver role is full: one approver, for another item, is running.
  const busy = fleet.record('GY-9', iso(-10 * minute));
  herdr.push({ name: approverSessionName({ key: 'GY-9' }, 'd'.repeat(8)), pane_id: 'pane-gy-9', agent_status: 'working' } as HerdrAgent);
  let time = clock;
  const { effects, launched } = wiring(cfg, fleet, herdr, () => ({ state: 'requested' }), () => time);

  // Cycle 1: the decision is requested, and its approver launch refused for capacity.
  const state = emptyDaemonState(cfg);
  const first = await runCycle(cfg, state, effects, () => time);
  assert.deepEqual(launched, [], 'no approver launches while the role is full');
  const watch = Object.values(state.approvals)[0];
  assert.equal(watch.decision, decisionId, 'the decision is requested and watched');
  assert.equal(watch.launches, 0, 'a refusal for capacity is not counted against the decision\'s launch bound');
  assert.equal(watch.agentName, null);
  assert.match(watch.capacity!, /role approver is at its concurrency limit \(1 of 1 live/);
  assert.ok(first.actions.some(action => action.kind === 'decision' && /pending for an approver slot/.test(action.detail)), 'the cycle says the launch waits for a slot');

  // Still full: the next cycle tries again and it stays pending, with no escalation.
  time = clock + minute;
  await runCycle(cfg, state, effects, () => time);
  assert.deepEqual(launched, []);
  assert.equal(watch.exhaustedAt, null, 'waiting for a slot never exhausts the decision');

  // The running approver exits, which frees the slot; the next cycle launches for the decision.
  herdr.splice(0, herdr.length);
  time = clock + 2 * minute;
  await runCycle(cfg, state, effects, () => time);
  assert.deepEqual(launched, [{ work: 'GY-42', decision: decisionId, account: 'claude-b' }], 'the approver is launched for that decision without a person');
  assert.equal(watch.capacity, null);
  assert.equal(watch.launches, 1);
  assert.equal(watch.agentName, approverSessionName({ key: 'GY-42' }, decisionId));
  assert.ok(fleet.all().find(session => session.id === busy.id)!.endedAt, 'the session that exited was ended');
  assert.deepEqual(fleet.live().map(session => session.work), ['GY-42']);
});
