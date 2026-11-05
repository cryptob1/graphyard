import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { selectFleetSession, type FleetClient, type FleetSelection } from '../src/fleet.js';
import { masterProfile } from '../src/master/master-session.js';
import { heldAwareProbe } from '../src/master/environments.js';
import { chooseSession, emptyRegistry, proposedRuntimes, unobservedQuota, type AgentRegistry, type FleetSession } from '../src/model/registry.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-3091: on 2026-11-04 the master pane closed on a provider limit, but a master-role registry
 * session the loop's state did not name stayed live, so every launch was refused at the role's
 * concurrency of 1 for 2.5 hours. The loop now ends every live master session of its host before a
 * launch while Herdr lists no master pane, and a failed end is a failed action, retried.
 */

const HOST = 'machine-a', MASTER = 'graphyard-master-project';
const clock = Date.parse('2026-11-05T02:00:00Z');
const iso = (at: number) => new Date(at).toISOString();

async function config(): Promise<MasterConfig> {
  const directory = await temporaryDirectory('master-orphan');
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: `${directory}/coordinator.token`, cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: HOST, masterAgentName: MASTER, workers: [] });
}

/** A master role on one codex account, concurrency 1, with the orphaned session holding its slot. */
function registryFixture() {
  const session = (id: string, selectedAt: number): FleetSession => ({ id, role: 'master', account: 'codex', runtime: 'codex', model: 'gpt', host: HOST, work: null, principal: MASTER,
    selectedAt: iso(selectedAt), selectedBy: 'coordinator', reason: 'recorded', skipped: [], endedAt: null, endReason: null });
  const registry: AgentRegistry = { ...emptyRegistry(), revision: 1, runtimes: proposedRuntimes.filter(runtime => runtime.name === 'codex'), models: [{ name: 'gpt', id: null }],
    accounts: [{ name: 'codex', runtime: 'codex', model: 'gpt', enabled: true, credential: { host: HOST, home: null }, quota: { ...unobservedQuota } }],
    roles: [{ name: 'master', accounts: ['codex'], concurrency: 1, policy: {} }], sessions: [session('orphan-4e18', clock - 9 * 3_600_000)] } as AgentRegistry;
  let failEnd: string | null = null;
  const client: FleetClient = {
    document: async () => structuredClone(registry),
    select: async request => {
      const choice = chooseSession(registry, request, clock);
      if (!choice.account) return { selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.revision } satisfies FleetSelection;
      const added = session(`session-${registry.sessions.length}`, clock);
      registry.sessions.push(added);
      return { selected: true, reason: choice.reason, skipped: choice.skipped, session: added, account: choice.account, runtime: choice.runtime, model: choice.model, revision: registry.revision };
    },
    end: async (id, reason) => {
      if (failEnd) throw new Error(failEnd);
      const ended = registry.sessions.find(entry => entry.id === id && !entry.endedAt);
      if (ended) { ended.endedAt = iso(clock); ended.endReason = reason; }
    },
  };
  return { client, registry, failing: (error: string | null) => { failEnd = error; }, live: () => registry.sessions.filter(entry => !entry.endedAt).map(entry => entry.id) };
}

/** The loop's effects with the production session listing and end over the fixture registry, and the real role selection behind the launch. */
function effectsFor(master: MasterConfig, registry: ReturnType<typeof registryFixture>, herdr: { agents: { name?: string; pane_id?: string; agent_status?: string }[]; available: boolean }) {
  const launched: string[] = [], ended: { session: string; reason: string }[] = [];
  const effects: DaemonEffects = {
    snapshot: async () => ({ work: [], now: iso(clock) }),
    agents: () => herdr.agents, herdr: () => herdr,
    credentials: async () => ({}),
    closeSession: () => undefined,
    dispatch: async () => { throw new Error('no worker dispatch in this test'); },
    masterSession: {
      launch: async () => {
        const selected = (await selectFleetSession(master, 'master', { name: masterProfile }, await heldAwareProbe(master, { registry: registry.client, now: () => clock, runtime: { agents: [], available: true } })))!;
        launched.push(selected.account.fleet.session);
        return { agentName: MASTER, pane: 'pNew', runtime: selected.account.kind, account: selected.account.name, session: selected.account.fleet.session };
      },
      end: async (session, reason) => { ended.push({ session, reason }); await registry.client.end(session, reason); },
      // Imported when called, so the test fails as a test case on a base that lacks the listing.
      live: async () => (await import('../src/master/registry-slot.js')).liveMasterSessions(master, registry.client),
    },
    persist: async () => undefined,
  };
  return { effects, launched, ended };
}

test('e2e:master-orphan-slot-released — a live master session the loop does not name, with no Herdr pane, is ended and the master launches', async () => {
  const master = await config(), registry = registryFixture();
  const { effects, launched, ended } = effectsFor(master, registry, { agents: [{ name: 'graphyard-claude-1', pane_id: 'p21A', agent_status: 'working' }], available: true });
  const state = emptyDaemonState(master);
  // The loop's own record names an older session, already gone from the registry, and its pane.
  state.master = { ...state.master, agentName: MASTER, pane: 'pOld', runtime: 'codex', account: 'codex', session: 'session-ended-long-ago', startedAt: iso(clock - 10 * 3_600_000) };
  await runCycle(master, state, effects, () => clock);

  assert.deepEqual(ended, [{ session: 'orphan-4e18', reason: `no pane in Herdr's inventory runs the master agent ${MASTER} (the loop's last master pane pOld is absent); the loop launches its replacement` }],
    'the unnamed session is ended with a reason naming the absent pane, and the unknown recorded session is not asked about');
  assert.equal(launched.length, 1, 'the master launches once the slot frees');
  assert.deepEqual(registry.live(), [launched[0]], 'only the replacement holds the role\'s slot');
  assert.equal(state.actions['master:launch']?.state, 'done');
  assert.equal(state.master.pane, 'pNew');
});

test('unit:master-slot-end-failure-recorded — a failed end is a failed action retried next cycle; an unreadable Herdr ends nothing; a live master pane keeps its slot', async () => {
  const master = await config();
  {
    const registry = registryFixture();
    const { effects, launched } = effectsFor(master, registry, { agents: [], available: true });
    const state = emptyDaemonState(master);
    state.master = { ...state.master, agentName: MASTER, pane: 'pOld', session: 'orphan-4e18' };
    registry.failing('The agent registry at https://graphyard.example answered 503');
    await runCycle(master, state, effects, () => clock);
    const failed = state.actions['master:launch'];
    assert.equal(failed?.state, 'failed', 'the failed end is recorded, never swallowed');
    assert.match(failed!.detail, /Could not end the previous master registry session orphan-4e18 \(the master session's pane pOld is absent from Herdr's inventory.*answered 503/);
    assert.deepEqual(launched, [], 'no launch is attempted against a held slot');
    registry.failing(null);
    await runCycle(master, state, effects, () => clock + 60_000);
    assert.equal(state.actions['master:launch']?.state, 'done', 'the next cycle retries the end and launches');
    assert.equal(launched.length, 1);
    assert.deepEqual(registry.live(), [launched[0]]);
  }
  {
    const registry = registryFixture();
    const { effects, launched, ended } = effectsFor(master, registry, { agents: [], available: false });
    await runCycle(master, emptyDaemonState(master), effects, () => clock);
    assert.deepEqual(ended, [], 'an unreadable Herdr inventory ends nothing');
    assert.deepEqual(launched, []);
    assert.deepEqual(registry.live(), ['orphan-4e18']);
  }
  {
    const registry = registryFixture();
    const { effects, launched, ended } = effectsFor(master, registry, { agents: [{ name: MASTER, pane_id: 'pLive', agent_status: 'working' }], available: true });
    await runCycle(master, emptyDaemonState(master), effects, () => clock);
    assert.deepEqual(ended, [], 'a master session with a live pane keeps its slot');
    assert.deepEqual(launched, []);
    assert.deepEqual(registry.live(), ['orphan-4e18']);
  }
});
