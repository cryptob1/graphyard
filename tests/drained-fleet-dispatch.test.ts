import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as master from '../src/master.js';
import { dispatchReserved, dispatchWork, masterConfigSchema, setupMaster, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { profileHealth } from '../src/daemon/sessions.js';
import * as failures from '../src/daemon/dispatch-failures.js';
import { dispatchFailureBlockAfter, dispatchFailureBlocker, noteDispatchFailure } from '../src/daemon/dispatch-failures.js';
import { classifyBlocker, environmentalBlockerClasses } from '../src/model/blocker-class.js';
import { workerSlotWait } from '../src/model/action-kinds.js';
import { controlPlaneHandlers } from '../src/executor.js';
import type { ActionRow } from '../src/model/actions.js';
import type { Work } from '../src/model.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1322: once every worker session had finished, each launch profile's name was still held by a
// Herdr session reporting idle or done, profileHealth read every profile as unlaunchable, and both
// dispatchers refused every item ("No worker profile can take …") until a person closed the panes.
// A finished session no live assignment owns now frees its profile: the dispatch closes it, bounded,
// and launches as on a profile with no agent. Fleet-idle refusals never count toward a dispatch-
// failure blocker, and a dispatch-failure blocker clears once a profile can take a launch again.

// Reached through their modules, so this file loads on a base without them and each case fails on its own.
const reclaimableAgent = (...args: Parameters<typeof master.reclaimableAgent>): boolean => master.reclaimableAgent(...args);
const fleetIdleCause: typeof failures.fleetIdleCause = cause => failures.fleetIdleCause(cause);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const workerToken = 'worker-token-'.padEnd(40, 'x');
const observedAt = '2030-01-01T12:00:00.000Z';
const clock = Date.parse(observedAt);

function work(key: string, overrides: Partial<Work> = {}): Work {
  const at = new Date(clock - 3_600_000).toISOString();
  return {
    id: `id-${key}`, key, title: key, description: '', type: 'bug', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:x'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'build', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at,
    ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [], containmentQuarantine: null, ...overrides,
  } as Work;
}
const profile = (name: string, credentialFile = `/srv/credentials/${name}.token`): WorkerProfile =>
  ({ name, principal: `${name}-principal`, agentName: `agent-${name}`, mode: 'launch', kind: 'codex', credentialFile, agentArgs: [], approvals: 'auto', environment: {} } as WorkerProfile);
const fleet = ['one', 'two', 'three', 'four'].map(name => profile(name));
/** The drained fleet of 2026-10-05: every profile's name held by a finished session, half idle and half done. */
const drained = (): HerdrAgent[] => fleet.map((entry, index) => ({ name: entry.agentName, pane_id: `pane-${entry.name}`, agent: 'codex', agent_status: index % 2 ? 'done' : 'idle' }));
const available = (profiles: WorkerProfile[]) => Object.fromEntries(profiles.map(entry => [entry.name, { available: true, reason: null }]));
const liveLease = (owner: string) => ({ owner, epoch: 1, expiresAt: new Date(clock + 60_000).toISOString() }) as Work['lease'];

function config(workers: WorkerProfile[], overrides: Record<string, unknown> = {}): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/srv/graphyard/coordinator.token', cliPath: '/srv/graphyard/bin/graphyard.mjs',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'coordinator-host', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers, ...overrides });
}
const health = (agents: HerdrAgent[], items: Work[] = []) => profileHealth(fleet, available(fleet), agents, emptyDaemonState(config(fleet)), clock, items);

/** A Herdr whose closed panes leave its agent list, so a closed finished session frees its name. */
function fakeHerdr(agents: HerdrAgent[]) {
  const calls: string[][] = [], closed: string[] = [];
  let panes = 0;
  const run = (_command: string, args: string[]) => {
    calls.push(args);
    const json = (result: unknown) => JSON.stringify({ result });
    if (args[0] === 'tab' && args[1] === 'create') { const pane = `pane-new-${++panes}`; return json({ type: 'tab_created', root_pane: { pane_id: pane, tab_id: `tab-${panes}` }, tab: { tab_id: `tab-${panes}` } }); }
    if (args[0] === 'agent' && args[1] === 'list') return json({ agents: agents.map(agent => ({ ...agent })) });
    if (args[0] === 'agent' && args[1] === 'rename') {
      if (agents.some(agent => agent.name === args[3])) throw Object.assign(new Error(`herdr: {"code":"agent_name_taken","message":"agent name ${args[3]} is taken"}`), { herdrCode: 'agent_name_taken' });
      agents.push({ name: args[3], pane_id: args[2], agent: 'codex', agent_status: 'working' });
    }
    if (args[0] === 'pane' && args[1] === 'close') { closed.push(args[2]); agents.splice(0, agents.length, ...agents.filter(agent => agent.pane_id !== args[2])); return json({}); }
    if (args[0] === 'pane' && args[1] === 'list') return json({ panes: agents.map(agent => ({ pane_id: agent.pane_id })) });
    return startedAtOnce(args) ?? json({});
  };
  return { run, calls, closed, agents };
}
function fakeClaims(root: string) {
  const claims = new Map<string, string>();
  const prepare = async (_root: string, key: string, name: string) => { claims.set(key, name); return { epoch: 1, path: join(root, `assigned-${key}`), base: 'c'.repeat(40) }; };
  return { claims, prepare, release: async (_root: string, key: string) => { claims.delete(key); } };
}
async function installation() {
  const root = await temporaryDirectory('drained-fleet'), credentials = await temporaryDirectory('drained-fleet-credentials');
  execFileSync('git', ['init', '-q', root]); execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const credential = join(credentials, 'worker.token'); await writeFile(credential, workerToken, { mode: 0o600 });
  await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials }, (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
  return { root, credential, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); } };
}

test('unit:idle-agent-profile-dispatchable — a profile whose name a finished, unowned session holds is healthy, and the dispatch closes that session and launches over it', async () => {
  // At the seam both dispatchers read: idle and done sessions no live lease owns free their profiles.
  assert.deepEqual(health(drained()).map(entry => [entry.healthy, entry.busy, entry.reason]), fleet.map(() => [true, false, null]));
  // A working session, or a finished one whose principal still holds a live lease, keeps its profile busy.
  const working = health([{ name: 'agent-one', pane_id: 'pane-one', agent_status: 'working' }]);
  assert.deepEqual([working[0].healthy, working[0].busy], [false, true]);
  const owned = health(drained(), [work('GY-7', { lease: liveLease('one-principal') })]);
  assert.deepEqual([owned[0].healthy, owned[0].busy], [false, true], 'a finished session under a live lease is not reclaimed');
  assert.deepEqual(owned.slice(1).map(entry => entry.healthy), [true, true, true]);
  // A lease of another principal whose session records this pane owns it too; blocked, unknown and paneless sessions are never reclaimed.
  assert.equal(reclaimableAgent(fleet[0], drained()[0], [work('GY-8', { lease: liveLease('other'), sessions: [{ pane: 'pane-one' }] as Work['sessions'] })], clock), false);
  for (const agent of [{ name: 'agent-one', pane_id: 'pane-one', agent_status: 'blocked' }, { name: 'agent-one', pane_id: 'pane-one' }, { name: 'agent-one', agent_status: 'idle' }])
    assert.equal(reclaimableAgent(fleet[0], agent, [], clock), false, JSON.stringify(agent));
  assert.equal(reclaimableAgent(fleet[0], drained()[0], [work('GY-9', { lease: { ...liveLease('one-principal')!, expiresAt: new Date(clock - 1).toISOString() } })], clock), true, 'a lapsed lease owns nothing');

  // dispatchWork itself: the finished session's pane is closed under the reservation and the launch goes on.
  const fixture = await installation();
  try {
    const one = profile('one', fixture.credential);
    const herdr = fakeHerdr([{ name: 'agent-one', pane_id: 'pane-old', agent: 'codex', agent_status: 'idle' }]), claims = fakeClaims(fixture.root);
    const now = new Date().toISOString(), ended = work('GY-1', { stage: 'done', epoch: 1 }), next = work('GY-2');
    const result = await dispatchWork(fixture.root, next, one, herdr.agents.map(agent => ({ ...agent })), herdr.run, [ended, next], claims.prepare, claims.release, 1, now) as { closedAgent?: string };
    assert.deepEqual(herdr.closed, ['pane-old'], 'the finished session was closed');
    assert.match(result.closedAgent ?? '', /agent-one \(idle, pane pane-old\)/);
    assert.deepEqual([...claims.claims.keys()], ['GY-2'], 'and the item was claimed and launched');
    assert.ok(herdr.agents.some(agent => agent.name === 'agent-one' && agent.pane_id !== 'pane-old'), 'the profile name now belongs to the new session');

    // The same session under a live lease is refused cleanly, before any claim, and left open.
    const held = fakeHerdr([{ name: 'agent-one', pane_id: 'pane-held', agent: 'codex', agent_status: 'idle' }]), heldClaims = fakeClaims(fixture.root);
    const owner = work('GY-3', { lease: { owner: 'one-principal', epoch: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() } as Work['lease'] });
    const refused = await dispatchWork(fixture.root, work('GY-4'), one, held.agents.map(agent => ({ ...agent })), held.run, [owner, work('GY-4')], heldClaims.prepare, heldClaims.release, 1, new Date().toISOString()).then(() => null, error => error);
    assert.ok(dispatchReserved(refused), `refused as a held profile: ${refused?.message}`);
    assert.deepEqual([held.closed, heldClaims.claims.size], [[], 0]);

    // A launch this host made after the snapshot was read (GY-2 at epoch 1, shown here at epoch 0) is never closed on that snapshot's word.
    herdr.agents.forEach(agent => { agent.agent_status = 'idle'; });
    const stale = await dispatchWork(fixture.root, work('GY-5'), one, herdr.agents.map(agent => ({ ...agent })), herdr.run, [work('GY-2'), work('GY-5')], claims.prepare, claims.release, 1, new Date().toISOString()).then(() => null, error => error);
    assert.ok(dispatchReserved(stale), `refused on a stale snapshot: ${stale?.message}`);
    assert.deepEqual(herdr.closed, ['pane-old'], 'the fresh launch was not closed');
  } finally { await fixture.cleanup(); }
});

test('unit:dispatch-succeeds-on-drained-fleet — with every profile held by a finished session, the loop and an executor both dispatch the ready priority-1 item', async () => {
  const items = [work('GY-1309', { stage: 'done', epoch: 2 }), work('GY-1310', { priority: 1 })];
  // The loop: one tick dispatches, and records no "No worker profile can take" escalation.
  const dispatched: string[] = [];
  const effects: DaemonEffects = {
    agents: async () => drained(), herdr: () => ({ agents: drained(), available: true }), stopSupervisor: () => {},
    credentials: async configured => available(configured), snapshot: async () => ({ work: items, now: observedAt }),
    closeSession: () => {}, dispatch: async (item, chosen) => { dispatched.push(`${item.key}:${chosen.name}`); return {}; },
    requestProof: () => {}, recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: observedAt, reason: 'not configured', deployed: [], pending: [] }),
  };
  const state: DaemonState = emptyDaemonState(config(fleet));
  await runCycle(config(fleet), state, effects, () => clock);
  assert.deepEqual(dispatched, ['GY-1310:one'], 'the drained fleet takes the ready item');
  assert.deepEqual(Object.values(state.actions).filter(action => /No worker profile can take/.test(action.detail ?? '')), []);

  // The executor's dispatch handler, from the same snapshot.
  const launched: string[] = [];
  const handlers = controlPlaneHandlers(() => config(fleet), {
    snapshot: async () => ({ work: items, now: observedAt }), mutate: async () => ({}), agents: async () => drained(),
    workerCredentials: async list => available(list), producerCredentials: async () => ({}),
    dispatchWorker: async (item, chosen) => { launched.push(`${item.key}:${chosen.name}`); return {}; },
    launchReview: async () => ({}), launchProducer: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: observedAt, reason: 'not configured', deployed: [], pending: [] }) as any,
  });
  const row = { id: 'row-1', kind: 'dispatch', work: 'id-GY-1310', key: 'GY-1310', inputs: { kind: 'dispatch', target: 'implementation', epoch: 0, priority: 1, plannedFiles: [] } } as unknown as ActionRow;
  assert.match(String(await handlers.dispatch!(row, { id: 'executor-1', host: 'coordinator-host' })), /dispatched GY-1310 to one/);
  assert.deepEqual(launched, ['GY-1310:one']);

  // The refusal still fires when no profile is genuinely launchable.
  const working = drained().map(agent => ({ ...agent, agent_status: 'working' }));
  const refuse = controlPlaneHandlers(() => config(fleet), {
    snapshot: async () => ({ work: items, now: observedAt }), mutate: async () => ({}), agents: async () => working,
    workerCredentials: async list => available(list), producerCredentials: async () => ({}), dispatchWorker: async () => ({}),
    launchReview: async () => ({}), launchProducer: async () => ({}), observeDeployment: async () => ({}) as any,
  }).dispatch!;
  await assert.rejects(async () => refuse(row, { id: 'executor-1', host: 'coordinator-host' }), /no worker profile can take GY-1310: one \(Herdr agent agent-one is working\)/);
});

test('unit:dispatch-blocker-clears-on-fleet-recovery — fleet-idle failures never reach the bound, and a dispatch-failure blocker clears once a profile can launch', async () => {
  // No blocker accumulates while the sole cause is the fleet: across spent epochs the count stays at zero.
  const counted: DaemonState = emptyDaemonState(config(fleet));
  const idle = 'no worker profile can take GY-1310: one (Herdr agent agent-one is idle); two (Herdr agent agent-two is done)';
  for (const epoch of [0, 1, 2, 3, 4]) assert.equal(noteDispatchFailure(counted, { id: 'id-GY-1310', key: 'GY-1310', epoch }, idle, observedAt).count, 0);
  assert.deepEqual(counted.dispatchFailures, {}, 'no run is kept, so the bound is never reached');
  for (const cause of [idle, 'Launch profile agent name agent-one is already visible in Herdr; pick another profile', 'Herdr agent agent-one is idle with no live assignment, and its bounded close failed: timeout'])
    assert.ok(fleetIdleCause(cause), cause);
  // An item's own cause still counts and still blocks.
  const own = 'fatal: a branch named graphyard/gy-1310-1 already exists';
  let run = noteDispatchFailure(counted, { id: 'id-GY-1310', key: 'GY-1310', epoch: 0 }, own, observedAt);
  for (const epoch of [1, 2]) run = noteDispatchFailure(counted, { id: 'id-GY-1310', key: 'GY-1310', epoch }, own, observedAt);
  assert.equal(run.count, dispatchFailureBlockAfter);

  // A recorded dispatch-failure blocker is its own environmental class, whatever its cause quotes.
  const blocker = `${dispatchFailureBlocker({ ...run, cause: `${idle} HTTP 502 Permission denied` })} [attempts 1, 2, 3 each ended without a submission]`;
  assert.equal(classifyBlocker(blocker).class, 'dispatch-failure');
  assert.ok(environmentalBlockerClasses.includes('dispatch-failure'));
  // An item's own cause is not the fleet's: no launchable profile resolves it, so it stays for the operator (GY-1078).
  assert.notEqual(classifyBlocker(dispatchFailureBlocker(run)).class, 'dispatch-failure');

  // The loop's blocker step probes it from this cycle's Herdr: failing while the fleet is busy, passing once a profile can launch.
  const probes: { result: string; detail: string }[] = [];
  let agents: HerdrAgent[] = drained().map(agent => ({ ...agent, agent_status: 'working' }));
  const blocked = work('GY-1310', { blocker, epoch: 3 });
  const effects: DaemonEffects = {
    agents: async () => agents, herdr: () => ({ agents, available: true }), stopSupervisor: () => {},
    credentials: async configured => available(configured), snapshot: async () => ({ work: [blocked], now: observedAt }),
    closeSession: () => {}, dispatch: async () => ({}), requestProof: () => {}, recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    recordBlockerProbe: async (item, probe) => { probes.push(probe); return item; },
    observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: observedAt, reason: 'not configured', deployed: [], pending: [] }),
  };
  const state = emptyDaemonState(config(fleet));
  await runCycle(config(fleet), state, effects, () => clock);
  assert.equal(probes.at(-1)?.result, 'fail', 'no profile can take a launch while every session works');
  assert.match(probes.at(-1)!.detail, /one \(Herdr agent agent-one is working\)/);
  agents = drained();
  await runCycle(config(fleet), state, effects, () => clock + 20_000);
  assert.deepEqual([probes.at(-1)?.result, probes.at(-1)?.detail], ['pass', 'profile one is launchable'], 'the fleet drained into launchable profiles, so the blocker clears without graphyard unblock');
  assert.ok(Object.values(state.actions).some(action => /Cleared GY-1310's dispatch-failure blocker/.test(action.detail ?? '')));
});

test('unit:dispatch-refusal-names-agent-remedy — the per-profile reason names the agent state and, for a finished session, the remedy', async () => {
  const [reason] = health(drained(), [work('GY-1308', { lease: liveLease('one-principal') })]).map(entry => entry.reason);
  assert.equal(reason, "Herdr agent agent-one is idle under GY-1308's live lease; remedy: bounded close or relaunch once that lease ends, or herdr pane close pane-one on the host");
  const paneless = profileHealth([fleet[0]], available(fleet), [{ name: 'agent-one', agent_status: 'done' }], emptyDaemonState(config(fleet)), clock, [])[0].reason;
  assert.equal(paneless, 'Herdr agent agent-one is done with no pane to close; remedy: relaunch the session or restart Herdr on the host');
  assert.equal(health([{ name: 'agent-one', pane_id: 'p', agent_status: 'working' }])[0].reason, 'Herdr agent agent-one is working');
  // The refusal line lists each reason in parentheses, and still reads as a wait for a slot.
  const refusal = `no worker profile can take GY-1310: one (${reason})`;
  assert.doesNotMatch(reason!, /[()]/);
  assert.equal(workerSlotWait(refusal), true);

  // A failed bounded close names the agent, its state and the host action.
  const fixture = await installation();
  try {
    const one = profile('one', fixture.credential);
    const herdr = fakeHerdr([{ name: 'agent-one', pane_id: 'pane-stuck', agent: 'codex', agent_status: 'done' }]), claims = fakeClaims(fixture.root);
    const failed = await dispatchWork(fixture.root, work('GY-2'), one, herdr.agents.map(agent => ({ ...agent })), herdr.run, [work('GY-2')], claims.prepare, claims.release, 1, new Date().toISOString(),
      { closePane: async () => { throw new Error('Herdr still reports pane pane-stuck after close'); } }).then(() => null, error => error as Error);
    assert.match(failed?.message ?? '', /^Herdr agent agent-one is done with no live assignment, and its bounded close failed: Herdr still reports pane pane-stuck after close; remedy: close pane pane-stuck on the host \(herdr pane close pane-stuck\) or relaunch Herdr$/);
    assert.ok(fleetIdleCause(failed!.message), 'and it never counts toward a dispatch-failure blocker');
    assert.equal(claims.claims.size, 0, 'nothing was claimed');
  } finally { await fixture.cleanup(); }
});
