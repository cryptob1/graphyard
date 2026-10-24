import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { daemonSummary } from '../src/daemon/run.js';
import { masterSummary } from '../src/daemon/state.js';
import { masterProfile } from '../src/master/master-session.js';
import { recordObservedExhaustion, heldAwareProbe } from '../src/master/environments.js';
import { selectFleetSession, type FleetClient, type FleetSelection } from '../src/fleet.js';
import { chooseSession, emptyRegistry, proposedRuntimes, unobservedQuota, type AgentRegistry, type FleetSession } from '../src/model/registry.js';
import { foldObservations } from '../src/model/registry-sessions.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-2949: a master session that stops on its runtime's usage or session limit used to sit adopted
 * for the rest of the window — Herdr showed a live pane, so the loop's masterSession step kept it and
 * launched nothing, while blockers only a master decides waited. The pane is now judged like a
 * worker's: a limit notice holds the account until the notice's reset, closes the pane, and launches
 * the role's next account in the same cycle.
 */

const HOST = 'machine-a';
const clock = Date.parse('2026-10-24T07:00:00Z'); // 00:00 in America/Los_Angeles (PDT, UTC-7)
const iso = (at: number) => new Date(at).toISOString();
const MASTER = 'graphyard-master-project';
const limitScreen = `✻ You've hit your session limit · resets 1:30am (America/Los_Angeles)`;
// The next 1:30am in the zone the notice names, read the way the notice's reader reads it.
const nextHalfOneLA = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });

async function config(): Promise<MasterConfig> {
  const directory = await temporaryDirectory('master-limit');
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: `${directory}/coordinator.token`, cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: HOST, masterAgentName: MASTER, workers: [] });
}

/** The control plane's registry, in memory: a master role on claude-c and codex, concurrency 1, with the live session the spent pane runs under. */
function registryFixture() {
  let registry: AgentRegistry = emptyRegistry();
  const session = (id: string, account: string, runtime: string): FleetSession => ({ id, role: 'master', account, runtime, model: 'opus', host: HOST, work: null, principal: MASTER,
    selectedAt: iso(clock - 3_600_000), selectedBy: 'coordinator', reason: 'recorded', skipped: [], endedAt: null, endReason: null });
  const client: FleetClient = {
    document: async () => structuredClone(registry),
    select: async request => {
      // The control plane folds what the executor observed into the registry before it chooses (as the server does), so a held account reads exhausted here too.
      foldObservations(registry, { host: request.host, observations: request.observations }, { actor: 'executor', at: iso(clock) });
      const choice = chooseSession(registry, request, clock);
      if (!choice.account) return { selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.revision } satisfies FleetSelection;
      const added = session(`session-${choice.account.name}`, choice.account.name, choice.runtime.name);
      registry.sessions.push(added);
      return { selected: true, reason: choice.reason, skipped: choice.skipped, session: added, account: choice.account, runtime: choice.runtime, model: choice.model, revision: registry.revision };
    },
    end: async (id, reason) => { const ended = registry.sessions.find(entry => entry.id === id && !entry.endedAt); if (ended) { ended.endedAt = iso(clock); ended.endReason = reason.slice(0, 500); } },
  };
  const apply = (accounts: { name: string; runtime: string }[]) => {
    registry = structuredClone({ ...registry, runtimes: proposedRuntimes.filter(runtime => accounts.some(account => account.runtime === runtime.name)),
      models: [{ name: 'opus', id: null }], accounts: accounts.map(account => ({ name: account.name, runtime: account.runtime, model: 'opus', enabled: true, credential: { host: HOST, home: null }, quota: { ...unobservedQuota } })),
      roles: [{ name: 'master', accounts: accounts.map(account => account.name), concurrency: 1, policy: {} }], revision: registry.revision + 1, updatedAt: iso(clock) } as AgentRegistry);
  };
  apply([{ name: 'claude-c', runtime: 'claude' }, { name: 'codex', runtime: 'codex' }]);
  registry.sessions.push(session('session-claude-c', 'claude-c', 'claude'));
  return { client, live: () => registry.sessions.filter(entry => !entry.endedAt).map(entry => entry.account) };
}

interface Fixture {
  closed: string[]; launched: { handover: string }[]; exhausted: { account: string; reason: string; resetsAt: string | null }[]; ended: { session: string; reason: string }[];
  screen: string | null; launchError: Error | null; persisted: DaemonState | null;
}
const fixture = (): Fixture => ({ closed: [], launched: [], exhausted: [], ended: [], screen: null, launchError: null, persisted: null });

/** The loop's effects with a fixture Herdr showing the master pane, and the launch driven by the real account selection against the fixture registry. */
async function effectsFor(config: MasterConfig, agents: { name?: string; pane_id?: string; agent_status?: string }[], observed: Fixture, registry: ReturnType<typeof registryFixture>): Promise<DaemonEffects> {
  return {
    snapshot: async () => ({ work: [], now: iso(clock) }),
    agents: () => agents, herdr: () => ({ agents, available: true }),
    credentials: async () => ({}),
    closeSession: pane => { observed.closed.push(pane); },
    dispatch: async () => { throw new Error('no worker dispatch in this test'); },
    sessionScreen: async ({ pane }) => observed.screen !== null && pane === agents[0]?.pane_id ? observed.screen : null,
    masterSession: {
      launch: async handover => {
        if (observed.launchError) throw observed.launchError;
        observed.launched.push({ handover });
        const selected = (await selectFleetSession(config, 'master', { name: masterProfile }, await heldAwareProbe(config, { registry: registry.client, now: () => clock, runtime: { agents: [], available: true } })))!;
        return { agentName: MASTER, pane: 'pN', runtime: selected.account.kind, account: selected.account.name, session: selected.account.fleet.session };
      },
      // The production hold, on the fixture's own environment log beside the fixture credential file.
      exhaust: async (account, notice) => {
        observed.exhausted.push({ account, reason: notice.reason, resetsAt: notice.resetsAt });
        await recordObservedExhaustion(config, account, { at: iso(clock), reason: notice.reason, resetsAt: notice.resetsAt, role: 'master', profile: masterProfile, work: null }, clock);
      },
      end: async (session, reason) => { observed.ended.push({ session, reason }); await registry.client.end(session, reason); },
    },
    persist: async state => { observed.persisted = structuredClone(state); },
  };
}

test('unit:master-session-limit-fails-over — a master pane showing its provider\'s session limit is treated as absent: the account is held until the next 1:30 local time, the pane closes, and the role\'s next account launches in the same cycle', async () => {
  const master = await config(), registry = registryFixture(), observed = fixture();
  observed.screen = limitScreen;
  const agents = [{ name: MASTER, pane_id: 'pM', agent_status: 'working' }];
  const state = emptyDaemonState(master);
  state.master = { ...state.master, agentName: MASTER, pane: 'pM', runtime: 'claude', account: 'claude-c', session: 'session-claude-c', startedAt: iso(clock - 3_600_000) };
  await runCycle(master, state, await effectsFor(master, agents, observed, registry), () => clock);

  assert.deepEqual(observed.exhausted, [{ account: 'claude-c', reason: 'You\'ve hit your session limit · resets 1:30am (America/Los_Angeles)', resetsAt: iso(Date.parse('2026-10-24T08:30:00Z')) }],
    'the account is marked exhausted with the reset the notice names: the next 1:30am local time');
  const [, , , hour, minute] = nextHalfOneLA.formatToParts(new Date(observed.exhausted[0]!.resetsAt!)).filter(part => part.type !== 'literal').map(part => Number(part.value));
  assert.equal(`${hour}:${minute}`, '1:30', 'the reset is a 1:30 wall clock in the notice\'s zone');
  assert.ok(Date.parse(observed.exhausted[0]!.resetsAt!) > clock, 'the reset stands after the notice');
  assert.deepEqual(observed.closed, ['pM'], 'the pane is closed');
  assert.deepEqual(observed.ended, [{ session: 'session-claude-c', reason: 'the master session it recorded is gone from Herdr; the loop launches its replacement' }], 'the registry session the pane ran under is ended, freeing the role\'s one slot');
  assert.equal(observed.launched.length, 1, 'the master launches in the same cycle');
  assert.match(observed.launched[0]!.handover, /continue from node \/bin\/graphyard master status/, 'the launch carries the handover');
  assert.deepEqual(registry.live(), ['codex'], 'the registry now counts only the next account\'s session');
  assert.equal(state.master.account, 'codex', 'the launch took the role\'s next account: the spent one was held');
  assert.equal(state.master.session, 'session-codex');
  assert.equal(state.master.limitedUntil, null, 'the replacement session clears the hold');
  assert.equal(state.master.lastEnd, null, 'the replacement session starts fresh');
  assert.equal(masterSummary(state.master, clock).state, 'working');
  const failover = state.actions['master:failover'];
  assert.equal(failover?.state, 'done');
  assert.match(failover!.detail, /treated as absent/);
  assert.ok(observed.persisted, 'the cursor is persisted');
});

test('unit:master-session-limit-fails-over — a pane with ordinary output is adopted as today: no hold, no close, no launch', async () => {
  const master = await config(), registry = registryFixture(), observed = fixture();
  observed.screen = `● The master loop is cycling: GY-75's blocker is parked, next cycle dispatches GY-80.`;
  const agents = [{ name: MASTER, pane_id: 'pM', agent_status: 'working' }];
  const state = emptyDaemonState(master);
  await runCycle(master, state, await effectsFor(master, agents, observed, registry), () => clock);

  assert.deepEqual(observed.exhausted, [], 'no account is held');
  assert.deepEqual(observed.closed, [], 'the pane stays open');
  assert.deepEqual(observed.launched, [], 'no second master is launched');
  assert.equal(state.master.adopted, true, 'the live session is adopted as today');
  assert.equal(state.master.pane, 'pM');
  assert.equal(masterSummary(state.master, clock).state, 'working');
});

test('unit:master-status-shows-master-session-state — master status reads the session limited until the hold\'s instant while it stands, and absent once the pane is closed and the hold has lapsed', async () => {
  const master = await config(), registry = registryFixture(), observed = fixture();
  observed.screen = limitScreen;
  observed.launchError = new Error('No healthy agent account for master profile master: claude-c quota is exhausted until 2026-10-24T08:30:00.000Z; codex quota is exhausted');
  const agents = [{ name: MASTER, pane_id: 'pM', agent_status: 'working' }];
  const state = emptyDaemonState(master);
  state.master = { ...state.master, agentName: MASTER, pane: 'pM', runtime: 'claude', account: 'claude-c', session: 'session-claude-c', startedAt: iso(clock - 3_600_000) };
  await runCycle(master, state, await effectsFor(master, agents, observed, registry), () => clock);

  assert.deepEqual(observed.closed, ['pM'], 'the pane is closed');
  assert.deepEqual(state.master.lastEnd, { cause: 'exhausted', at: iso(clock), detail: 'its pane showed its provider\'s limit notice: You\'ve hit your session limit · resets 1:30am (America/Los_Angeles)' });
  assert.equal(state.master.agentName, null, 'no session is live');
  const resetsAt = state.master.limitedUntil!;
  assert.ok(resetsAt);
  // The page's line: `master status` embeds the daemon summary's master reading (the loop's own `masterSession` field reads the same function).
  assert.equal(daemonSummary(state, clock, 60_000, HOST).master.state, `limited until ${resetsAt}`, 'while the hold stands, the master session reads limited until the reset');
  // An idle pane before any failover reads idle, not working.
  assert.equal(masterSummary({ ...state.master, agentName: MASTER, pane: 'pM' }, clock, { agent_status: 'idle' }).state, 'idle');
  // Once the hold has lapsed with the pane still closed, the session reads absent.
  assert.equal(daemonSummary(state, Date.parse(resetsAt) + 60_000, 60_000, HOST).master.state, 'absent');
  assert.equal(masterSummary(state.master, Date.parse(resetsAt) + 60_000).state, 'absent');
});
