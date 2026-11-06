import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { emptyDaemonState, type DaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Principal, Work } from '../src/model.js';

// Every fixture item carries an E2E proof and declares the serve its trial needs.
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

const repository = 'owner/first-run-stuck';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const workerA: Principal = { id: 'worker-a', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, coordinator, workerA].map(principal => ({ ...principal, token: `${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;

let store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

const call = async (principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as any };
};
const ok = async (principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const result = await call(principal, method, path, body);
  assert.equal(result.status, 200, `${path}: ${JSON.stringify(result.body)}`);
  return result.body;
};

/** The item the fixture session runs, claimed so its lease is live across the whole fixture clock. */
const item = async (key: string, title: string) => {
  const filed = await ok(operator, 'POST', 'work', { title, type: 'chore', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:first-run-stuck-handling', 'e2e:fixture'] }] }) as Work;
  await ok(operator, 'POST', `work/${filed.id}/ready`, {});
  const claimed = await ok(workerA, 'POST', `work/${filed.id}/claim`, {}) as Work;
  return { filed: claimed, session: { id: `worker-a:1`, kind: 'implementation' as const, principal: workerA.id, epoch: claimed.epoch, runtime: 'claude', host: 'loop-host', pane: `pane-${key.toLowerCase()}`, agentName: `agent-${key.toLowerCase()}`, subject: `${key}: ${title}`, state: 'running' as const } };
};

before(async () => {
  store = await withDatabase('first-run-screen-stuck');
  await store.init();
  // A two-hour lease keeps every fixture lease live under the clock, which runs 30 minutes ahead.
  engine = new Engine(store, 7200, repository);
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { http?.close(); await store?.close(); });

test('unit:first-run-screen-stuck — a Claude session on any first-run screen is reported stuck with its remedy, never re-prompted; an ordinary prompt is unaffected', async () => {
  const clock = Date.now() + 30 * 60_000, iso = (at: number) => new Date(at).toISOString();
  const screens = ['Choose the text style that looks best', 'Security notes:\n 1. Claude can make mistakes', 'Use Claude Code’s terminal setup?', 'Select login method:'];
  const stuck: (Awaited<ReturnType<typeof item>> & { screen: string })[] = [];
  for (const [index, screen] of screens.entries()) stuck.push({ ...(await item(`GY-4${index}`, `First run ${index}`)), screen });
  const ordinary = { ...(await item('GY-49', 'Ordinary prompt')), screen: 'Claude Code\n> \n? for shortcuts' };
  const all = [...stuck, ordinary];
  for (const { filed, session } of all) await ok(workerA, 'POST', `work/${filed.id}/session`, session);
  const config = masterConfigSchema.parse({
    version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository, baseBranch: 'main', githubAppId: 1234, hostId: 'loop-host', masterAgentName: 'graphyard-master-first-run', workers: [],
  }) as MasterConfig;
  const herdr = all.map(({ session }) => ({ name: session.agentName, pane_id: session.pane, agent_status: 'idle' }));
  const state: DaemonState = emptyDaemonState(config);
  const prompts: string[] = [];
  const effects: DaemonEffects = {
    snapshot: async () => {
      const response = await fetch(`${url}/api/work-snapshot`, { headers: { Authorization: `Bearer ${token(coordinator)}`, 'X-Graphyard-View': 'coordination' } });
      return { work: (await response.json() as { work: Work[] }).work, now: iso(clock) };
    },
    agents: () => herdr as any, herdr: () => ({ agents: herdr as any[], available: true }),
    credentials: async () => ({}),
    dispatch: async () => { throw new Error('the fixture launches nothing'); },
    closeSession: () => {},
    recordSession: async (target, handle) => { await ok(coordinator, 'POST', `work/${target.id}/session`, handle); },
    promptSession: async (session, text) => { prompts.push(session.pane ?? ''); },
    sessionScreen: session => all.find(entry => entry.session.pane === session.pane)?.screen ?? null,
    endStall: async () => {},
    persist: async () => {},
  };
  await runCycle(config, state, effects, () => clock, undefined, () => {});
  for (const { filed } of stuck) {
    const action = state.actions[`first-run:${filed.id}:worker-a:1`];
    assert.match(action?.detail ?? '', /stuck on claude first-run setup: open the pane and finish setup, or run claude once interactively/);
  }
  assert.equal(state.actions[`first-run:${ordinary.filed.id}:worker-a:1`], undefined);
  assert.deepEqual(prompts.filter(pane => stuck.some(entry => entry.session.pane === pane)), []);
});
