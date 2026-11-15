import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { daemonStatePath, emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { masterConfigSchema, type HerdrAgent } from '../src/master.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { masterProfile } from '../src/master/master-session.js';
import { liveMasterSessions } from '../src/master/registry-slot.js';
import { httpFleetClient, selectFleetSession } from '../src/fleet.js';
import { proposedRuntimes, type AgentRegistry, type FleetSession } from '../src/model/registry.js';
import type { Principal } from '../src/model.js';

// GY-3346: after core moved between hosts (the rexera-remote episode, 2026-11-15), registry sessions
// recorded on the old host kept their role slots: the master role refused to launch ('role master is
// at its concurrency limit (1 of 1 live)') and dead worker sessions held slots until the operator ended
// them by hand. A session recorded on another host cannot run here, so the loop's close step ends it
// and the same cycle launches into the freed slot. Driven through the loop's own cycle against a
// temporary control plane on a real Postgres.

const proof = 'e2e:host-move-frees-session-slots';
const MASTER = 'graphyard-master-host-move';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, coordinator].map(principal => ({ ...principal, token: `move-${principal.id}-${'x'.repeat(32)}` }));
const token = (id: string) => credentials.find(credential => credential.id === id)!.token;

let store: Store, http: ReturnType<typeof server>, url: string;
const api = async (bearer: string, path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = await response.json() as any;
  if (!response.ok) throw Object.assign(new Error(`${path} answered ${response.status}: ${JSON.stringify(json)}`), { status: response.status });
  return json;
};
const coordinationSnapshot = async () => {
  const response = await fetch(`${url}/api/work-snapshot`, { headers: { Authorization: `Bearer ${token(coordinator.id)}`, 'X-Graphyard-View': 'coordination' } });
  assert.equal(response.status, 200);
  return response.json() as Promise<{ work: never[]; now: string }>;
};
/** The registry with its one account placed on `host`: master (one slot), worker (three) and reviewer roles. */
const placeOn = (host: string) => api(token(operator.id), 'agent-registry/apply', {
  runtimes: proposedRuntimes.filter(runtime => runtime.name === 'claude'), models: [{ name: 'default', id: null }],
  accounts: [{ name: 'claude-fixture', runtime: 'claude', model: 'default', credential: { host, home: null } }],
  roles: [{ name: 'master', accounts: ['claude-fixture'], concurrency: 1 }, { name: 'worker', accounts: ['claude-fixture'], concurrency: 3 }, { name: 'reviewer', accounts: ['claude-fixture'], concurrency: 2 }],
  reason: `account placed on ${host}`,
});
const select = (role: string, host: string, principal: string | null = null) => api(token(coordinator.id), 'agent-registry/select', { role, host, principal });

before(async () => {
  store = await withDatabase('host-move-frees-session-slots');
  await store.init();
  http = server(new Engine(store, 7200, 'owner/host-move'), credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { http?.close(); await store?.close(); });

test(`${proof} — one loop cycle on host 'new' ends the master and worker sessions recorded on 'old', launches the master into the freed slot, frees the worker slots and leaves this host's live session alone`, async () => {
  const directory = await temporaryDirectory('host-move');
  await writeFile(join(directory, 'coordinator.token'), token(coordinator.id), { mode: 0o600 });
  const config = masterConfigSchema.parse({ version: 1, url, credentialFile: join(directory, 'coordinator.token'), cliPath: '/bin/graphyard',
    repository: 'owner/host-move', baseBranch: 'main', githubAppId: 1234, hostId: 'new', masterAgentName: MASTER, workers: [] });
  const fleet = httpFleetClient({ url, credentialFile: config.credentialFile });

  // Before the move: a master and three workers run on 'old'.
  await placeOn('old');
  const old: FleetSession[] = [];
  for (const role of ['master', 'worker', 'worker', 'worker']) {
    const chosen = await select(role, 'old', role === 'master' ? MASTER : null);
    assert.equal(chosen.selected, true, chosen.reason);
    old.push(chosen.session);
  }
  // The move: the account's login now lives on 'new', where a reviewer session is running.
  await placeOn('new');
  const reviewer = await select('reviewer', 'new');
  assert.equal(reviewer.selected, true, reviewer.reason);
  const refused = await select('master', 'new', MASTER);
  assert.equal(refused.selected, false);
  assert.match(refused.reason, /^role master is at its concurrency limit \(1 of 1 live/, 'the old host\'s master holds the role\'s one slot');

  const herdr = [{ name: 'reviewer-live', pane_id: 'pane-review', agent: 'claude', agent_status: 'working' }] as HerdrAgent[];
  const ended: { id: string; reason: string }[] = [], launched: string[] = [];
  const effects: DaemonEffects = {
    snapshot: coordinationSnapshot,
    agents: () => herdr, herdr: () => ({ agents: herdr, available: true }),
    credentials: async () => ({}),
    closeSession: () => {},
    dispatch: async () => { throw new Error('no worker dispatch in this test'); },
    registry: () => fleet.document(),
    endRegistrySession: async (id, reason) => { ended.push({ id, reason }); await fleet.end(id, reason); },
    masterSession: {
      launch: async () => {
        const selected = (await selectFleetSession(config, 'master', { name: masterProfile, principal: MASTER }, { registry: fleet, quota: false, cacheMs: 0 }))!;
        launched.push(selected.account.fleet.session);
        return { agentName: MASTER, pane: 'pane-master', runtime: selected.account.kind, account: selected.account.name, session: selected.account.fleet.session };
      },
      end: (session, reason) => fleet.end(session, reason),
      live: () => liveMasterSessions(config, fleet),
    },
    persist: async () => {},
  };
  const state = emptyDaemonState(config);
  await runCycle(config, state, effects);

  const document = await fleet.document() as AgentRegistry;
  const byId = new Map(document.sessions.map(session => [session.id, session]));
  for (const session of old) {
    const after = byId.get(session.id)!;
    assert.ok(after.endedAt, `the ${session.role} session recorded on 'old' is ended`);
    assert.equal(after.endReason, 'recorded on old, this install runs on new', 'the reason names both hosts');
  }
  assert.deepEqual(ended.map(entry => entry.id).sort(), old.map(session => session.id).sort(), 'exactly the four old-host sessions are ended');
  assert.equal(launched.length, 1, 'the master role launches in the same cycle');
  assert.equal(state.master.session, launched[0]);
  const live = document.sessions.filter(session => !session.endedAt);
  assert.deepEqual(live.map(session => [session.role, session.host]).sort(), [['master', 'new'], ['reviewer', 'new']], 'only this host\'s new master and its live reviewer remain');
  assert.equal(byId.get(reviewer.session.id)!.endedAt, null, 'the session recorded on this host with a live process is untouched');
  const view = await api(token(coordinator.id), 'agent-registry?host=new');
  const worker = view.roles.find((role: { role: string }) => role.role === 'worker');
  assert.equal(worker.blocked, null, 'the worker slots are free');
  assert.equal(live.filter(session => session.role === 'worker').length, 0);

  // master status, read a few cycles later: the master slot its own current session holds is no stop.
  await writeFile(daemonStatePath(config), JSON.stringify(state));
  const root = await temporaryDirectory('host-move-status');
  execFileSync('git', ['init', '-q', root]);
  const later = new Date(Date.now() + 10 * 60_000).toISOString();
  const statusApi = async (path: string) => path === 'work-snapshot' ? { ...await coordinationSnapshot(), now: later } : api(token(coordinator.id), path);
  const run = async (command: string, args: string[]) => isHerdrCommand(command)
    ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [{ name: MASTER, pane_id: 'pane-master', agent: 'claude', agent_status: 'working' }, ...herdr] }) : 'Coordinating work.')
    : `${'b'.repeat(40)}\n`;
  const report = await masterStatusReport(root, config, statusApi, run);
  assert.equal(report.attention.filter(line => /role master cannot launch/.test(line.text)).length, 0, `master status carries no 'cannot launch' line for the master role: ${JSON.stringify(report.attention)}`);
});
